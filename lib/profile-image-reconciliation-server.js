import 'server-only';

import { getDriveAuth, listFilesInFolder } from './google-drive-server';
import { ingestProfileImages } from './profile-image-ingestion';
import {
  classifyDriveImageReconciliation,
  commitDriveImageAppend,
  driveImageAssetPaths,
  reconciliationStatusCopy,
} from './profile-image-reconciliation';
import { DEFAULT_PROFILE_IMAGE_BUCKET } from './profile-images';
import { createSupabaseServiceClient } from './supabase/server';

const DATASET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;

function requireServiceClient(client) {
  const supabase = client || createSupabaseServiceClient();
  if (!supabase) throw new Error('Supabase database administration is not configured.');
  if (BUCKET !== DEFAULT_PROFILE_IMAGE_BUCKET) throw new Error(`SUPABASE_STORAGE_BUCKET must remain ${DEFAULT_PROFILE_IMAGE_BUCKET}.`);
  return supabase;
}

function assertIdentity(datasetId, profileId) {
  if (!DATASET_ID.test(String(datasetId || '')) || !String(profileId || '').trim()) {
    throw new Error('A valid dataset and profile are required.');
  }
}

async function loadContext(datasetId, profileId, client) {
  assertIdentity(datasetId, profileId);
  const supabase = requireServiceClient(client);
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,status')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  const { data: row, error: profileError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,public_data,drive_file_id,drive_folder_id,image_kind,image_cleared_by_admin')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (profileError || !row) throw new Error('Profile does not belong to the requested dataset.');
  const { data: imageRows, error: imageError } = await supabase
    .from('profile_images')
    .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode,source_type,source_drive_file_id,source_drive_folder_id,source_filename,source_modified_time,source_size')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .order('position', { ascending: true });
  if (imageError) {
    if (imageError.code === '42703' || imageError.code === 'PGRST204') {
      throw new Error('Drive reconciliation migration is required before this action can be used.');
    }
    throw new Error(`Profile image provenance could not be read: ${imageError.message}`);
  }
  return {
    supabase,
    dataset,
    profile: {
      id: row.profile_id,
      name: row.public_data?.name || row.profile_id,
      driveFileId: row.drive_file_id || '',
      driveFolderId: row.drive_folder_id || '',
      imageKind: row.image_kind || '',
      imageClearedByAdmin: row.image_cleared_by_admin === true,
      profileImages: (imageRows || []).map((image) => ({
        id: image.id,
        storagePath: image.storage_path,
        position: image.position,
        isPrimary: image.is_primary,
        focalX: image.focal_x,
        focalY: image.focal_y,
        displayMode: image.display_mode,
        sourceType: image.source_type,
        sourceDriveFileId: image.source_drive_file_id || '',
        sourceDriveFolderId: image.source_drive_folder_id || '',
        sourceFilename: image.source_filename || '',
        sourceModifiedTime: image.source_modified_time || null,
        sourceSize: Number(image.source_size || 0),
      })),
    },
  };
}

async function readDriveFolder(profile, driveAuth) {
  if (!profile.driveFolderId) return [];
  return listFilesInFolder(profile.driveFolderId, driveAuth);
}

function thumbnailUrl(datasetId, profileId, driveFileId) {
  const query = new URLSearchParams({ datasetId, profileId, driveFileId });
  return `/api/admin/datasets/images/reconcile/thumbnail?${query.toString()}`;
}

