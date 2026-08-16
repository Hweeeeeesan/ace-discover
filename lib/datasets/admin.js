import 'server-only';

import { createSupabaseServiceClient } from '../supabase/server';
import { normalizeDatasetRecord } from './model';

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
    .select('id,slug,name,term,year,status,profile_count,health,safe_issues,created_at,imported_at,activated_at')
    .order('year', { ascending: false })
    .order('term', { ascending: false });
  if (error) throw new Error(`Unable to load datasets: ${error.message}`);
  return data.map((dataset) => ({
    ...normalizeDatasetRecord(dataset),
    health: dataset.health,
    safeIssues: dataset.safe_issues || {},
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
    .select('public_data')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (profileError || !row?.public_data) return null;
  return { dataset: normalizeDatasetRecord(dataset), profile: row.public_data };
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
