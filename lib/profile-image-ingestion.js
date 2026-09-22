import {
  compareDriveFilesNaturally,
  fetchDriveImage,
  listFilesInFolder,
  listImageFilesInFolder,
} from './google-drive-server.js';
import { randomUUID } from 'node:crypto';
import {
  buildDiscoveryDerivativeStoragePath,
  buildPrimaryStoragePath,
  buildProfileImageStoragePath,
} from './profile-images.js';
import {
  MAX_PROFILE_IMAGE_BYTES,
  MAX_PROFILE_IMAGE_DIMENSION,
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  MAX_PROFILE_IMAGE_PIXELS,
  MIN_PROFILE_IMAGE_LONG_EDGE,
  PROFILE_IMAGE_QUALITY_STAGES,
  PROFILE_IMAGE_RESIZE_SCALES,
  SUPPORTED_PROFILE_IMAGE_MIME_TYPES,
} from './profile-image-constraints.js';
import sharp from 'sharp';
import { generateProfileImageAssetsFromNormalized } from './profile-image-derivatives.js';

export {
  MAX_PROFILE_IMAGE_BYTES,
  MAX_PROFILE_IMAGE_DIMENSION,
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  MAX_PROFILE_IMAGE_PIXELS,
  MIN_PROFILE_IMAGE_LONG_EDGE,
  PROFILE_IMAGE_QUALITY_STAGES,
  PROFILE_IMAGE_RESIZE_SCALES,
  SUPPORTED_PROFILE_IMAGE_MIME_TYPES,
};
export const MIN_REPLACEMENT_FALLBACK_LONG_EDGE = 800;
export const MIN_REPLACEMENT_FALLBACK_SHORT_EDGE = 600;
const VALID_DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const SUPPORTED_DRIVE_IMAGE_MIME_TYPES = new Set(SUPPORTED_PROFILE_IMAGE_MIME_TYPES);

export class ProfileImageIngestionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProfileImageIngestionError';
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizationPolicy(options = {}) {
  const requestedQualities = Array.isArray(options.qualityStages)
    ? options.qualityStages.filter((quality) => Number.isInteger(quality) && quality >= 1 && quality <= 100).slice(0, 6)
    : [];
  return {
    finalByteLimit: positiveInteger(options.finalByteLimit, MAX_PROFILE_IMAGE_BYTES),
    inputByteLimit: positiveInteger(options.inputByteLimit, MAX_PROFILE_IMAGE_INPUT_BYTES),
    maxInputPixels: positiveInteger(options.maxInputPixels, MAX_PROFILE_IMAGE_PIXELS),
    maxDimension: positiveInteger(options.maxDimension, MAX_PROFILE_IMAGE_DIMENSION),
    minLongEdge: positiveInteger(options.minLongEdge, MIN_PROFILE_IMAGE_LONG_EDGE),
    qualityStages: requestedQualities.length ? requestedQualities : [...PROFILE_IMAGE_QUALITY_STAGES],
    resizeScales: Array.isArray(options.resizeScales)
      ? options.resizeScales.filter((scale) => Number.isFinite(scale) && scale > 0 && scale < 1).slice(0, 6)
      : [...PROFILE_IMAGE_RESIZE_SCALES],
  };
}

function createSharpInput(input, contentType, maxInputPixels) {
  return sharp(input, {
    animated: contentType === 'image/gif',
    failOn: 'error',
    limitInputPixels: maxInputPixels,
  });
}

function assertSafeImageMetadata(metadata, policy) {
  const width = Number(metadata?.width || 0);
  const pageHeight = Number(metadata?.pageHeight || metadata?.height || 0);
  const pages = Math.max(1, Number(metadata?.pages || 1));
  const decodedPixels = width * pageHeight * pages;
  if (
    !Number.isInteger(width)
    || !Number.isInteger(pageHeight)
    || width < 1
    || pageHeight < 1
    || width > policy.maxDimension
    || pageHeight > policy.maxDimension
    || !Number.isSafeInteger(decodedPixels)
    || decodedPixels > policy.maxInputPixels
  ) {
    throw new ProfileImageIngestionError(
      'image_dimensions_too_large',
      'The image dimensions exceed the safe decode limit.',
      { width, height: pageHeight, pages, decodedPixels },
    );
  }
}

