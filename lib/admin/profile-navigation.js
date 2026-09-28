const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DATASET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ADMIN_PROFILE_RETURN_MARKER_KEY = 'ace-admin-profile-return-v1';

export function adminProfileListPath(datasetId) {
  const id = String(datasetId || '');
  return DATASET_ID.test(id) ? `/admin/preview/${encodeURIComponent(id)}` : '/admin';
}

export function safeAdminProfileListReturn(value, datasetId) {
  const fallback = adminProfileListPath(datasetId);
  if (fallback === '/admin' || typeof value !== 'string' || !value.startsWith('/')
    || value.includes('\\') || CONTROL_CHARACTERS.test(value)) return fallback;
  try {
    const base = new URL('https://ace-discover.invalid');
    const destination = new URL(value, base);
    if (destination.origin !== base.origin || destination.pathname !== fallback) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

export function adminProfilePreviewPath({ datasetId, profileId, returnTo, hash = '' } = {}) {
  const listPath = adminProfileListPath(datasetId);
  const profile = String(profileId || '');
  if (listPath === '/admin' || !PROFILE_ID.test(profile)) return listPath;
  const target = safeAdminProfileListReturn(returnTo, datasetId);
  const params = new URLSearchParams({ returnTo: target });
  const safeHash = typeof hash === 'string' && /^#[a-z0-9-]*$/i.test(hash) ? hash : '';
  return `${listPath}/${encodeURIComponent(profile)}?${params.toString()}${safeHash}`;
}

export function adminProfileListScrollKey(returnTo, datasetId) {
  return `ace-admin-profile-scroll:${safeAdminProfileListReturn(returnTo, datasetId)}`;
}

export function createAdminProfileReturnMarker({ datasetId, profilePath, returnTo, createdAt = Date.now() } = {}) {
  return {
    datasetId: String(datasetId || ''),
    profilePath: String(profilePath || ''),
    returnTo: safeAdminProfileListReturn(returnTo, datasetId),
    createdAt: Number(createdAt),
  };
}

export function isValidAdminProfileReturnMarker(marker, {
  datasetId,
  profilePath,
  returnTo,
  now = Date.now(),
  maxAgeMs = 4 * 60 * 60 * 1000,
} = {}) {
  if (!marker || typeof marker !== 'object') return false;
  const createdAt = Number(marker.createdAt);
  return marker.datasetId === String(datasetId || '')
    && marker.profilePath === String(profilePath || '')
    && marker.returnTo === safeAdminProfileListReturn(returnTo, datasetId)
    && Number.isFinite(createdAt)
    && createdAt <= Number(now)
    && Number(now) - createdAt <= maxAgeMs;
}
