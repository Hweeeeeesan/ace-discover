export const MAX_PROFILE_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_PROFILE_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_PROFILE_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_PROFILE_IMAGE_DIMENSION = 20000;
export const PROFILE_IMAGE_QUALITY_STAGES = Object.freeze([92, 86, 80, 76]);
export const PROFILE_IMAGE_RESIZE_SCALES = Object.freeze([0.9, 0.8, 0.7, 0.6, 0.5]);
export const MIN_PROFILE_IMAGE_LONG_EDGE = 1600;
export const SUPPORTED_PROFILE_IMAGE_MIME_TYPES = Object.freeze([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