async function readSafeImageMetadata(image, policy) {
  try {
    const metadata = await image.metadata();
    assertSafeImageMetadata(metadata, policy);
    return metadata;
  } catch (error) {
    if (error instanceof ProfileImageIngestionError) throw error;
    if (/pixel limit|allocation limit|dimensions?/i.test(String(error?.message || error))) {
      throw new ProfileImageIngestionError(
        'image_dimensions_too_large',
        'The image dimensions exceed the safe decode limit.',
      );
    }
    throw error;
  }
}

function orientedDimensions(metadata) {
  return {
    width: Number(metadata.autoOrient?.width || metadata.width),
    height: Number(metadata.autoOrient?.height || metadata.height),
  };
}

async function imageHasTransparency(input, contentType, policy, metadata) {
  if (!metadata.hasAlpha) return false;
  const { channels } = await createSharpInput(input, contentType, policy.maxInputPixels)
    .ensureAlpha()
    .stats();
  return Number(channels.at(-1)?.min) < 255;
}

function oversizedOutputType(contentType) {
  if (contentType === 'image/png') return 'image/webp';
  if (contentType === 'image/jpeg') return 'image/jpeg';
  if (contentType === 'image/webp') return 'image/webp';
  if (contentType === 'image/avif') return 'image/avif';
  if (contentType === 'image/gif') return 'image/webp';
  return '';
}

function encodeForType(image, contentType, quality) {
  if (contentType === 'image/jpeg') {
    return image.jpeg({
      quality,
      chromaSubsampling: '4:2:0',
      mozjpeg: true,
      progressive: true,
    });
  }
  if (contentType === 'image/webp') {
    return image.webp({
      quality,
      alphaQuality: 100,
      effort: 4,
      smartSubsample: true,
    });
  }
  if (contentType === 'image/avif') {
    return image.avif({ quality, effort: 4 });
  }
  throw new Error('The oversized image format cannot be normalized.');
}

async function encodeOversizedAttempt({
  input,
  inputType,
  outputType,
  quality,
  dimensions,
  policy,
}) {
  let image = createSharpInput(input, inputType, policy.maxInputPixels).autoOrient();
  if (dimensions) {
    image = image.resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    });
  }
  const { data, info } = await encodeForType(image, outputType, quality)
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    contentType: detectImageContentType(data) || outputType,
    width: info.width,
    height: info.height,
  };
}

function normalizationMetrics(originalBytes, originalDimensions, normalized) {
  return {
    originalBytes,
    finalBytes: normalized.bytes.length,
    originalWidth: originalDimensions.width,
    originalHeight: originalDimensions.height,
    finalWidth: normalized.width,
    finalHeight: normalized.height,
    finalMime: normalized.contentType,
  };
}

function normalizationDiagnostic(category, detail, metrics) {
  return { category, detail, ...metrics };
}

function successfulOversizedResult({
  input,
  inputType,
  originalDimensions,
  normalized,
  hasTransparency,
  resized,
  attempts,
}) {
  const metrics = normalizationMetrics(input.length, originalDimensions, normalized);
  const diagnostics = [];
  if (inputType === 'image/png') {
    diagnostics.push(normalizationDiagnostic(
      'oversized_png_converted_to_webp',
      hasTransparency
        ? 'An oversized PNG was converted to WebP while preserving transparency.'
        : 'An oversized opaque PNG was converted to high-quality WebP.',
      metrics,
    ));
  }
  if (resized) {
    diagnostics.push(normalizationDiagnostic(
      'oversized_image_resized',
      'Compression alone was insufficient, so the image was downsampled without changing its aspect ratio.',
      metrics,
    ));
  }
  diagnostics.push(normalizationDiagnostic(
    'oversized_image_normalized',
    `The oversized image was normalized in ${attempts} bounded attempt${attempts === 1 ? '' : 's'}.`,
    metrics,
  ));
  return {
    ...normalized,
    originalByteLength: input.length,
    originalWidth: originalDimensions.width,
    originalHeight: originalDimensions.height,
    resized,
    diagnostics,
  };
}

