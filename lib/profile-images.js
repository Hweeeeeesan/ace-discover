export const PROFILE_IMAGE_PLACEHOLDER = '/profile-placeholder.svg';
export const DEFAULT_PROFILE_IMAGE_BUCKET = 'profile-images';

const PATH_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const PRIMARY_FILENAME = /^primary\.(avif|gif|jpg|png|webp)$/;
const MIME_EXTENSIONS = Object.freeze({
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export function extensionForImageMime(contentType) {
  return MIME_EXTENSIONS[String(contentType || '').toLowerCase()] || '';
}

export function buildPrimaryStoragePath(datasetSlug, profileId, contentType) {
  const dataset = String(datasetSlug || '');
  const profile = String(profileId || '');
  const extension = extensionForImageMime(contentType);
  if (!PATH_SEGMENT.test(dataset)) throw new Error('Invalid dataset slug for a profile image path.');
  if (!PATH_SEGMENT.test(profile)) throw new Error('Invalid profile ID for a profile image path.');
  if (!extension) throw new Error('Unsupported profile image content type.');
  return `${dataset}/${profile}/primary.${extension}`;
}

export function isValidStorageImagePath(value) {
  if (typeof value !== 'string' || value.length > 240) return false;
  const parts = value.split('/');
  return parts.length === 3
    && PATH_SEGMENT.test(parts[0])
    && PATH_SEGMENT.test(parts[1])
    && PRIMARY_FILENAME.test(parts[2]);
}

export function storageImagePublicUrl({ supabaseUrl, bucket, storagePath }) {
  if (!isValidStorageImagePath(storagePath)) return '';
  const bucketName = String(bucket || '');
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucketName)) return '';

  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) return '';
  baseUrl.pathname = '/';
  baseUrl.search = '';
  baseUrl.hash = '';

  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  return new URL(
    `storage/v1/object/public/${encodeURIComponent(bucketName)}/${encodedPath}`,
    baseUrl,
  ).toString();
}

export function resolveProfileImageSources(profile = {}, options = {}) {
  const storageUrl = storageImagePublicUrl({
    supabaseUrl: options.supabaseUrl,
    bucket: options.bucket || DEFAULT_PROFILE_IMAGE_BUCKET,
    storagePath: profile.storageImagePath,
  });
  const legacyCandidates = Array.isArray(profile.imageCandidates) ? profile.imageCandidates : [];
  const candidates = Array.from(new Set([
    storageUrl,
    profile.image,
    ...legacyCandidates,
    PROFILE_IMAGE_PLACEHOLDER,
  ].filter(Boolean)));

  return {
    src: candidates[0] || PROFILE_IMAGE_PLACEHOLDER,
    candidates,
  };
}

export function withResolvedProfileImage(profile = {}, options = {}) {
  const resolved = resolveProfileImageSources(profile, options);
  return {
    ...profile,
    image: resolved.src,
    imageCandidates: resolved.candidates,
  };
}