function presentPreview(context, reconciliation) {
  const copy = reconciliationStatusCopy(reconciliation);
  const presentFile = (file) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    modifiedTime: file.modifiedTime,
    thumbnailUrl: thumbnailUrl(context.dataset.id, context.profile.id, file.id),
  });
  return {
    ok: true,
    readOnly: true,
    dataset: { id: context.dataset.id, slug: context.dataset.slug, name: context.dataset.name },
    profile: { id: context.profile.id, name: context.profile.name },
    state: reconciliation.state,
    label: copy.label,
    summary: copy.summary,
    existingCount: reconciliation.existingCount,
    knownCount: reconciliation.knownCount,
    legacyCount: reconciliation.legacyCount,
    supportedCount: reconciliation.supportedCount,
    unsupportedCount: reconciliation.unsupportedCount,
    newCount: reconciliation.newCount,
    missingFromDriveCount: reconciliation.missingFromDriveCount,
    legacyImages: reconciliation.legacyImages.map((image) => ({
      id: image.id,
      position: image.position,
      isPrimary: image.isPrimary,
    })),
    knownFiles: reconciliation.knownFiles.map(presentFile),
    reviewDriveFiles: reconciliation.unlinkedDriveFiles.map(presentFile),
    newCandidates: reconciliation.newCandidates.map(presentFile),
    unsupportedFiles: reconciliation.unsupportedFiles.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    })),
    missingFromDrive: reconciliation.missingFromDrive.map(({ driveFileId, image }) => ({
      imageId: image.id,
      position: image.position,
      sourceFilename: image.sourceFilename,
      driveFileId,
    })),
    canApply: reconciliation.state === 'new_images' && reconciliation.newCandidates.length > 0,
    canReviewLegacy: reconciliation.state === 'legacy_review',
    restorationRequired: reconciliation.state === 'intentionally_cleared',
  };
}

export async function inspectProfileDriveReconciliation(datasetId, profileId, options = {}) {
  const context = options.context || await loadContext(datasetId, profileId, options.supabase);
  let driveFiles = [];
  if (context.profile.driveFolderId) {
    const driveAuth = options.driveAuth || await getDriveAuth({ strict: true, serviceAccountOnly: true });
    driveFiles = await (options.listFiles || readDriveFolder)(context.profile, driveAuth);
  }
  const reconciliation = classifyDriveImageReconciliation({ profile: context.profile, driveFiles });
  return { context, reconciliation, preview: presentPreview(context, reconciliation) };
}

export async function previewProfileDriveReconciliation(datasetId, profileId, options = {}) {
  return (await inspectProfileDriveReconciliation(datasetId, profileId, options)).preview;
}

export async function getDriveReconciliationThumbnailContext(datasetId, profileId, driveFileId, options = {}) {
  if (!DRIVE_ID.test(String(driveFileId || ''))) throw new Error('Invalid Drive file.');
  const directContext = await loadContext(datasetId, profileId, options.supabase);
  if (!directContext.profile.driveFolderId) {
    if (directContext.profile.driveFileId !== driveFileId) {
      throw new Error('Drive file does not match this profile source.');
    }
    return {
      context: directContext,
      file: { id: driveFileId, name: 'Configured Drive image' },
    };
  }
  const { context, reconciliation } = await inspectProfileDriveReconciliation(
    datasetId,
    profileId,
    { ...options, context: directContext },
  );
  const file = [...reconciliation.knownFiles, ...reconciliation.unlinkedDriveFiles]
    .find((candidate) => candidate.id === driveFileId);
  if (!file) throw new Error('Drive file is not a supported direct child of this profile folder.');
  return { context, file };
}

export async function reviewLegacyProfileImageProvenance({
  datasetId,
  profileId,
  imageId,
  driveFileId = '',
  preserveAsLegacy = false,
}, options = {}) {
  const inspected = await inspectProfileDriveReconciliation(datasetId, profileId, options);
  const legacyImage = inspected.reconciliation.legacyImages.find((image) => image.id === imageId);
  if (!legacyImage) throw new Error('Only an unreviewed legacy image can receive reviewed provenance.');
  let rpc;
  let args;
  if (preserveAsLegacy) {
    rpc = 'mark_profile_image_legacy_preserved';
    args = {
      requested_dataset_id: datasetId,
      requested_profile_id: profileId,
      requested_image_id: imageId,
    };
  } else {
    const file = inspected.reconciliation.unlinkedDriveFiles.find((candidate) => candidate.id === driveFileId);
    if (!file) throw new Error('Drive file is already linked or is not a supported direct child of this folder.');
    rpc = 'attach_profile_image_drive_provenance';
    args = {
      requested_dataset_id: datasetId,
      requested_profile_id: profileId,
      requested_image_id: imageId,
      requested_drive_file_id: file.id,
      requested_drive_folder_id: inspected.context.profile.driveFolderId,
      requested_source_filename: file.name || null,
      requested_source_modified_time: file.modifiedTime || null,
      requested_source_size: file.size || null,
    };
  }
  const { data, error } = await inspected.context.supabase.rpc(rpc, args);
  if (error) throw new Error(error.message);
  return { ok: true, result: data };
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
    async removePaths(paths) {
      if (!paths.length) return;
      const { error } = await storage.remove(paths);
      if (error) throw new Error(`Supabase Storage cleanup failed for ${paths.join(', ')}: ${error.message}`);
    },
    async remove(storagePath) {
      await this.removePaths([storagePath]);
    },
  };
}