export function classifyProfileImageSource(profile = {}) {
  if (profile.driveFileId) {
    return VALID_DRIVE_ID.test(profile.driveFileId)
      ? { eligible: true, kind: 'drive-file' }
      : { eligible: false, category: 'invalid_url', detail: 'The stored Drive file ID is invalid.' };
  }
  if (profile.driveFolderId) {
    return VALID_DRIVE_ID.test(profile.driveFolderId)
      ? { eligible: true, kind: 'drive-folder' }
      : { eligible: false, category: 'drive_folder', detail: 'The stored Drive folder ID is invalid.' };
  }

  const kind = String(profile.imageKind || '');
  if (kind === 'google-document') {
    return { eligible: false, category: 'google_document', detail: 'A Google document was submitted instead of an image.' };
  }
  if (kind === 'drive-folder') {
    return { eligible: false, category: 'drive_folder', detail: 'The Drive folder has no valid stored folder ID.' };
  }
  if (kind === 'direct-image-url') {
    return {
      eligible: false,
      category: 'unsupported_content',
      detail: 'Direct web URLs are not fetched by the migration tool; replace the source with an approved Drive image.',
    };
  }
  if (['invalid-url', 'invalid-value', 'invalid-drive-link', 'unverified-web-url', 'local-file'].includes(kind)) {
    return { eligible: false, category: 'invalid_url', detail: 'The stored source is not a valid approved Drive image URL.' };
  }
  return { eligible: false, category: 'missing_source', detail: 'No approved Drive image source is stored for this profile.' };
}

export function detectImageContentType(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png';
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    buffer.length >= 12
    && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
    && ['avif', 'avis'].includes(buffer.subarray(8, 12).toString('ascii'))
  ) return 'image/avif';
  return '';
}

/**
 * Materialize EXIF orientation into pixels before an image is stored. Sharp
 * removes the orientation metadata when it writes an image with an EXIF
 * orientation tag. Files without orientation metadata are returned
 * byte-for-byte so healthy uploads are not needlessly recompressed.
 */
export async function normalizeImageOrientation(bytes, contentType, options = {}) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const policy = normalizationPolicy(options);
  const image = createSharpInput(input, contentType, policy.maxInputPixels);
  const metadata = await readSafeImageMetadata(image, policy);
  if (metadata.orientation === undefined) {
    return {
      bytes: input,
      contentType,
      width: metadata.width,
      height: metadata.height,
    };
  }

  return encodeOrientedImage(image.rotate(), contentType);
}

async function encodeOrientedImage(image, contentType) {
  let output = image;
  if (contentType === 'image/jpeg') output = output.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  else if (contentType === 'image/png') output = output.png();
  else if (contentType === 'image/webp') output = output.webp({ quality: 95 });
  else if (contentType === 'image/gif') output = output.gif();
  else if (contentType === 'image/avif') output = output.avif({ quality: 90 });
  else throw new Error('The image format cannot be orientation-normalized.');

  const { data: normalized, info } = await output.toBuffer({ resolveWithObject: true });
  return {
    bytes: normalized,
    contentType: detectImageContentType(normalized) || contentType,
    width: info.width,
    height: info.height,
  };
}

/**
 * Decode and validate an image, materialize EXIF orientation, and normalize an
 * oversized asset into a browser-safe representation. The 15 MiB production
 * limit is always applied to the final bytes; a larger bounded input envelope
 * exists only so Sharp gets an opportunity to reduce otherwise valid images.
 */
