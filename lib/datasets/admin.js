import 'server-only';

import { createHash } from 'node:crypto';
import { createSupabaseServiceClient } from '../supabase/server';
import { resolveProfileImage } from '../profile-images-server';
import { normalizeDatasetRecord } from './model';
import { removeDatasetWithStorage } from './removal';
import { buildDatasetImportTargetFields, buildDatasetSyncDiff, preserveMissingSourceProfiles } from './sync';
import { resolveEffectivePublicProfile, publicOverrideFields } from '../profile-overrides';
import { scoreVibeEvidence } from '../import/profile-normalization';
import { normalizeMajorGroup, resolveMajorGroup } from '../import/major-group';

function requireServiceClient() {
  const client = createSupabaseServiceClient();
  if (!client) throw new Error('Supabase database administration is not configured.');
  return client;
}

export async function cleanupExpiredDatasetImports(client) {
  const supabase = client || requireServiceClient();
  const { data, error } = await supabase.rpc('cleanup_expired_dataset_imports');
  if (error) throw new Error(`Unable to clean expired import previews: ${error.message}`);
  return Number(data) || 0;
}

export async function listAdminDatasets() {
  const supabase = requireServiceClient();
  await cleanupExpiredDatasetImports(supabase);
  const { data, error } = await supabase
    .from('datasets')
    .select('id,slug,name,term,year,status,profile_count,health,safe_issues,created_at,imported_at,activated_at,deletion_pending,source_type,google_sheet_tab,google_sheet_title,last_source_sync_at')
    .order('year', { ascending: false })
    .order('term', { ascending: false });
  if (error) throw new Error(`Unable to load datasets: ${error.message}`);
  const datasets = await Promise.all(data.map(async (dataset) => {
    const { data: visibilityRows, error: visibilityError } = await supabase
      .from('dataset_profiles')
      .select('public_hidden')
      .eq('dataset_id', dataset.id);
    if (visibilityError) throw new Error(`Unable to load profile visibility: ${visibilityError.message}`);
    const hiddenProfileCount = (visibilityRows || []).filter((row) => row.public_hidden === true).length;
    return {
      ...normalizeDatasetRecord(dataset),
      health: dataset.health,
      safeIssues: dataset.safe_issues || {},
      deletionPending: dataset.deletion_pending === true,
      totalRecordCount: (visibilityRows || []).length,
      publicProfileCount: (visibilityRows || []).length - hiddenProfileCount,
      hiddenProfileCount,
    };
  }));
  return datasets;
}

export async function createDatasetImport({
  metadata,
  payload,
  userId,
  target = null,
  source = { type: 'excel' },
  diff = null,
}) {
  const supabase = requireServiceClient();
  await cleanupExpiredDatasetImports(supabase);
  const targetFields = buildDatasetImportTargetFields(target);
  const { data, error } = await supabase
    .from('dataset_imports')
    .insert({
      slug: metadata.slug,
      name: metadata.name,
      term: metadata.term,
      year: metadata.year,
      profile_count: payload.health.totalProfiles,
      normalized_profiles: payload.profiles,
      health: payload.health,
      safe_issues: payload.safeIssues,
      created_by: userId,
      ...targetFields,
      source_type: source.type || 'excel',
      google_sheet_id: source.sheetId || null,
      google_sheet_tab: source.tab || null,
      google_sheet_title: source.title || null,
      source_hash: source.hash || null,
      sync_diff: diff || {},
      removed_profile_ids: (diff?.removed || []).map((profile) => profile.id),
    })
    .select('id,expires_at')
    .single();
  if (error) throw new Error(`Unable to store import preview: ${error.message}`);
  return data;
}

export async function getAdminDatasetSyncTarget(datasetId) {
  const supabase = requireServiceClient();
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,term,year,status,profile_count,health,safe_issues,imported_at,source_type,google_sheet_id,google_sheet_tab,google_sheet_title,last_source_sync_at,last_source_hash')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  const { data: profiles, error: profilesError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,ordinal,public_data,drive_file_id,drive_folder_id,image_kind,image_issue,storage_image_path')
    .eq('dataset_id', datasetId)
    .order('ordinal', { ascending: true });
  if (profilesError) throw new Error(`Unable to load the dataset snapshot: ${profilesError.message}`);
  return {
    dataset: {
      ...normalizeDatasetRecord(dataset),
      health: dataset.health || {},
      safeIssues: dataset.safe_issues || {},
    },
    profiles: profiles || [],
  };
}

