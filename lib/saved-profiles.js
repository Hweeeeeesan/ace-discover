import { datasetSavedKey } from './datasets/model.js';

export const SAVED_CHANGE_EVENT = 'ace-discover:saved-change';

export function savedProfilesKey(datasetSlug = 'fall-2025') {
  return datasetSavedKey(datasetSlug);
}

export function sanitizeSavedIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)));
}

function storageArgs(datasetSlugOrStorage, maybeStorage) {
  if (typeof datasetSlugOrStorage === 'string') {
    return { datasetSlug: datasetSlugOrStorage || 'fall-2025', storage: maybeStorage ?? globalThis.localStorage };
  }
  return { datasetSlug: 'fall-2025', storage: datasetSlugOrStorage ?? globalThis.localStorage };
}

export function readSavedIds(datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  try {
    return sanitizeSavedIds(JSON.parse(storage?.getItem(savedProfilesKey(datasetSlug)) || '[]'));
  } catch {
    try { storage?.removeItem(savedProfilesKey(datasetSlug)); } catch {}
    return [];
  }
}

function writeSavedIds(datasetSlug, ids, storage) {
  const safeIds = sanitizeSavedIds(ids);
  try { storage?.setItem(savedProfilesKey(datasetSlug), JSON.stringify(safeIds)); } catch {}
  try { window.dispatchEvent(new CustomEvent(SAVED_CHANGE_EVENT, { detail: { datasetSlug } })); } catch {}
  return safeIds;
}

export function isProfileSaved(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  return readSavedIds(datasetSlugOrStorage, maybeStorage).includes(profileId);
}

export function saveProfile(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  if (typeof profileId !== 'string' || !profileId) return readSavedIds(datasetSlug, storage);
  return writeSavedIds(datasetSlug, [...readSavedIds(datasetSlug, storage), profileId], storage);
}

export function unsaveProfile(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  const { datasetSlug, storage } = storageArgs(datasetSlugOrStorage, maybeStorage);
  return writeSavedIds(datasetSlug, readSavedIds(datasetSlug, storage).filter((id) => id !== profileId), storage);
}

export function toggleSavedProfile(profileId, datasetSlugOrStorage = 'fall-2025', maybeStorage) {
  return isProfileSaved(profileId, datasetSlugOrStorage, maybeStorage)
    ? unsaveProfile(profileId, datasetSlugOrStorage, maybeStorage)
    : saveProfile(profileId, datasetSlugOrStorage, maybeStorage);
}