export async function normalizeProfileImage(bytes, options = {}) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const policy = normalizationPolicy(options);
  if (!input.length) {
    throw new ProfileImageIngestionError('corrupt_image', 'The image was empty.');
  }
  if (input.length > policy.inputByteLimit) {
    throw new ProfileImageIngestionError(
      'image_input_too_large',
      'The image exceeds the 50 MiB safe normalization input limit.',
      { originalBytes: input.length, inputByteLimit: policy.inputByteLimit },
    );
  }

  const contentType = detectImageContentType(input);
  if (!contentType) {
    throw new ProfileImageIngestionError(
      'unsupported_file_type',
      'The content is not a supported JPEG, PNG, WebP, GIF, or AVIF image.',
    );
  }

  const image = createSharpInput(input, contentType, policy.maxInputPixels);
  const metadata = await readSafeImageMetadata(image, policy);
  const originalDimensions = orientedDimensions(metadata);

  if (input.length <= policy.finalByteLimit) {
    const normalized = await normalizeImageOrientation(input, contentType, policy);
    if (normalized.bytes.length <= policy.finalByteLimit) {
      return {
        ...normalized,
        originalByteLength: input.length,
        originalWidth: originalDimensions.width,
        originalHeight: originalDimensions.height,
        resized: false,
        diagnostics: [],
      };
    }
  }

  const outputType = oversizedOutputType(contentType);
  const hasTransparency = ['image/png', 'image/webp'].includes(contentType)
    ? await imageHasTransparency(input, contentType, policy, metadata)
    : false;
  if (!outputType) {
    throw new ProfileImageIngestionError(
      'image_too_large_after_normalization',
      'The image remains over the final 15 MiB limit after safe normalization.',
      {
        originalBytes: input.length,
        originalWidth: originalDimensions.width,
        originalHeight: originalDimensions.height,
        originalMime: contentType,
      },
    );
  }

  let attempts = 0;
  let lastAttempt = null;
  for (const quality of policy.qualityStages) {
    attempts += 1;
    lastAttempt = await encodeOversizedAttempt({
      input,
      inputType: contentType,
      outputType,
      quality,
      dimensions: null,
      policy,
    });
    if (lastAttempt.bytes.length <= policy.finalByteLimit) {
      return successfulOversizedResult({
        input,
        inputType: contentType,
        originalDimensions,
        normalized: lastAttempt,
        hasTransparency,
        resized: false,
        attempts,
      });
    }
  }

  const compressionQuality = policy.qualityStages.at(-1);
  const originalLongEdge = Math.max(originalDimensions.width, originalDimensions.height);
  const attemptedLongEdges = new Set();
  for (const scale of policy.resizeScales) {
    const targetLongEdge = Math.max(policy.minLongEdge, Math.floor(originalLongEdge * scale));
    if (targetLongEdge >= originalLongEdge || attemptedLongEdges.has(targetLongEdge)) continue;
    attemptedLongEdges.add(targetLongEdge);
    const resizeRatio = targetLongEdge / originalLongEdge;
    const dimensions = {
      width: Math.max(1, Math.round(originalDimensions.width * resizeRatio)),
      height: Math.max(1, Math.round(originalDimensions.height * resizeRatio)),
    };
    attempts += 1;
    lastAttempt = await encodeOversizedAttempt({
      input,
      inputType: contentType,
      outputType,
      quality: compressionQuality,
      dimensions,
      policy,
    });
    if (lastAttempt.bytes.length <= policy.finalByteLimit) {
      return successfulOversizedResult({
        input,
        inputType: contentType,
        originalDimensions,
        normalized: lastAttempt,
        hasTransparency,
        resized: true,
        attempts,
      });
    }
  }

  const finalDetails = {
    originalBytes: input.length,
    finalBytes: lastAttempt?.bytes.length || input.length,
    originalWidth: originalDimensions.width,
    originalHeight: originalDimensions.height,
    finalWidth: lastAttempt?.width || originalDimensions.width,
    finalHeight: lastAttempt?.height || originalDimensions.height,
    finalMime: lastAttempt?.contentType || contentType,
    attempts,
  };
  throw new ProfileImageIngestionError(
    'image_too_large_after_normalization',
    'The image remains over the final 15 MiB limit after safe normalization.',
    finalDetails,
  );
}

export async function generateProfileImageAssets(bytes, options = {}) {
  const normalized = await normalizeProfileImage(bytes, options.normalizationOptions || {});
  return generateProfileImageAssetsFromNormalized(normalized, options);
}

