import { datasetEncounteredKey } from './datasets/model.js';

export const ENCOUNTERED_PROFILES_KEY = 'ace-discover:encountered';

export function encounteredProfilesKey(datasetSlug = 'fall-2025') {
  return datasetEncounteredKey(datasetSlug);
}

export function sanitizeEncounteredIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 160,
  )));
}

function storageArgs(datasetSlugOrStorage, maybeStorage) {
  if (typeof datasetSlugOrStorage === 'string') {
    return {
      datasetSlug: datasetSlugOrStorage || 'fall-2025',
      storage: maybeStorage ?? globalThis.sessionStorage,
    };
  }
  return { datasetSlug: 'fall-2025', storage: datasetSlugOrStorage ?? globalThis.sessionStorage };
}

export function readEncounteredIds(datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  try {
    return sanitizeEncounteredIds(JSON.parse(storage?.getItem(encounteredProfilesKey(datasetSlug)) || '[]'));
  } catch {
    try { storage?.removeItem(encounteredProfilesKey(datasetSlug)); } catch {}
    return [];
  }
}

export function markProfileEncountered(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  if (typeof profileId !== 'string' || !profileId || profileId.length > 160) {
    return readEncounteredIds(datasetSlug, storage);
  }
  const ids = sanitizeEncounteredIds([...readEncounteredIds(datasetSlug, storage), profileId]);
  try { storage?.setItem(encounteredProfilesKey(datasetSlug), JSON.stringify(ids)); } catch {}
  return ids;
}

export function isProfileEncountered(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  return readEncounteredIds(datasetSlugOrStorage, maybeStorage).includes(profileId);
}