export async function applyProfileDriveReconciliation({ datasetId, profileId, driveFileIds }, options = {}) {
  const selectedIds = [...new Set((driveFileIds || []).map(String).filter(Boolean))];
  if (!selectedIds.length || selectedIds.some((id) => !DRIVE_ID.test(id))) {
    throw new Error('Select at least one valid new Drive image.');
  }
  const inspected = await inspectProfileDriveReconciliation(datasetId, profileId, options);
  if (inspected.reconciliation.state === 'intentionally_cleared') {
    throw new Error('An intentionally cleared gallery must be restored through the explicit restoration workflow.');
  }
  if (inspected.reconciliation.legacyImages.length) {
    throw new Error('Legacy image identity review must be completed before append reconciliation.');
  }
  const availableIds = new Set(inspected.reconciliation.newCandidates.map((file) => file.id));
  if (selectedIds.some((id) => !availableIds.has(id))) {
    throw new Error('The selected Drive files changed after preview. Re-check the folder before applying.');
  }

  const driveAuth = options.driveAuth || await getDriveAuth({ strict: true, serviceAccountOnly: true });
  const storage = options.storage || storageAdapter(inspected.context.supabase);
  const ingestion = await (options.ingest || ingestProfileImages)({
    profile: inspected.context.profile,
    datasetSlug: inspected.context.dataset.slug,
    driveAuth,
    dryRun: false,
    requireAllSupported: true,
    candidateDriveFileIds: selectedIds,
    upload: storage.upload.bind(storage),
    remove: storage.remove.bind(storage),
  });
  if (!ingestion.allSupportedValidated || ingestion.images.length !== selectedIds.length) {
    await storage.removePaths(driveImageAssetPaths(ingestion.images));
    const detail = ingestion.rejected[0]?.detail || 'One or more selected Drive images failed validation.';
    throw new Error(detail);
  }

  const committed = await commitDriveImageAppend({
    images: ingestion.images,
    append: async (requestedImages) => {
      const { data, error } = await inspected.context.supabase.rpc('append_google_drive_profile_images', {
        requested_dataset_id: datasetId,
        requested_profile_id: profileId,
        requested_drive_folder_id: inspected.context.profile.driveFolderId,
        requested_images: requestedImages,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    confirm: async (images) => {
      const confirmation = await inspected.context.supabase
        .from('profile_images')
        .select('id,storage_path,profile_storage_path,discovery_storage_path,source_drive_file_id')
        .eq('dataset_id', datasetId)
        .eq('profile_id', profileId)
        .in('id', images.map((image) => image.imageId));
      if (confirmation.error) throw new Error(confirmation.error.message);
      const confirmedById = new Map((confirmation.data || []).map((row) => [String(row.id), row]));
      return images.filter((image) => {
        const row = confirmedById.get(String(image.imageId));
        return row
          && row.storage_path === image.storagePath
          && row.profile_storage_path === image.profileStoragePath
          && row.discovery_storage_path === image.discoveryStoragePath
          && row.source_drive_file_id === image.resolvedDriveFileId;
      });
    },
    cleanup: (paths) => storage.removePaths(paths),
  });
  return {
    ok: true,
    datasetSlug: inspected.context.dataset.slug,
    ...committed,
  };
}
