import 'server-only';

import { getDriveAuth } from './google-drive-server';
import {
  inspectProfileImageHealth,
  safeProfileImageHealth,
  summarizeProfileImageHealth,
} from './profile-image-health';
import { ingestProfileImages } from './profile-image-ingestion';
import { migrateDatasetProfileGalleries } from './profile-image-migration';
import {
  assertImageImportDataset,
  imageImportStatus,
  presentImageImportResult,
} from './profile-image-batch';
import { DEFAULT_PROFILE_IMAGE_BUCKET } from './profile-images';
import { createSupabaseServiceClient } from './supabase/server';

const DATASET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;

function requireServiceClient() {
  const client = createSupabaseServiceClient();
  if (!client) throw new Error('Supabase database administration is not configured.');
  if (BUCKET !== DEFAULT_PROFILE_IMAGE_BUCKET) {
    throw new Error(`SUPABASE_STORAGE_BUCKET must remain ${DEFAULT_PROFILE_IMAGE_BUCKET}.`);
  }
  return client;
}

function profileFromRow(row, profileImages) {
  return {
    ...(row.public_data || {}),
    id: row.profile_id,
    name: row.public_data?.name || row.profile_id,
    driveFileId: row.drive_file_id || '',
    driveFolderId: row.drive_folder_id || '',
    imageKind: row.image_kind || row.public_data?.imageKind || '',
    storageImagePath: row.storage_image_path || row.public_data?.storageImagePath || '',
    imageClearedByAdmin: row.image_cleared_by_admin === true,
    profileImages,
  };
}

export async function loadImageImportContext(
  datasetId,
  supabase = requireServiceClient(),
  { requireImportable = true } = {},
) {
  if (!DATASET_ID.test(String(datasetId || ''))) throw new Error('Invalid dataset.');
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,status,profile_count')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  if (requireImportable) assertImageImportDataset(dataset);

  const { data: profileRows, error: profileError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,public_data,drive_file_id,drive_folder_id,image_kind,storage_image_path,image_cleared_by_admin,ordinal')
    .eq('dataset_id', dataset.id)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (profileError) throw new Error(`Dataset profiles could not be read: ${profileError.message}`);
  if ((profileRows || []).length !== Number(dataset.profile_count || 0)) {
    throw new Error(`Dataset integrity check failed: expected ${dataset.profile_count} profiles, received ${(profileRows || []).length}.`);
  }

  let provenanceAvailable = true;
  let { data: imageRows, error: imageError } = await supabase
    .from('profile_images')
    .select('id,profile_id,storage_path,profile_storage_path,profile_width,profile_height,profile_mime_type,profile_byte_length,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,source_type,source_drive_file_id,source_drive_folder_id,source_filename,source_modified_time,source_size')
    .eq('dataset_id', dataset.id)
    .order('position', { ascending: true })
    .limit(10000);
  if (imageError) {
    provenanceAvailable = false;
    const compatibility = await supabase
      .from('profile_images')
      .select('id,profile_id,storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary')
      .eq('dataset_id', dataset.id)
      .order('position', { ascending: true })
      .limit(10000);
    imageRows = compatibility.data;
    imageError = compatibility.error;
  }
  if (imageError) throw new Error(`Relational profile images could not be read: ${imageError.message}`);
  const imagesByProfile = new Map();
  for (const image of imageRows || []) {
    const images = imagesByProfile.get(image.profile_id) || [];
    images.push({
      id: image.id,
      storagePath: image.storage_path,
      profileStoragePath: image.profile_storage_path || '',
      discoveryStoragePath: image.discovery_storage_path || '',
      position: image.position,
      isPrimary: image.is_primary,
      sourceType: image.source_type || 'legacy_unknown',
      sourceDriveFileId: image.source_drive_file_id || '',
      sourceDriveFolderId: image.source_drive_folder_id || '',
      sourceFilename: image.source_filename || '',
      sourceModifiedTime: image.source_modified_time || null,
      sourceSize: Number(image.source_size || 0),
    });
    imagesByProfile.set(image.profile_id, images);
  }

  return {
    supabase,
    dataset,
    provenanceAvailable,
    profiles: (profileRows || []).map((row) => (
      profileFromRow(row, imagesByProfile.get(row.profile_id) || [])
    )),
  };
}

export async function getMissingProfileImageStatus(datasetId) {
  const { dataset, profiles } = await loadImageImportContext(datasetId);
  return { ok: true, ...imageImportStatus(dataset, profiles) };
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    worker,
  ));
  return results;
}

