import 'server-only';

import { getAdminDatasetProfile, updateAdminPublicProfile } from './datasets/admin';
import { buildSinglePublicOverridePatch } from './profile-overrides';
import {
  auditPublicProfileContent,
  buildProfileContentQaReport,
  PROFILE_QA_SEVERITIES,
} from './profile-qa';
import { createSupabaseServiceClient } from './supabase/server';

const DATASET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QA_FIELD = /^[a-z][a-zA-Z0-9]{1,79}$/;
const QA_RULE = /^[a-z][a-z0-9_]{1,79}$/;
const SOURCE_HASH = /^[0-9a-f]{64}$/;

function requireServiceClient() {
  const client = createSupabaseServiceClient();
  if (!client) throw new Error('Supabase database administration is not configured.');
  return client;
}

function validateTarget(datasetId, profileId = '') {
  if (!DATASET_ID.test(String(datasetId || ''))) throw new Error('Invalid dataset.');
  if (profileId && !PROFILE_ID.test(String(profileId))) throw new Error('Invalid profile.');
}

function validateIssueTarget({ datasetId, profileId, field, rule, sourceHash }) {
  validateTarget(datasetId, profileId);
  if (!QA_FIELD.test(String(field || '')) || !QA_RULE.test(String(rule || '')) || !SOURCE_HASH.test(String(sourceHash || ''))) {
    throw new Error('Invalid QA review target.');
  }
}

function missingDispositionTable(error) {
  return ['42P01', 'PGRST204', 'PGRST205'].includes(String(error?.code || ''))
    || /profile_content_qa_dispositions/i.test(String(error?.message || ''));
}

async function readQaRows(supabase, datasetId) {
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,name,year,status,profile_count')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  const { data: rows, error: rowsError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,ordinal,public_data,public_overrides,public_overrides_updated_at')
    .eq('dataset_id', datasetId)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (rowsError) throw new Error(`Public profile QA could not read dataset profiles: ${rowsError.message}`);
  if ((rows || []).length !== Number(dataset.profile_count || 0)) {
    throw new Error(`Dataset integrity check failed: expected ${dataset.profile_count} profiles, received ${(rows || []).length}.`);
  }
  const dispositionsResult = await supabase
    .from('profile_content_qa_dispositions')
    .select('profile_id,field,rule,source_hash,disposition')
    .eq('dataset_id', datasetId)
    .limit(10000);
  if (dispositionsResult.error && !missingDispositionTable(dispositionsResult.error)) {
    throw new Error(`Public profile QA dispositions could not be read: ${dispositionsResult.error.message}`);
  }
  return {
    dataset,
    rows: rows || [],
    dispositions: dispositionsResult.error ? [] : dispositionsResult.data || [],
    dispositionPersistenceAvailable: !dispositionsResult.error,
  };
}

export async function getDatasetProfileQa(datasetId) {
  validateTarget(datasetId);
  const context = await readQaRows(requireServiceClient(), datasetId);
  return {
    ok: true,
    ...buildProfileContentQaReport(context),
    dispositionPersistenceAvailable: context.dispositionPersistenceAvailable,
    readOnly: true,
  };
}

export async function allowProfileQaIssue({ datasetId, profileId, field, rule, sourceHash, actorId }) {
  validateIssueTarget({ datasetId, profileId, field, rule, sourceHash });
  const supabase = requireServiceClient();
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('year')
    .eq('id', datasetId)
    .single();
  if (datasetError || !dataset) throw new Error('Dataset was not found.');
  const { data: row, error } = await supabase
    .from('dataset_profiles')
    .select('public_data')
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .single();
  if (error || !row?.public_data) throw new Error('Profile was not found in the requested dataset.');
  const currentIssue = auditPublicProfileContent(row.public_data, { datasetYear: dataset.year }).find((item) => (
    item.field === field && item.rule === rule && item.sourceHash === sourceHash
  ));
  if (!currentIssue) throw new Error('This source response changed. Re-check QA before allowing it.');
  if (currentIssue.severity === PROFILE_QA_SEVERITIES.BLOCK) {
    throw new Error('Blocked privacy issues cannot be allowed as-is. Edit or hide the public field.');
  }
  const disposition = await supabase.from('profile_content_qa_dispositions').upsert({
    dataset_id: datasetId,
    profile_id: profileId,
    field,
    rule,
    source_hash: sourceHash,
    disposition: 'keep_as_submitted',
    reviewed_by: actorId,
    reviewed_at: new Date().toISOString(),
  }, { onConflict: 'dataset_id,profile_id,field,rule,source_hash' });
  if (disposition.error) {
    if (missingDispositionTable(disposition.error)) {
      throw new Error('Apply the profile content QA migration before saving Allow as-is decisions.');
    }
    throw new Error(`The QA review decision could not be saved: ${disposition.error.message}`);
  }
  return { ok: true, disposition: 'allowed_as_is' };
}

export async function reopenProfileQaIssue({ datasetId, profileId, field, rule, sourceHash }) {
  validateIssueTarget({ datasetId, profileId, field, rule, sourceHash });
  const result = await requireServiceClient()
    .from('profile_content_qa_dispositions')
    .delete()
    .eq('dataset_id', datasetId)
    .eq('profile_id', profileId)
    .eq('field', field)
    .eq('rule', rule)
    .eq('source_hash', sourceHash)
    .eq('disposition', 'keep_as_submitted');
  if (result.error) {
    if (missingDispositionTable(result.error)) {
      throw new Error('Apply the profile content QA migration before reopening review decisions.');
    }
    throw new Error(`The QA review decision could not be reopened: ${result.error.message}`);
  }
  return {
    ok: true,
    disposition: 'unresolved',
    sourcePreserved: true,
    publicOverridesPreserved: true,
  };
}

export async function updateQaPublicField({ datasetId, profileId, field, value, actorId }) {
  validateTarget(datasetId, profileId);
  const current = await getAdminDatasetProfile(datasetId, profileId);
  if (!current) throw new Error('Profile was not found in the requested dataset.');
  const overrides = buildSinglePublicOverridePatch(
    current.importedPublicData,
    current.publicOverrides,
    field,
    value,
  );
  const updated = await updateAdminPublicProfile({
    datasetId,
    profileId,
    overrides,
    expectedUpdatedAt: current.publicOverridesUpdatedAt,
    actorId,
  });
  return {
    ok: true,
    publicOverrides: overrides,
    updatedAt: updated.updatedAt,
    datasetSlug: current.dataset.slug,
    sourcePreserved: true,
  };
}
