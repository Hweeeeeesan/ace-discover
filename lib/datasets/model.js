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
  source: 'local-fallback',
});

export function datasetSeenKey(slug) {
  return `ace-discover:seen:${slug}`;
}

export function datasetDiscoveryKey(slug) {
  return `profile-gallery:discovery-v2:${slug}`;
}

export function profilePath(datasetSlug, profileId) {
  return `/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profileId)}`;
}

export function discoveryProfile(value = {}) {
  const profile = { ...value };
  delete profile.instagram;
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
  };
}