export async function rotateImage(bytes, contentType, degrees) {
  const angle = Number(degrees);
  if (![90, 180, 270].includes(angle)) throw new Error('Image rotation must be 90, 180, or 270 degrees.');
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const image = sharp(input, { failOn: 'error', animated: contentType === 'image/gif' });
  await image.metadata();
  return encodeOrientedImage(image.rotate(angle), contentType);
}

export async function validatedImageFromResponse(response, options = {}) {
  if (!response?.ok) {
    throw new ProfileImageIngestionError('permission_fetch_failure', 'The Drive image did not return a successful response.');
  }
  const policy = normalizationPolicy(options);
  const statedLength = Number(response.headers.get('content-length') || 0);
  if (statedLength > policy.inputByteLimit) {
    throw new ProfileImageIngestionError('image_input_too_large', 'The image exceeds the 50 MiB safe normalization input limit.');
  }

  const chunks = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > policy.inputByteLimit) {
        await reader.cancel('Profile image exceeded the ingestion size limit.').catch(() => {});
        throw new ProfileImageIngestionError('image_input_too_large', 'The image exceeds the 50 MiB safe normalization input limit.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks, received);
  if (!bytes.length) throw new ProfileImageIngestionError('corrupt_image', 'The downloaded image was empty.');
  try {
    return await normalizeProfileImage(bytes, policy);
  } catch (error) {
    if (error instanceof ProfileImageIngestionError) throw error;
    throw new ProfileImageIngestionError('corrupt_image', 'The image could not be decoded or orientation-normalized safely.');
  }
}

function rejectedImage(file, category, detail, metrics = {}) {
  const { category: ignoredCategory, detail: ignoredDetail, ...safeMetrics } = metrics;
  return {
    driveFileId: String(file?.id || file?.resolvedDriveFileId || ''),
    name: String(file?.name || ''),
    category,
    detail,
    ...safeMetrics,
  };
}

function imageDiagnostic(file, category, detail, metrics = {}) {
  const { category: ignoredCategory, detail: ignoredDetail, ...safeMetrics } = metrics;
  return {
    driveFileId: String(file?.id || ''),
    name: String(file?.name || ''),
    category,
    detail,
    ...safeMetrics,
  };
}

function replacementThumbnailIsAcceptable(image) {
  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);
  return Math.max(width, height) >= MIN_REPLACEMENT_FALLBACK_LONG_EDGE
    && Math.min(width, height) >= MIN_REPLACEMENT_FALLBACK_SHORT_EDGE;
}

async function driveGalleryCandidates(profile, driveAuth, driveClient) {
  if (!profile.driveFolderId) {
    return {
      sourceKind: 'file',
      filesDiscovered: 1,
      candidates: [{ id: profile.driveFileId, name: '', mimeType: '' }],
      rejected: [],
    };
  }

  let files;
  try {
    const listFiles = driveClient.listFilesInFolder || driveClient.listImageFilesInFolder;
    files = await listFiles(profile.driveFolderId, driveAuth);
  } catch (error) {
    throw new ProfileImageIngestionError(
      'folder_inaccessible',
      error?.message || 'The Drive folder could not be read. Confirm that anyone with the link can view it.',
    );
  }
  const candidates = [];
  const rejected = [];
  for (const file of files || []) {
    const mimeType = String(file?.mimeType || '').toLowerCase();
    if (!SUPPORTED_DRIVE_IMAGE_MIME_TYPES.has(mimeType)) {
      rejected.push(rejectedImage(
        file,
        'unsupported_file_type',
        `Ignored Drive item with MIME type ${mimeType || 'unknown'}.`,
        { mimeType },
      ));
      continue;
    }
    candidates.push(file);
  }
  return {
    sourceKind: 'folder',
    filesDiscovered: (files || []).length,
    candidates: candidates.sort(compareDriveFilesNaturally),
    rejected,
  };
}

/**
 * Validate and optionally upload every supported direct child in a Drive
 * folder. All candidates use the same byte sniffing and Sharp normalization
 * path as Admin uploads. Failures remain per-image so healthy siblings survive.
 */
