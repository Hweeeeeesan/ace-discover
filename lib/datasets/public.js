import 'server-only';

import { importHealth } from '../import-health';
import { profiles as fallProfiles } from '../profiles';
import { resolveProfileImage, resolveProfileImages } from '../profile-images-server';
import { createSupabasePublicClient } from '../supabase/server';
import {
  createDiscoverySearchCorpus,
  discoveryCardProfile,
  discoveryProfile,
  discoverySearchCorpusVersion,
  FALL_2025_DATASET,
  normalizeDatasetRecord,
  publicDetailProfile,
} from './model';
import { resolveEffectivePublicProfile } from '../profile-overrides';

function fallbackDataset() {
  const profiles = fallProfiles.map((profile) => discoveryProfile(resolveEffectivePublicProfile(profile)));
  return {
    ...FALL_2025_DATASET,
    profiles: resolveProfileImages(profiles).map(discoveryCardProfile),
    searchCorpusVersion: discoverySearchCorpusVersion(profiles, FALL_2025_DATASET.slug),
    health: importHealth,
  };
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
    searchCorpusVersion: '',
    health: null,
    source: 'supabase-unavailable',
  };
}

function effectiveProfiles(payload) {
  return payload.profiles.map((profile) => (
    discoveryProfile(resolveEffectivePublicProfile(profile))
  ));
}

function normalizePayload(payload) {
  if (!payload || !Array.isArray(payload.profiles)) return null;
  const dataset = normalizeDatasetRecord(payload.dataset || payload);
  if (!dataset.slug) return null;
  const profiles = effectiveProfiles(payload);
  return {
    ...dataset,
    // The public bulk RPC already returns the effective merged profile. The
    // client receives only the card/filter projection; deep-search fields are
    // exposed through the separate cached corpus route.
    profiles: resolveProfileImages(profiles).map(discoveryCardProfile),
    searchCorpusVersion: discoverySearchCorpusVersion(profiles, dataset.slug),
    health: payload.health || null,
    source: 'supabase',
  };
}

async function loadActivePayload({ requireAvailable = false } = {}) {
  const supabase = createSupabasePublicClient();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc('get_active_dataset');
  if (error) {
    console.error('Unable to load active ACE dataset:', error.code || 'database_error');
    if (requireAvailable) throw new Error('The active public dataset could not be loaded.');
    return undefined;
  }
  return data;
}

export async function getActiveDataset({ requireAvailable = false } = {}) {
  const data = await loadActivePayload({ requireAvailable });
  if (data === null) return fallbackDataset();
  if (data === undefined) return unavailableDataset();
  const dataset = normalizePayload(data);
  if (!dataset && requireAvailable) {
    throw new Error('The active public dataset is unavailable.');
  }
  return dataset || unavailableDataset();
}

export async function getActiveDiscoverySearchCorpus({ requireAvailable = false } = {}) {
  const data = await loadActivePayload({ requireAvailable });
  if (data === null) {
    const profiles = fallProfiles.map((profile) => discoveryProfile(resolveEffectivePublicProfile(profile)));
    return createDiscoverySearchCorpus(profiles, FALL_2025_DATASET.slug);
  }
  if (!data || !Array.isArray(data.profiles)) {
    if (requireAvailable) throw new Error('The active public search corpus is unavailable.');
    return createDiscoverySearchCorpus([], 'unavailable');
  }
  const dataset = normalizeDatasetRecord(data.dataset || data);
  if (!dataset.slug) {
    if (requireAvailable) throw new Error('The active public search corpus is unavailable.');
    return createDiscoverySearchCorpus([], 'unavailable');
  }
  return createDiscoverySearchCorpus(effectiveProfiles(data), dataset.slug);
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
    return profile ? { dataset: active, profile: resolveProfileImage(publicDetailProfile(profile)) } : null;
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
    profile: resolveProfileImage(publicDetailProfile(resolveEffectivePublicProfile(data.profile))),
  };
}