async function readOnlyHealthContext(datasetId) {
  const context = await loadImageImportContext(datasetId, undefined, { requireImportable: false });
  let driveAuth = null;
  let driveAuthError = null;
  try {
    driveAuth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
  } catch (error) {
    driveAuthError = error;
  }
  return { ...context, driveAuth, driveAuthError };
}

async function inspectContextProfile(profile, context) {
  const health = await inspectProfileImageHealth({
    profile,
    datasetSlug: context.dataset.slug,
    driveAuth: context.driveAuth,
    driveAuthError: context.driveAuthError,
  });
  return safeProfileImageHealth(profile, health);
}

export async function getDatasetImageSourceHealth(datasetId) {
  const context = await readOnlyHealthContext(datasetId);
  const profiles = await mapWithConcurrency(
    context.profiles,
    3,
    (profile) => inspectContextProfile(profile, context),
  );
  return {
    ok: true,
    dataset: {
      id: context.dataset.id,
      slug: context.dataset.slug,
      name: context.dataset.name,
      status: context.dataset.status,
    },
    summary: summarizeProfileImageHealth(profiles),
    profiles,
    issues: profiles.filter((profile) => profile.health.state !== 'ready'),
    readOnly: true,
  };
}

export async function getProfileImageSourceHealth(datasetId, profileId) {
  const context = await readOnlyHealthContext(datasetId);
  const profile = context.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Profile does not belong to the requested dataset.');
  return {
    ok: true,
    profile: await inspectContextProfile(profile, context),
    readOnly: true,
  };
}

function storageAdapter(supabase) {
  const storage = supabase.storage.from(BUCKET);
  return {
    async upload({ storagePath, bytes, contentType }) {
      const { error } = await storage.upload(storagePath, bytes, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
      if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
    },
    async remove(storagePath) {
      const { error } = await storage.remove([storagePath]);
      if (error) throw new Error(`Supabase Storage cleanup failed: ${error.message}`);
    },
  };
}

function explicitRestorationThumbnailUrl(datasetId, profileId, driveFileId) {
  const query = new URLSearchParams({ datasetId, profileId, driveFileId });
  return `/api/admin/datasets/images/reconcile/thumbnail?${query.toString()}`;
}

function assertExplicitRestorationProfile(profile) {
  if (!profile) throw new Error('Profile does not belong to the requested dataset.');
  if (profile.imageClearedByAdmin !== true) {
    throw new Error('Explicit source restoration is only available for an intentionally cleared profile.');
  }
  if (profile.profileImages.length > 0 || profile.storageImagePath) {
    throw new Error('The profile already has an image gallery; use the normal image controls instead.');
  }
}

function selectedRestorationDriveIds(profile, driveFileIds, { requireSelection }) {
  const requested = [...new Set((driveFileIds || []).map(String).filter(Boolean))];
  if (profile.driveFolderId) {
    if (requireSelection && !requested.length) throw new Error('Select at least one Drive image to restore.');
    return requested.length ? requested : null;
  }
  if (!profile.driveFileId) throw new Error('This profile does not have a restorable Drive image source.');
  if (requested.length && (requested.length !== 1 || requested[0] !== profile.driveFileId)) {
    throw new Error('The selected Drive file does not match the profile source.');
  }
  return null;
}

async function replaceProfileGallery(supabase, datasetId, profile, plan) {
  const { data, error } = await supabase.rpc('replace_profile_image_gallery_with_profile_derivatives', {
    requested_dataset_id: datasetId,
    requested_profile_id: profile.id,
    expected_existing_image_ids: plan.expectedExistingImageIds,
    replacement_images: plan.replacementRows,
  });
  if (!error && Number(data?.replacementCount || 0) === plan.replacementRows.length) return data;

  const confirmation = await supabase
    .from('profile_images')
    .select('id,storage_path,profile_storage_path,discovery_storage_path,position,is_primary,source_type,source_drive_file_id')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profile.id)
    .order('position', { ascending: true });
  if (confirmation.error) {
    const uncertain = new Error(`The restoration result could not be confirmed after an RPC problem: ${error?.message || 'unexpected response'}`);
    uncertain.preserveStagedObjects = true;
    throw uncertain;
  }
  const confirmedRows = confirmation.data || [];
  const replacementConfirmed = confirmedRows.length === plan.replacementRows.length
    && confirmedRows.every((row, index) => {
      const expected = plan.replacementRows[index];
      return row.id === expected.imageId
        && row.storage_path === expected.storagePath
        && row.profile_storage_path === expected.profileStoragePath
        && row.discovery_storage_path === expected.discoveryStoragePath
        && row.position === expected.position
        && row.is_primary === expected.isPrimary
        && row.source_type === 'google_drive'
        && row.source_drive_file_id === expected.driveFileId;
    });
  if (replacementConfirmed) {
    return { replacementCount: confirmedRows.length, confirmedAfterRpcProblem: true };
  }
  throw new Error(`Transactional profile gallery restoration failed: ${error?.message || 'the RPC did not confirm the requested gallery'}`);
}

