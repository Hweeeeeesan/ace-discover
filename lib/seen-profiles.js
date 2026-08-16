import { datasetSeenKey } from './datasets/model.js';

export const SEEN_PROFILES_KEY = 'ace-discover:seen-profiles-v1';
export const SEEN_CHANGE_EVENT = 'ace-discover:seen-change';

export function seenProfilesKey(datasetSlug = 'fall-2025') {
  return datasetSeenKey(datasetSlug);
}

export function sanitizeSeenIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id) => typeof id === 'string' && id.length <= 160)));
}

function storageArgs(datasetSlugOrStorage, maybeStorage) {
  if (typeof datasetSlugOrStorage === 'string') {
    return { datasetSlug: datasetSlugOrStorage || 'fall-2025', storage: maybeStorage ?? globalThis.localStorage };
  }
  return { datasetSlug: 'fall-2025', storage: datasetSlugOrStorage ?? globalThis.localStorage };
}

export function readSeenIds(datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  try {
    const key = seenProfilesKey(datasetSlug);
    const stored = storage?.getItem(key);
    if (stored !== null) return sanitizeSeenIds(JSON.parse(stored || '[]'));

    // One-time Fall 2025 migration from the v3 global seen key.
    if (datasetSlug === 'fall-2025') {
      const legacy = sanitizeSeenIds(JSON.parse(storage?.getItem(SEEN_PROFILES_KEY) || '[]'));
      if (legacy.length) storage?.setItem(key, JSON.stringify(legacy));
      return legacy;
    }
    return [];
  } catch {
    return [];
  }
}

export function markProfileSeen(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  if (typeof profileId !== 'string' || !profileId) return [];
  const ids = sanitizeSeenIds([...readSeenIds(datasetSlug, storage), profileId]);
  try { storage?.setItem(seenProfilesKey(datasetSlug), JSON.stringify(ids)); } catch {}
  return ids;
}

export function resetSeenIds(datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  try { storage?.removeItem(seenProfilesKey(datasetSlug)); } catch {}
  return [];
}