export async function ingestProfileImages({
  profile,
  datasetSlug,
  driveAuth,
  dryRun,
  upload,
  remove,
  requireAllSupported = false,
  normalizationOptions = {},
  createImageId = randomUUID,
  driveClient = { fetchDriveImage, listFilesInFolder },
}) {
  const source = classifyProfileImageSource(profile);
  if (!source.eligible) throw new ProfileImageIngestionError(source.category, source.detail);
  const gallery = await driveGalleryCandidates(profile, driveAuth, driveClient);
  const stagedImages = [];
  const images = [];
  const rejected = [...gallery.rejected];
  const diagnostics = [];
  const policy = normalizationPolicy(normalizationOptions);

  for (const candidate of gallery.candidates) {
    if (Number(candidate.size || 0) > policy.inputByteLimit) {
      rejected.push(rejectedImage(candidate, 'image_input_too_large', 'The Drive image exceeds the safe normalization input limit.'));
      continue;
    }
    let response;
    try {
      response = await driveClient.fetchDriveImage(candidate.id, driveAuth);
    } catch (error) {
      rejected.push(rejectedImage(
        candidate,
        error?.code || 'drive_download_failure',
        error?.message || 'The Drive image download failed.',
        error?.details,
      ));
      continue;
    }
    if (!response) {
      rejected.push(rejectedImage(candidate, 'drive_download_failure', 'The Drive image is unavailable to the migration account.'));
      continue;
    }

    let normalized;
    const downloadSource = String(response.headers.get('x-drive-download-source') || 'unspecified');
    try {
      normalized = await validatedImageFromResponse(response, policy);
    } catch (error) {
      const category = error?.code === 'unsupported_file_type'
        && SUPPORTED_DRIVE_IMAGE_MIME_TYPES.has(String(candidate.mimeType || '').toLowerCase())
        ? 'corrupt_image'
        : error?.code || 'corrupt_image';
      rejected.push(rejectedImage(
        candidate,
        category,
        error?.message || 'The Drive image could not be validated.',
        error?.details,
      ));
      continue;
    }

    if (downloadSource === 'thumbnail_fallback') {
      diagnostics.push(imageDiagnostic(
        candidate,
        'thumbnail_fallback_used',
        'Original/full-file download attempts failed; a Google thumbnail rendition was used as a last resort.',
      ));
      if (requireAllSupported && !replacementThumbnailIsAcceptable(normalized)) {
        const qualityMetrics = {
          width: normalized.width,
          height: normalized.height,
          byteLength: normalized.bytes.length,
          downloadSource,
        };
        rejected.push(rejectedImage(
          candidate,
          'thumbnail_too_small_for_replacement',
          `The only available fallback was ${normalized.width}x${normalized.height}; replacement thumbnails must have a ${MIN_REPLACEMENT_FALLBACK_LONG_EDGE}px long edge and ${MIN_REPLACEMENT_FALLBACK_SHORT_EDGE}px short edge.`,
          qualityMetrics,
        ));
        diagnostics.push(imageDiagnostic(
          candidate,
          'thumbnail_fallback_rejected_for_replacement',
          'A tiny thumbnail was not treated as equivalent to original media for transactional replacement.',
          qualityMetrics,
        ));
        continue;
      }
    }
    diagnostics.push(...(normalized.diagnostics || []).map((diagnostic) => imageDiagnostic(
      candidate,
      diagnostic.category,
      diagnostic.detail,
      diagnostic,
    )));

    let assets;
    try {
      assets = await generateProfileImageAssetsFromNormalized(normalized);
    } catch (error) {
      rejected.push(rejectedImage(
        candidate,
        error?.code || 'derivative_failure',
        error?.message || 'The public image variants could not be generated.',
        error?.details,
      ));
      continue;
    }

    const imageId = createImageId();
    const storagePath = buildProfileImageStoragePath(
      datasetSlug,
      profile.id,
      imageId,
      assets.canonical.contentType,
    );
    const discoveryStoragePath = buildDiscoveryDerivativeStoragePath(datasetSlug, profile.id, imageId);
    stagedImages.push({
      imageId,
      storagePath,
      discoveryStoragePath,
      contentType: assets.canonical.contentType,
      byteLength: assets.canonical.byteLength,
      width: assets.canonical.width,
      height: assets.canonical.height,
      discoveryWidth: assets.discovery.width,
      discoveryHeight: assets.discovery.height,
      discoveryMimeType: assets.discovery.contentType,
      discoveryByteLength: assets.discovery.byteLength,
      originalByteLength: assets.originalByteLength,
      originalWidth: assets.originalWidth,
      originalHeight: assets.originalHeight,
      downloadSource,
      resolvedDriveFileId: candidate.id,
      name: String(candidate.name || ''),
      bytes: assets.canonical.bytes,
      discoveryBytes: assets.discovery.bytes,
    });
  }

  const allSupportedValidated = stagedImages.length === gallery.candidates.length;
  if (!dryRun && (!requireAllSupported || allSupportedValidated)) {
    for (const staged of stagedImages) {
      if (typeof upload !== 'function') throw new Error('A Storage upload function is required outside dry-run mode.');
      const uploadedPaths = [];
      try {
        await upload({
          storagePath: staged.storagePath,
          bytes: staged.bytes,
          contentType: staged.contentType,
        });
        uploadedPaths.push(staged.storagePath);
        await upload({
          storagePath: staged.discoveryStoragePath,
          bytes: staged.discoveryBytes,
          contentType: staged.discoveryMimeType,
        });
        uploadedPaths.push(staged.discoveryStoragePath);
      } catch (error) {
        if (typeof remove === 'function') {
          for (const uploadedPath of uploadedPaths) await remove(uploadedPath).catch(() => {});
        }
        rejected.push(rejectedImage(staged, 'supabase_upload_failure', error?.message || 'Supabase Storage upload failed.'));
        continue;
      }
      const { bytes, discoveryBytes, ...image } = staged;
      images.push(image);
    }
  } else if (dryRun) {
    images.push(...stagedImages.map(({ bytes, discoveryBytes, ...image }) => image));
  }

  return {
    sourceKind: gallery.sourceKind,
    filesDiscovered: gallery.filesDiscovered,
    supportedImages: gallery.candidates.length,
    uploaded: dryRun ? 0 : images.length,
    allSupportedValidated,
    images,
    rejected,
    diagnostics,
  };
}

