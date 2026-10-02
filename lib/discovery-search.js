import { DISCOVERY_DEEP_SEARCH_FIELDS } from './datasets/model.js';

export const PUBLIC_DISCOVERY_SEARCH_PATH = '/api/discovery/search';

function corpusKey(datasetSlug, version) {
  return `${String(datasetSlug || '')}:${String(version || '')}`;
}

export function hydrateDiscoverySearchCorpus(payload, {
  datasetSlug = '',
  version = '',
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Discovery search data is unavailable.');
  }
  if (payload.datasetSlug !== datasetSlug || payload.version !== version) {
    throw new Error('Discovery search data is stale.');
  }
  if (!Array.isArray(payload.fields)
    || payload.fields.length !== DISCOVERY_DEEP_SEARCH_FIELDS.length
    || payload.fields.some((field, index) => field !== DISCOVERY_DEEP_SEARCH_FIELDS[index])) {
    throw new Error('Discovery search data has an unexpected format.');
  }
  if (!Array.isArray(payload.profiles)) {
    throw new Error('Discovery search data has an unexpected format.');
  }

  const byProfileId = new Map();
  for (const row of payload.profiles) {
    if (!Array.isArray(row) || row.length !== payload.fields.length + 1) {
      throw new Error('Discovery search data has an unexpected profile row.');
    }
    const profileId = typeof row[0] === 'string' ? row[0] : '';
    if (!profileId || byProfileId.has(profileId)) {
      throw new Error('Discovery search data has an invalid profile identity.');
    }
    const fields = {};
    payload.fields.forEach((field, index) => {
      const value = row[index + 1];
      if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
        fields[field] = value;
      }
    });
    byProfileId.set(profileId, fields);
  }
  return byProfileId;
}

export function mergeDiscoverySearchProfiles(profiles = [], corpusByProfileId = new Map()) {
  return profiles.map((profile) => ({
    ...profile,
    ...(corpusByProfileId.get(profile.id) || {}),
  }));
}

export function createDiscoverySearchLoader(fetchCorpus) {
  if (typeof fetchCorpus !== 'function') throw new Error('A Discovery search fetcher is required.');
  let key = '';
  let value = null;
  let pending = null;

  return {
    load({ datasetSlug = '', version = '' } = {}) {
      const requestedKey = corpusKey(datasetSlug, version);
      if (!datasetSlug || !version) return Promise.reject(new Error('Discovery search identity is unavailable.'));
      if (key === requestedKey && value) return Promise.resolve(value);
      if (key === requestedKey && pending) return pending;

      key = requestedKey;
      value = null;
      pending = Promise.resolve(fetchCorpus())
        .then((payload) => hydrateDiscoverySearchCorpus(payload, { datasetSlug, version }))
        .then((corpus) => {
          if (key === requestedKey) value = corpus;
          return corpus;
        })
        .finally(() => {
          if (key === requestedKey) pending = null;
        });
      return pending;
    },
    reset() {
      key = '';
      value = null;
      pending = null;
    },
    peek() {
      return value;
    },
  };
}