export async function prepareDatasetSync({ datasetId, payload, sourceHash = '' }) {
  const target = await getAdminDatasetSyncTarget(datasetId);
  const diff = buildDatasetSyncDiff(target.profiles, payload.profiles);
  const mergedPayload = preserveMissingSourceProfiles(
    payload,
    target.profiles,
    diff,
    target.dataset.safeIssues,
  );
  const previewHash = createHash('sha256').update(JSON.stringify({
    datasetId,
    importedAt: target.dataset.importedAt,
    sourceHash,
    diff,
  })).digest('hex');
  return { diff, payload: mergedPayload, metadata: target.dataset, previewHash };
}

export async function createDatasetSyncImport({ datasetId, payload, userId, source, prepared = null }) {
  const result = prepared || await prepareDatasetSync({ datasetId, payload, sourceHash: source.hash });
  const draft = await createDatasetImport({
    metadata: result.metadata,
    payload: result.payload,
    userId,
    target: {
      datasetId,
      importedAt: result.metadata.importedAt,
    },
    source,
    diff: result.diff,
  });
  return {
    draft,
    diff: result.diff,
    health: result.payload.health,
    safeIssues: result.payload.safeIssues,
    metadata: result.metadata,
    previewHash: result.previewHash,
  };
}

export async function saveDatasetImport(importId, userId) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('save_dataset_import', {
    import_id: importId,
    actor_id: userId,
  });
  if (error) throw new Error(`Unable to save dataset: ${error.message}`);
  return data;
}

export async function applyDatasetSyncImport(importId, datasetId, userId, acknowledgeRemoved) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('apply_dataset_sync', {
    import_id: importId,
    target_id: datasetId,
    actor_id: userId,
    acknowledge_removed: acknowledgeRemoved === true,
  });
  if (error) throw new Error(`Unable to apply dataset update: ${error.message}`);
  return data;
}

export async function activateDataset(datasetId) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('activate_dataset', { dataset_id_to_activate: datasetId });
  if (error) throw new Error(`Unable to activate dataset: ${error.message}`);
  return data;
}

export async function setDatasetArchived(datasetId, archived) {
  const supabase = requireServiceClient();
  const { error } = await supabase.rpc('set_dataset_status', {
    dataset_id_to_update: datasetId,
    requested_status: archived ? 'archived' : 'ready',
  });
  if (error) throw new Error(`Unable to update dataset: ${error.message}`);
}

export async function updateDatasetName(datasetId, name) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('update_dataset_name', {
    dataset_id_to_update: datasetId,
    requested_name: name,
  });
  if (error) throw new Error(`Unable to update dataset name: ${error.message}`);
  return data;
}

export async function removeAdminDataset(datasetId) {
  return removeDatasetWithStorage({
    supabase: requireServiceClient(),
    datasetId,
  });
}