function authFailureCategory(driveAuth) {
  if (driveAuth?.authenticated || driveAuth?.accessToken) return 'permission_denied_after_auth';
  if (driveAuth?.apiKey) return 'permission_fetch_failure';
  return 'credentials_missing';
}

async function downloadApprovedDriveImage(profile, driveAuth, driveClient, normalizationOptions = {}) {
  let fileId = profile.driveFileId || '';
  if (profile.driveFolderId) {
    let candidates;
    try {
      candidates = await driveClient.listImageFilesInFolder(profile.driveFolderId, driveAuth);
    } catch (error) {
      const category = authFailureCategory(driveAuth) === 'credentials_missing'
        ? 'credentials_missing'
        : 'folder_inaccessible';
      throw new ProfileImageIngestionError(category, error.message || 'The Drive folder could not be searched.');
    }
    const validCandidates = [];
    let inaccessibleCandidates = 0;
    for (const candidate of candidates || []) {
      let response;
      try {
        response = await driveClient.fetchDriveImage(candidate.id, driveAuth);
      } catch (error) {
        // A candidate that cannot be downloaded is inaccessible; continue so
        // one permission failure does not hide a valid sibling.
        inaccessibleCandidates += 1;
        continue;
      }
      if (!response) {
        inaccessibleCandidates += 1;
        continue;
      }
      try {
        const image = await validatedImageFromResponse(response, normalizationOptions);
        validCandidates.push({
          ...image,
          fileId: candidate.id,
          name: String(candidate.name || ''),
          downloadSource: String(response.headers.get('x-drive-download-source') || 'unspecified'),
        });
      } catch (error) {
        // Corrupt, unsupported, or oversized bytes are explicit non-image
        // candidates rather than permission failures.
      }
    }
    if (validCandidates.length === 0) {
      if (candidates.length && inaccessibleCandidates === candidates.length) {
        throw new ProfileImageIngestionError(
          authFailureCategory(driveAuth),
          'The Drive folder is visible, but its image files are not accessible to the migration account.',
        );
      }
      throw new ProfileImageIngestionError('folder_no_image', 'The Drive folder contains no accessible valid supported image.');
    }
    if (validCandidates.length > 1) {
      const names = validCandidates.map((candidate) => candidate.name).filter(Boolean);
      const suffix = names.length ? ` Candidates: ${names.slice(0, 5).join(', ')}` : '';
      const error = new ProfileImageIngestionError(
        'folder_multiple_images',
        `The Drive folder contains ${validCandidates.length} valid images; no image was selected.${suffix}`,
      );
      error.candidateCount = validCandidates.length;
      throw error;
    }
    return {
      bytes: validCandidates[0].bytes,
      contentType: validCandidates[0].contentType,
      resolvedDriveFileId: validCandidates[0].fileId,
      recoveryCategory: 'folder_single_image',
      width: validCandidates[0].width,
      height: validCandidates[0].height,
      originalByteLength: validCandidates[0].originalByteLength,
      originalWidth: validCandidates[0].originalWidth,
      originalHeight: validCandidates[0].originalHeight,
      diagnostics: validCandidates[0].diagnostics || [],
      downloadSource: validCandidates[0].downloadSource,
    };
  }

  try {
    const response = await driveClient.fetchDriveImage(fileId, driveAuth);
    if (!response) {
      throw new ProfileImageIngestionError(authFailureCategory(driveAuth), 'The Drive image is unavailable or not shared with the migration account.');
    }
    const validated = await validatedImageFromResponse(response, normalizationOptions);
    return {
      ...validated,
      resolvedDriveFileId: fileId,
      recoveryCategory: driveAuth?.authenticated || driveAuth?.accessToken
        ? 'authenticated_file'
        : 'public_file',
      downloadSource: String(response.headers.get('x-drive-download-source') || 'unspecified'),
    };
  } catch (error) {
    if (error instanceof ProfileImageIngestionError) throw error;
    if (error?.code) {
      throw new ProfileImageIngestionError(error.code, error.message, error.details);
    }
    const message = error instanceof Error ? error.message : String(error);
    const category = /not an image/i.test(message) ? 'unsupported_content' : authFailureCategory(driveAuth);
    throw new ProfileImageIngestionError(category, message);
  }
}

