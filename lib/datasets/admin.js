import 'server-only';

import { createSupabaseServiceClient } from '../supabase/server';
import {
  DEFAULT_PROFILE_IMAGE_BUCKET,
  isValidStorageImagePath,
  resolveProfileImageSourcesForImage,
} from '../profile-images';
import { resolveProfileImage } from '../profile-images-server';
import { getSupabasePublicConfig } from '../supabase/config';
import { normalizeDatasetRecord } from './model';
import { removeDatasetWithStorage } from './removal';

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
    .select('id,slug,name,term,year,status,profile_count,health,safe_issues,created_at,imported_at,activated_at,deletion_pending')
    .order('year', { ascending: false })
    .order('term', { ascending: false });
  if (error) throw new Error(`Unable to load datasets: ${error.message}`);
  return data.map((dataset) => ({
    ...normalizeDatasetRecord(dataset),
    health: dataset.health,
    safeIssues: dataset.safe_issues || {},
    deletionPending: dataset.deletion_pending === true,
  }));
}

export async function createDatasetImport({ metadata, payload, userId }) {
  const supabase = requireServiceClient();
  await cleanupExpiredDatasetImports(supabase);
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
    })
    .select('id,expires_at')
    .single();
  if (error) throw new Error(`Unable to store import preview: ${error.message}`);
  return data;
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
    .select('public_data,storage_image_path')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (profileError || !row?.public_data) return null;

  let { data: imageRows, error: imageError } = await supabase
    .from('profile_images')
    .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .order('position', { ascending: true });
  if (imageError) {
    const fallback = await supabase
      .from('profile_images')
      .select('id,storage_path,position,is_primary,focal_x,focal_y')
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

  // Older datasets may still have only the compatibility column. Materialize
  // that canonical primary object into the relational metadata table so the
  // existing UUID-validated focal endpoint can edit it safely.
  if ((!imageRows || imageRows.length === 0)) {
    const legacyPath = String(row.storage_image_path || row.public_data?.storageImagePath || '');
    if (isValidStorageImagePath(legacyPath)) {
      const { data: insertedImage } = await supabase
        .from('profile_images')
        .insert({
          dataset_id: datasetId,
          profile_id: profileId,
          storage_path: legacyPath,
          position: 0,
          is_primary: true,
        })
        .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode')
        .single();
      if (insertedImage) {
        imageRows = [insertedImage];
      } else {
        // A concurrent preview may have created the row, or PostgREST may
        // omit the inserted representation. Re-read the scoped row so the
        // UUID is always present in the props sent to the client.
        let { data: existingImage } = await supabase
          .from('profile_images')
          .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode')
          .eq('dataset_id', datasetId)
          .eq('profile_id', profileId)
          .eq('storage_path', legacyPath)
          .maybeSingle();
        if (!existingImage) {
          const compatibilityLookup = await supabase
            .from('profile_images')
            .select('id,storage_path,position,is_primary')
            .eq('dataset_id', datasetId)
            .eq('profile_id', profileId)
            .eq('storage_path', legacyPath)
            .maybeSingle();
          existingImage = compatibilityLookup.data;
        }
        if (existingImage) imageRows = [existingImage];
      }
    }
  }
  const profileImages = (imageRows || []).map((image) => ({
    id: image.id,
    storageImagePath: image.storage_path,
    position: image.position,
    isPrimary: image.is_primary,
    focalX: image.focal_x,
    focalY: image.focal_y,
    displayMode: image.display_mode,
  }));
  const profileImagesWithSources = profileImages.map((image) => {
    const resolved = resolveProfileImageSourcesForImage(image, {
      supabaseUrl: getSupabasePublicConfig().url,
      bucket: process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET,
    });
    return {
      ...image,
      src: resolved.src,
      candidates: resolved.candidates,
    };
  });
  const resolvedProfile = resolveProfileImage({ ...row.public_data, profileImages });
  resolvedProfile.profileImages = profileImagesWithSources;
  return {
    dataset: normalizeDatasetRecord(dataset),
    profile: resolvedProfile,
  };
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
  const { data, error } = await supabase
    .from('profile_images')
    .select('id,storage_path,position,is_primary,focal_x,focal_y,display_mode')
    .eq('id', imageId)
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (error || !data) throw new Error('Profile image was not found.');
  return {
    id: data.id,
    storagePath: data.storage_path,
    position: data.position,
    isPrimary: data.is_primary,
    focalX: data.focal_x,
    focalY: data.focal_y,
    displayMode: data.display_mode,
  };
}

export async function createAdminProfileImage({ datasetId, profileId, imageId, storagePath, makePrimary = false }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('create_profile_image_metadata', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
    requested_storage_path: storagePath,
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

export async function replaceAdminProfileImageStoragePath({ datasetId, profileId, imageId, storagePath }) {
  const supabase = requireServiceClient();
  const { data, error } = await supabase.rpc('replace_profile_image_storage_path', {
    requested_dataset_id: datasetId,
    requested_profile_id: profileId,
    requested_image_id: imageId,
    requested_storage_path: storagePath,
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
    .select('profile_id,public_data,ordinal')
    .eq('dataset_id', datasetId)
    .order('ordinal', { ascending: true });
  if (profilesError) return null;
  return {
    dataset: normalizeDatasetRecord(dataset),
    profiles: rows.map((row) => ({
      id: row.profile_id,
      name: row.public_data?.name || row.profile_id,
      role: row.public_data?.role || '',
      major: row.public_data?.major || '',
      year: row.public_data?.year || '',
    })),
  };
}
