export const SEEN_PROFILES_KEY = 'ace-discover:seen-profiles-v1';
export const SEEN_CHANGE_EVENT = 'ace-discover:seen-change';

export function sanitizeSeenIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((id) => typeof id === 'string' && id.length <= 160)));
}

export function readSeenIds(storage = globalThis.localStorage) {
  try {
    return sanitizeSeenIds(JSON.parse(storage?.getItem(SEEN_PROFILES_KEY) || '[]'));
  } catch {
    return [];
  }
}

export function markProfileSeen(profileId, storage = globalThis.localStorage) {
  if (typeof profileId !== 'string' || !profileId) return [];
  const ids = sanitizeSeenIds([...readSeenIds(storage), profileId]);
  try { storage?.setItem(SEEN_PROFILES_KEY, JSON.stringify(ids)); } catch {}
  return ids;
}

export function resetSeenIds(storage = globalThis.localStorage) {
  try { storage?.removeItem(SEEN_PROFILES_KEY); } catch {}
  return [];
}