export async function ingestProfileImage({
  profile,
  datasetSlug,
  driveAuth,
  dryRun,
  upload,
  normalizationOptions = {},
  driveClient = { fetchDriveImage, listImageFilesInFolder },
}) {
  const source = classifyProfileImageSource(profile);
  if (!source.eligible) throw new ProfileImageIngestionError(source.category, source.detail);
  const image = await downloadApprovedDriveImage(profile, driveAuth, driveClient, normalizationOptions);
  const storagePath = buildPrimaryStoragePath(datasetSlug, profile.id, image.contentType);

  if (!dryRun) {
    if (typeof upload !== 'function') throw new Error('A Storage upload function is required outside dry-run mode.');
    await upload({
      storagePath,
      bytes: image.bytes,
      contentType: image.contentType,
    });
  }

  return {
    storagePath,
    contentType: image.contentType,
    byteLength: image.bytes.length,
    originalByteLength: image.originalByteLength,
    width: image.width,
    height: image.height,
    originalWidth: image.originalWidth,
    originalHeight: image.originalHeight,
    downloadSource: image.downloadSource,
    diagnostics: [
      ...(image.diagnostics || []),
      ...(image.downloadSource === 'thumbnail_fallback' ? [{
        driveFileId: image.resolvedDriveFileId,
        name: '',
        category: 'thumbnail_fallback_used',
        detail: 'Original/full-file download attempts failed; a Google thumbnail rendition was used as a last resort.',
      }] : []),
    ],
    resolvedDriveFileId: image.resolvedDriveFileId,
    recoveryCategory: image.recoveryCategory,
  };
}
