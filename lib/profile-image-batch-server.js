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
    .select('profile_id,public_data,drive_file_id,drive_folder_id,image_kind,storage_image_path,ordinal')
    .eq('dataset_id', dataset.id)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (profileError) throw new Error(`Dataset profiles could not be read: ${profileError.message}`);
  if ((profileRows || []).length !== Number(dataset.profile_count || 0)) {
    throw new Error(`Dataset integrity check failed: expected ${dataset.profile_count} profiles, received ${(profileRows || []).length}.`);
  }

  const { data: imageRows, error: imageError } = await supabase
    .from('profile_images')
    .select('id,profile_id,storage_path,position,is_primary')
    .eq('dataset_id', dataset.id)
    .order('position', { ascending: true })
    .limit(10000);
  if (imageError) throw new Error(`Relational profile images could not be read: ${imageError.message}`);
  const imagesByProfile = new Map();
  for (const image of imageRows || []) {
    const images = imagesByProfile.get(image.profile_id) || [];
    images.push({
      id: image.id,
      storagePath: image.storage_path,
      position: image.position,
      isPrimary: image.is_primary,
    });
    imagesByProfile.set(image.profile_id, images);
  }

  return {
    supabase,
    dataset,
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
    position,
  }));
  const { data, error } = await supabase.rpc('create_profile_image_gallery_if_empty', {
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
    .select('id,storage_path,position,is_primary')
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