async function runExplicitProfileImageRestoration(
  datasetId,
  profileId,
  { dryRun, driveFileIds = [] },
) {
  const context = await loadImageImportContext(datasetId);
  const profile = context.profiles.find((candidate) => candidate.id === profileId);
  assertExplicitRestorationProfile(profile);
  const candidateDriveFileIds = selectedRestorationDriveIds(
    profile,
    driveFileIds,
    { requireSelection: !dryRun },
  );
  const driveAuth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
  const storage = storageAdapter(context.supabase);
  const migration = await migrateDatasetProfileGalleries({
    dataset: context.dataset,
    profiles: [profile],
    dryRun,
    replaceExisting: true,
    ingestGallery: (sourceProfile) => ingestProfileImages({
      profile: sourceProfile,
      datasetSlug: context.dataset.slug,
      driveAuth,
      dryRun,
      requireAllSupported: true,
      candidateDriveFileIds,
      upload: storage.upload,
      remove: storage.remove,
    }),
    replaceGallery: dryRun
      ? undefined
      : ({ profile: sourceProfile, plan }) => replaceProfileGallery(
        context.supabase,
        context.dataset.id,
        sourceProfile,
        plan,
      ),
    removeStorage: storage.remove,
  });
  const row = migration.rows[0];
  const successful = dryRun
    ? row?.status === 'dry_run_replacement_validated'
    : ['replaced', 'replaced_with_cleanup_warnings'].includes(row?.status);
  if (!successful) throw new Error(row?.detail || 'The selected source image could not be restored safely.');

  return {
    ok: true,
    mode: dryRun ? 'preview' : 'apply',
    dataset: { id: context.dataset.id, slug: context.dataset.slug, name: context.dataset.name },
    profile: {
      id: profile.id,
      name: profile.name,
      wasIntentionallyCleared: true,
      sourceKind: profile.driveFolderId ? 'folder' : 'file',
    },
    candidates: (row.imageDimensions || []).map((image) => ({
      driveFileId: image.driveFileId,
      name: image.name || (profile.driveFolderId ? 'Drive image' : 'Configured Drive image'),
      width: image.width,
      height: image.height,
      byteLength: image.byteLength,
      profileWidth: image.profileWidth,
      profileHeight: image.profileHeight,
      discoveryWidth: image.discoveryWidth,
      discoveryHeight: image.discoveryHeight,
      thumbnailUrl: explicitRestorationThumbnailUrl(datasetId, profileId, image.driveFileId),
    })),
    restored: !dryRun,
    imageCount: dryRun ? row.imageDimensions.length : row.uploaded,
    primaryStoragePath: row.primaryStoragePath,
    imageClearedByAdmin: dryRun ? true : false,
    cleanupWarnings: (row.diagnostics || []).filter((item) => item.category?.includes('cleanup')),
  };
}

export function previewExplicitProfileImageRestoration(datasetId, profileId) {
  return runExplicitProfileImageRestoration(datasetId, profileId, { dryRun: true });
}