export async function getAdminDatasetProfile(datasetId, profileId) {
  const supabase = requireServiceClient();
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,term,year,status,profile_count,created_at,imported_at,activated_at')
    .eq('id', datasetId)
    .single();
  if (datasetError) return null;

  const { data: row, error: profileError } = await supabase
    .from('dataset_profiles')
    .select('public_data,public_overrides,public_overrides_updated_at,public_overrides_updated_by,drive_file_id,drive_folder_id,image_kind,image_issue,storage_image_path,image_cleared_by_admin,public_hidden')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (profileError || !row?.public_data) return null;

  let { data: imageRows, error: imageError } = await supabase
    .from('profile_images')
    .select('id,storage_path,profile_storage_path,profile_width,profile_height,profile_mime_type,profile_byte_length,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,focal_x,focal_y,display_mode')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .order('position', { ascending: true });
  if (imageError) {
    const fallback = await supabase
      .from('profile_images')
      .select('id,storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,focal_x,focal_y,display_mode')
      .eq('dataset_id', datasetId)
      .eq('profile_id', profileId)
      .order('position', { ascending: true });
    imageRows = fallback.data;
    if (fallback.error) {
      const compatibilityFallback = await supabase
        .from('profile_images')
        .select('id,storage_path,position,is_primary')
        .eq('dataset_id', datasetId)
        .eq('profile_id', profileId)
        .order('position', { ascending: true });
      imageRows = compatibilityFallback.data;
    }
  }

  const profileImages = (imageRows || []).map((image) => ({
    id: image.id,
    storageImagePath: image.storage_path,
    profileStorageImagePath: image.profile_storage_path || '',
    discoveryStorageImagePath: image.discovery_storage_path || '',
    position: image.position,
    isPrimary: image.is_primary,
    focalX: image.focal_x,
    focalY: image.focal_y,
    displayMode: image.display_mode,
  }));
  const importedPublicData = row.public_data || {};
  const publicOverrides = row.public_overrides || {};
  const imageClearedByAdmin = row.image_cleared_by_admin === true;
  const effectivePublicData = {
    ...resolveEffectivePublicProfile(importedPublicData, publicOverrides),
    driveFileId: row.drive_file_id || importedPublicData.driveFileId || '',
    driveFolderId: row.drive_folder_id || importedPublicData.driveFolderId || '',
    imageKind: row.image_kind || importedPublicData.imageKind || '',
    imageIssue: row.image_issue || importedPublicData.imageIssue || '',
    storageImagePath: row.storage_image_path || importedPublicData.storageImagePath || '',
    imageClearedByAdmin,
  };
  // Apply editable text overrides first, then let the relational gallery be
  // the final authority for image sources and presentation metadata.
  const resolvedProfile = resolveProfileImage({ ...effectivePublicData, profileImages });
  return {
    dataset: normalizeDatasetRecord(dataset),
    profile: resolvedProfile,
    importedPublicData,
    publicOverrides,
    publicOverridesUpdatedAt: row.public_overrides_updated_at || null,
    publicOverrideFields: publicOverrideFields(publicOverrides),
    publicHidden: row.public_hidden === true,
    vibeReasoning: scoreVibeEvidence(importedPublicData),
  };
}

