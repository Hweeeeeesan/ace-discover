import 'server-only';

import { importHealth } from '../import-health';
import { profiles as fallProfiles } from '../profiles';
import { createSupabasePublicClient } from '../supabase/server';
import { discoveryProfile, FALL_2025_DATASET, normalizeDatasetRecord } from './model';

function fallbackDataset() {
  return { ...FALL_2025_DATASET, profiles: fallProfiles.map(discoveryProfile), health: importHealth };
}

function unavailableDataset() {
  return {
    id: '',
    slug: 'unavailable',
    name: 'No active dataset',
    term: '',
    year: null,
    status: 'unavailable',
    profileCount: 0,
    profiles: [],
    health: null,
    source: 'supabase-unavailable',
  };
}

function normalizePayload(payload) {
  if (!payload || !Array.isArray(payload.profiles)) return null;
  const dataset = normalizeDatasetRecord(payload.dataset || payload);
  if (!dataset.slug) return null;
  return {
    ...dataset,
    profiles: payload.profiles.map(discoveryProfile),
    health: payload.health || null,
    source: 'supabase',
  };
}

export async function getActiveDataset() {
  const supabase = createSupabasePublicClient();
  if (!supabase) return fallbackDataset();

  const { data, error } = await supabase.rpc('get_active_dataset');
  if (error) {
    console.error('Unable to load active ACE dataset:', error.code || 'database_error');
    return unavailableDataset();
  }
  return normalizePayload(data) || unavailableDataset();
}

export async function getPublishedDataset(slug) {
  const active = await getActiveDataset();
  return active.slug === slug ? active : null;
}

export async function getPublishedProfile(datasetSlug, profileId) {
  const active = await getActiveDataset();
  if (active.slug !== datasetSlug) return null;

  if (active.source === 'local-fallback') {
    const profile = fallProfiles.find((candidate) => candidate.id === profileId);
    return profile ? { dataset: active, profile } : null;
  }

  const supabase = createSupabasePublicClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_published_profile', {
    requested_slug: datasetSlug,
    requested_profile_id: profileId,
  });
  if (error || !data?.profile) return null;
  return {
    dataset: { ...normalizeDatasetRecord(data.dataset || {}), source: 'supabase' },
    profile: data.profile,
  };
}