export function applyExplicitProfileImageRestoration(datasetId, profileId, driveFileIds) {
  return runExplicitProfileImageRestoration(datasetId, profileId, {
    dryRun: false,
    driveFileIds,
  });
}

async function hasGallery(supabase, datasetId, profileId) {
  const { count, error } = await supabase
    .from('profile_images')
    .select('id', { count: 'exact', head: true })
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId);
  if (error) throw new Error(`The current gallery state could not be checked: ${error.message}`);
  return Number(count || 0) > 0;
}

async function createGalleryIfEmpty(supabase, datasetId, profile, images) {
  const requestedImages = images.map((image, position) => ({
    imageId: image.imageId,
    storagePath: image.storagePath,
    profileStoragePath: image.profileStoragePath,
    profileWidth: image.profileWidth,
    profileHeight: image.profileHeight,
    profileMimeType: image.profileMimeType,
    profileByteLength: image.profileByteLength,
    discoveryStoragePath: image.discoveryStoragePath,
    discoveryWidth: image.discoveryWidth,
    discoveryHeight: image.discoveryHeight,
    discoveryMimeType: image.discoveryMimeType,
    discoveryByteLength: image.discoveryByteLength,
    driveFileId: image.resolvedDriveFileId,
    driveFolderId: profile.driveFolderId || null,
    sourceFilename: image.name || null,
    sourceModifiedTime: image.sourceModifiedTime || null,
    sourceSize: image.sourceSize || null,
    position,
  }));
  const { data, error } = await supabase.rpc('create_profile_image_gallery_with_profile_derivatives_if_empty', {
    requested_dataset_id: datasetId,
    requested_profile_id: profile.id,
    requested_images: requestedImages,
  });
  if (!error && data?.created === true && Number(data?.imageCount || 0) === requestedImages.length) {
    return data;
  }
  if (!error && data?.created === false) return data;

  const confirmation = await supabase
    .from('profile_images')
    .select('id,storage_path,profile_storage_path,discovery_storage_path,position,is_primary,source_type,source_drive_file_id')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profile.id)
    .order('position', { ascending: true });
  if (confirmation.error) {
    const uncertain = new Error(`Gallery creation could not be confirmed after an RPC problem: ${error?.message || 'unexpected response'}`);
    uncertain.preserveStagedObjects = true;
    throw uncertain;
  }
  const rows = confirmation.data || [];
  const createdByThisRequest = rows.length === requestedImages.length
    && rows.every((row, index) => (
      row.id === requestedImages[index].imageId
      && row.storage_path === requestedImages[index].storagePath
      && row.profile_storage_path === requestedImages[index].profileStoragePath
      && row.discovery_storage_path === requestedImages[index].discoveryStoragePath
      && row.source_type === 'google_drive'
      && row.source_drive_file_id === requestedImages[index].driveFileId
      && row.position === index
      && row.is_primary === (index === 0)
    ));
  if (createdByThisRequest) return { created: true, imageCount: rows.length, confirmedAfterRpcProblem: true };
  if (rows.length) return { created: false, reason: 'gallery_exists' };
  throw new Error(`Atomic gallery creation failed: ${error?.message || 'the requested gallery was not created'}`);
}

async function runMissingProfileImageImport(datasetId, dryRun) {
  const { supabase, dataset, profiles } = await loadImageImportContext(datasetId);
  const driveAuth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
  const storage = storageAdapter(supabase);
  const migration = await migrateDatasetProfileGalleries({
    dataset,
    profiles,
    dryRun,
    ingestGallery: (profile) => ingestProfileImages({
      profile,
      datasetSlug: dataset.slug,
      driveAuth,
      dryRun,
      upload: storage.upload,
      remove: storage.remove,
    }),
    createGallery: dryRun
      ? undefined
      : ({ profile, images }) => createGalleryIfEmpty(supabase, dataset.id, profile, images),
    recheckGallery: dryRun
      ? undefined
      : (profile) => hasGallery(supabase, dataset.id, profile.id),
    removeStorage: storage.remove,
  });
  return presentImageImportResult(dataset, migration, { dryRun });
}

export function previewMissingProfileImages(datasetId) {
  return runMissingProfileImageImport(datasetId, true);
}

export function applyMissingProfileImages(datasetId) {
  return runMissingProfileImageImport(datasetId, false);
}
