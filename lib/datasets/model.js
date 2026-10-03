import { isValidDiscoveryStorageImagePath } from '../profile-images.js';

export const FALL_2025_DATASET = Object.freeze({
  id: 'fall-2025-local',
  slug: 'fall-2025',
  name: 'Fall 2025',
  term: 'Fall',
  year: 2025,
  status: 'active',
  profileCount: 210,
  createdAt: null,
  importedAt: null,
  activatedAt: null,
  showFamilyInDiscovery: true,
  source: 'local-fallback',
});

export function datasetSeenKey(slug) {
  return `ace-discover:seen:${slug}`;
}

export function datasetSavedKey(slug) {
  return `ace-discover:saved:${slug}`;
}

export function datasetEncounteredKey(slug) {
  return `ace-discover:encountered:${slug}`;
}

export function datasetDiscoveryKey(slug) {
  return `profile-gallery:discovery-v2:${slug}`;
}

export function profilePath(datasetSlug, profileId) {
  return `/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profileId)}`;
}

export function discoveryProfile(value = {}) {
  const profile = publicDetailProfile(value);
  delete profile.instagram;
  return profile;
}

// Discovery deliberately has two public projections. Cards and filters use
// this small allowlist on the initial page; long-form answers are fetched only
// after a visitor starts searching.
export const DISCOVERY_CARD_FIELDS = Object.freeze([
  'id', 'name', 'pronouns', 'role', 'major', 'majorGroup', 'year', 'school',
  'program', 'family', 'socialLevel', 'socialStyle', 'interests', 'vibes',
  'tagline', 'slideDeckUrl', 'image', 'imageCandidates', 'focalX', 'focalY',
  'displayMode',
]);

export const DISCOVERY_DEEP_SEARCH_FIELDS = Object.freeze([
  'hobbies', 'hobbyDetails', 'passion', 'music', 'movies', 'perfectDay',
  'idealHangout', 'bucketList', 'uniqueThings', 'hotTake',
]);

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function updateCompactHash(hash, value = '') {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

export function discoverySearchCorpusVersion(profiles = [], datasetSlug = '', showFamilyInDiscovery = true) {
  let hash = updateCompactHash(2166136261, datasetSlug);
  hash = updateCompactHash(hash, `\0family-discovery:${showFamilyInDiscovery !== false ? 'on' : 'off'}\0`);
  hash = updateCompactHash(hash, `\0${DISCOVERY_DEEP_SEARCH_FIELDS.join('\0')}\0`);
  for (const profile of profiles) {
    hash = updateCompactHash(hash, `${String(profile?.id || '')}\0`);
    for (const field of DISCOVERY_DEEP_SEARCH_FIELDS) {
      hash = updateCompactHash(hash, `${JSON.stringify(profile?.[field] ?? '')}\0`);
    }
  }
  return (hash >>> 0).toString(36);
}

export function discoveryCardProfile(value = {}) {
  const profile = discoveryProfile(value);
  const card = {};
  for (const field of DISCOVERY_CARD_FIELDS) {
    if (hasValue(profile[field])) card[field] = profile[field];
  }

  // A valid relational Discovery derivative is immutable and already has a
  // placeholder fallback in ProfileImage. Do not serialize legacy Drive or
  // canonical candidates behind a healthy derivative.
  if (isValidDiscoveryStorageImagePath(profile.storageImagePath) && card.image) {
    delete card.imageCandidates;
  }
  return card;
}

export function createDiscoverySearchCorpus(profiles = [], datasetSlug = '', showFamilyInDiscovery = true) {
  const rows = profiles.map((value) => {
    const profile = discoveryProfile(value);
    return [
      String(profile.id || ''),
      ...DISCOVERY_DEEP_SEARCH_FIELDS.map((field) => (
        typeof profile[field] === 'string' || typeof profile[field] === 'number'
          ? profile[field]
          : Array.isArray(profile[field])
            ? profile[field].filter((item) => typeof item === 'string' || typeof item === 'number')
            : ''
      )),
    ];
  }).filter(([profileId]) => Boolean(profileId));
  return {
    version: discoverySearchCorpusVersion(profiles, datasetSlug, showFamilyInDiscovery),
    datasetSlug,
    fields: [...DISCOVERY_DEEP_SEARCH_FIELDS],
    profiles: rows,
  };
}

export function publicDetailProfile(value = {}) {
  const profile = { ...value };
  delete profile.bio;
  delete profile.story;
  return profile;
}

export function normalizeDatasetRecord(value = {}) {
  return {
    id: value.id || '',
    slug: value.slug || '',
    name: value.name || value.slug || 'Dataset',
    term: value.term || '',
    year: Number(value.year) || null,
    status: value.status || 'ready',
    profileCount: Number(value.profile_count ?? value.profileCount) || 0,
    createdAt: value.created_at ?? value.createdAt ?? null,
    importedAt: value.imported_at ?? value.importedAt ?? null,
    activatedAt: value.activated_at ?? value.activatedAt ?? null,
    sourceType: value.source_type ?? value.sourceType ?? 'excel',
    googleSheetId: value.google_sheet_id ?? value.googleSheetId ?? null,
    googleSheetTab: value.google_sheet_tab ?? value.googleSheetTab ?? null,
    googleSheetTitle: value.google_sheet_title ?? value.googleSheetTitle ?? null,
    lastSourceSyncAt: value.last_source_sync_at ?? value.lastSourceSyncAt ?? null,
    lastSourceHash: value.last_source_hash ?? value.lastSourceHash ?? null,
    showFamilyInDiscovery: value.show_family_in_discovery ?? value.showFamilyInDiscovery ?? true,
  };
}