export async function setAdminProfilePublicVisibility({ datasetId, profileId, hidden }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('set_profile_public_visibility', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_hidden: hidden === true,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function updateAdminPublicProfile({
  datasetId, profileId, overrides, expectedUpdatedAt = null, actorId,
}) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('update_profile_public_overrides', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_overrides: overrides,
    expected_updated_at: expectedUpdatedAt,
    actor_id: actorId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function updateAdminProfileImageFocal({ datasetId, profileId, imageId, focalX, focalY, displayMode }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase
    .from('profile_images')
    .update({ focal_x: focalX, focal_y: focalY, display_mode: displayMode })
    .eq('id', imageId)
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode')
    .single();
  if (error || !data) throw new Error(error?.message || 'The primary profile image was not found.');
  return {
    id: data.id,
    storageImagePath: data.storage_path,
    position: data.position,
    isPrimary: data.is_primary,
    focalX: data.focal_x,
    focalY: data.focal_y,
    displayMode: data.display_mode,
  };
}

export async function getAdminImageContext(datasetId, profileId) {
  const supabase = requireServiceClient();
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  const { data: profile, error: profileError } = await supabase
    .from('dataset_profiles')
    .select('profile_id')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (profileError || !profile) throw new Error('Profile does not belong to the requested dataset.');
  return { dataset, profile };
}

export async function getAdminProfileImage({ datasetId, profileId, imageId }) {
  const supabase = requireServiceClient();
  let { data, error } = await supabase
    .from('profile_images')
    .select('id,storage_path,profile_storage_path,profile_width,profile_height,profile_mime_type,profile_byte_length,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,focal_x,focal_y,display_mode')
    .eq('id', imageId)
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (error) {
    const fallback = await supabase
      .from('profile_images')
      .select('id,storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,focal_x,focal_y,display_mode')
      .eq('id', imageId)
      .eq('dataset_id', datasetId)
      .eq('profile_id', profileId)
      .single();
    data = fallback.data;
    error = fallback.error;
  }
  if (error || !data) throw new Error('Profile image was not found.');
  return {
    id: data.id,
    storagePath: data.storage_path,
    profileStoragePath: data.profile_storage_path || '',
    discoveryStoragePath: data.discovery_storage_path || '',
    position: data.position,
    isPrimary: data.is_primary,
    focalX: data.focal_x,
    focalY: data.focal_y,
    displayMode: data.display_mode,
  };
}

export async function createAdminProfileImage({
  datasetId,
  profileId,
  imageId,
  storagePath,
  profileStoragePath,
  profileWidth,
  profileHeight,
  profileMimeType,
  profileByteLength,
  discoveryStoragePath,
  discoveryWidth,
  discoveryHeight,
  discoveryMimeType,
  discoveryByteLength,
  makePrimary = false,
}) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('create_profile_image_with_derivative', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
    requested_storage_path: storagePath,
    requested_profile_storage_path: profileStoragePath,
    requested_profile_width: profileWidth,
    requested_profile_height: profileHeight,
    requested_profile_mime_type: profileMimeType,
    requested_profile_byte_length: profileByteLength,
    requested_discovery_storage_path: discoveryStoragePath,
    requested_discovery_width: discoveryWidth,
    requested_discovery_height: discoveryHeight,
    requested_discovery_mime_type: discoveryMimeType,
    requested_discovery_byte_length: discoveryByteLength,
    requested_make_primary: makePrimary,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function setAdminProfileImagePrimary({ datasetId, profileId, imageId }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('set_profile_image_primary', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function reorderAdminProfileImages({ datasetId, profileId, imageIds }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('reorder_profile_images', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_ids: imageIds,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteAdminProfileImage({ datasetId, profileId, imageId }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('delete_profile_image', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function replaceAdminProfileImageStoragePath({
  datasetId,
  profileId,
  imageId,
  storagePath,
  profileStoragePath,
  profileWidth,
  profileHeight,
  profileMimeType,
  profileByteLength,
  discoveryStoragePath,
  discoveryWidth,
  discoveryHeight,
  discoveryMimeType,
  discoveryByteLength,
}) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('replace_profile_image_assets', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
    requested_storage_path: storagePath,
    requested_profile_storage_path: profileStoragePath,
    requested_profile_width: profileWidth,
    requested_profile_height: profileHeight,
    requested_profile_mime_type: profileMimeType,
    requested_profile_byte_length: profileByteLength,
    requested_discovery_storage_path: discoveryStoragePath,
    requested_discovery_width: discoveryWidth,
    requested_discovery_height: discoveryHeight,
    requested_discovery_mime_type: discoveryMimeType,
    requested_discovery_byte_length: discoveryByteLength,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function getAdminDatasetProfileList(datasetId) {
  const supabase = requireServiceClient();
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,term,year,status,profile_count,created_at,imported_at,activated_at')
    .eq('id', datasetId)
    .single();
  if (datasetError) return null;

  const { data: rows, error: profilesError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,public_data,public_overrides,ordinal')
    .eq('dataset_id', datasetId)
    .order('ordinal', { ascending: true });
  if (profilesError) return null;
  return {
    dataset: normalizeDatasetRecord(dataset),
    profiles: rows.map((row) => {
      const autoMajorGroup = normalizeMajorGroup(row.public_data?.major);
      const effectiveMajorGroup = resolveMajorGroup(row.public_data?.major, row.public_overrides?.majorGroup);
      return {
        id: row.profile_id,
        name: row.public_data?.name || row.profile_id,
        role: row.public_data?.role || '',
        major: row.public_data?.major || '',
        year: row.public_data?.year || '',
        autoMajorGroup,
        effectiveMajorGroup,
        hasMajorGroupOverride: typeof row.public_overrides?.majorGroup === 'string',
      };
    }),
  };
}
