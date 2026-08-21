export const PROFILE_IMAGE_PLACEHOLDER = '/profile-placeholder.svg';
export const DEFAULT_PROFILE_IMAGE_BUCKET = 'profile-images';

const PATH_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_FILENAME = /^(?:primary|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(avif|gif|jpg|png|webp)$/;
export const DEFAULT_FOCAL_X = 50;
export const DEFAULT_FOCAL_Y = 35;
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

export function buildProfileImageStoragePath(datasetSlug, profileId, imageId, contentType) {
  const dataset = String(datasetSlug || '');
  const profile = String(profileId || '');
  const id = String(imageId || '').toLowerCase();
  const extension = extensionForImageMime(contentType);
  if (!PATH_SEGMENT.test(dataset)) throw new Error('Invalid dataset slug for a profile image path.');
  if (!PATH_SEGMENT.test(profile)) throw new Error('Invalid profile ID for a profile image path.');
  if (!IMAGE_ID.test(id)) throw new Error('Invalid image ID for a profile image path.');
  if (!extension) throw new Error('Unsupported profile image content type.');
  return `${dataset}/${profile}/${id}.${extension}`;
}

export function isValidStorageImagePath(value) {
  if (typeof value !== 'string' || value.length > 240) return false;
  const parts = value.split('/');
  return parts.length === 3
    && PATH_SEGMENT.test(parts[0])
    && PATH_SEGMENT.test(parts[1])
    && IMAGE_FILENAME.test(parts[2]);
}

export function isValidProfileImageId(value) {
  return typeof value === 'string' && IMAGE_ID.test(value);
}

export function normalizeFocalCoordinate(value, fallback = DEFAULT_FOCAL_X) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'number') {
    return fallback;
  }
  return Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : fallback;
}

export function isValidFocalCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function normalizeDisplayMode(value) {
  return value === 'portrait' ? 'portrait' : 'cover';
}

export function getProfileImages(profile = {}) {
  if (!Array.isArray(profile.profileImages)) return [];
  const seenPaths = new Set();
  return profile.profileImages
    .map((image) => ({
      id: typeof image?.id === 'string' ? image.id : '',
      storageImagePath: typeof image?.storageImagePath === 'string' ? image.storageImagePath : '',
      position: Number.isInteger(image?.position) && image.position >= 0 ? image.position : Number.MAX_SAFE_INTEGER,
      isPrimary: image?.isPrimary === true,
      focalX: normalizeFocalCoordinate(image?.focalX, DEFAULT_FOCAL_X),
      focalY: normalizeFocalCoordinate(image?.focalY, DEFAULT_FOCAL_Y),
      displayMode: normalizeDisplayMode(image?.displayMode),
    }))
    .filter((image) => {
      if (!isValidStorageImagePath(image.storageImagePath) || seenPaths.has(image.storageImagePath)) return false;
      seenPaths.add(image.storageImagePath);
      return true;
    })
    .sort((left, right) => (
      left.position - right.position
      || left.id.localeCompare(right.id)
      || left.storageImagePath.localeCompare(right.storageImagePath)
    ));
}

export function getPrimaryProfileImage(profile = {}) {
  const relationalPrimary = getProfileImages(profile).find((image) => image.isPrimary);
  if (relationalPrimary) return relationalPrimary;
  if (!isValidStorageImagePath(profile.storageImagePath)) return null;
  return {
    id: '',
    storageImagePath: profile.storageImagePath,
    position: 0,
    isPrimary: true,
    focalX: normalizeFocalCoordinate(profile.focalX, DEFAULT_FOCAL_X),
    focalY: normalizeFocalCoordinate(profile.focalY, DEFAULT_FOCAL_Y),
    displayMode: normalizeDisplayMode(profile.displayMode),
  };
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
  const primaryImage = getPrimaryProfileImage(profile);
  const storageUrl = storageImagePublicUrl({
    supabaseUrl: options.supabaseUrl,
    bucket: options.bucket || DEFAULT_PROFILE_IMAGE_BUCKET,
    storagePath: primaryImage?.storageImagePath,
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
  const primaryImage = getPrimaryProfileImage(profile) || {
    focalX: DEFAULT_FOCAL_X,
    focalY: DEFAULT_FOCAL_Y,
    displayMode: 'cover',
  };
  return {
    ...profile,
    profileImages: getProfileImages(profile),
    focalX: primaryImage.focalX,
    focalY: primaryImage.focalY,
    displayMode: primaryImage.displayMode,
    image: resolved.src,
    imageCandidates: resolved.candidates,
  };
}
