import sharp from 'sharp';
import {
  DISCOVERY_IMAGE_LONG_EDGE,
  DISCOVERY_IMAGE_WEBP_QUALITY,
  MAX_PROFILE_IMAGE_BYTES,
  MAX_PROFILE_IMAGE_PIXELS,
  PROFILE_DETAIL_LONG_EDGE,
  PROFILE_DETAIL_WEBP_QUALITY,
} from './profile-image-constraints.js';

export {
  DISCOVERY_IMAGE_LONG_EDGE,
  DISCOVERY_IMAGE_WEBP_QUALITY,
  PROFILE_DETAIL_LONG_EDGE,
  PROFILE_DETAIL_WEBP_QUALITY,
};

function derivativeError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'ProfileImageDerivativeError';
  error.code = code;
  error.details = details;
  return error;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function webpQuality(value, fallback) {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : fallback;
}

async function renderWebp(bytes, {
  longEdge,
  quality,
  maxInputPixels = MAX_PROFILE_IMAGE_PIXELS,
} = {}) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!input.length) throw derivativeError('corrupt_image', 'The image was empty.');

  const image = sharp(input, {
    failOn: 'error',
    animated: true,
    limitInputPixels: positiveInteger(maxInputPixels, MAX_PROFILE_IMAGE_PIXELS),
  }).autoOrient();
  const metadata = await image.metadata();
  const sourceWidth = Number(metadata.autoOrient?.width || metadata.width || 0);
  const sourceHeight = Number(metadata.autoOrient?.height || metadata.height || 0);
  if (!sourceWidth || !sourceHeight) {
    throw derivativeError('corrupt_image', 'The image dimensions could not be read.');
  }

  const targetLongEdge = positiveInteger(longEdge, DISCOVERY_IMAGE_LONG_EDGE);
  const isLandscape = sourceWidth >= sourceHeight;
  const { data, info } = await image
    .resize({
      width: isLandscape ? targetLongEdge : undefined,
      height: isLandscape ? undefined : targetLongEdge,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true,
    })
    .webp({
      quality: webpQuality(quality, DISCOVERY_IMAGE_WEBP_QUALITY),
      alphaQuality: 100,
      effort: 4,
      smartSubsample: true,
    })
    .toBuffer({ resolveWithObject: true });

  if (!data.length || data.length > MAX_PROFILE_IMAGE_BYTES) {
    throw derivativeError(
      'image_too_large_after_normalization',
      'The optimized public image exceeds the final 15 MiB limit.',
      { finalBytes: data.length, finalWidth: info.width, finalHeight: info.height },
    );
  }

  return {
    bytes: data,
    contentType: 'image/webp',
    width: info.width,
    height: info.height,
    byteLength: data.length,
    sourceWidth,
    sourceHeight,
  };
}

export async function generateDiscoveryDerivative(bytes, options = {}) {
  return renderWebp(bytes, {
    longEdge: positiveInteger(options.longEdge, DISCOVERY_IMAGE_LONG_EDGE),
    quality: webpQuality(options.quality, DISCOVERY_IMAGE_WEBP_QUALITY),
    maxInputPixels: options.maxInputPixels,
  });
}

/**
 * Build the two public assets for a newly ingested image. The source is first
 * validated/orientation-normalized by the canonical ingestion pipeline, then
 * both outputs are encoded deterministically from those normalized pixels.
 */
export async function generateProfileImageAssetsFromNormalized(normalized, options = {}) {
  if (!normalized?.bytes?.length) throw derivativeError('corrupt_image', 'Normalized image bytes are required.');
  const canonical = await renderWebp(normalized.bytes, {
    longEdge: positiveInteger(options.canonicalLongEdge, PROFILE_DETAIL_LONG_EDGE),
    quality: webpQuality(options.canonicalQuality, PROFILE_DETAIL_WEBP_QUALITY),
    maxInputPixels: options.maxInputPixels,
  });
  const discovery = await generateDiscoveryDerivative(canonical.bytes, {
    longEdge: positiveInteger(options.discoveryLongEdge, DISCOVERY_IMAGE_LONG_EDGE),
    quality: webpQuality(options.discoveryQuality, DISCOVERY_IMAGE_WEBP_QUALITY),
    maxInputPixels: options.maxInputPixels,
  });

  return {
    canonical,
    discovery,
    originalByteLength: normalized.originalByteLength,
    originalWidth: normalized.originalWidth,
    originalHeight: normalized.originalHeight,
    diagnostics: normalized.diagnostics || [],
  };
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(items.length, Math.max(1, positiveInteger(concurrency, 2))) },
    worker,
  ));
  return results;
}

/**
 * Adapter-driven backfill engine. Dry runs call only download/derive. Apply
 * mode uploads first, commits metadata second, and removes the staged object
 * if the metadata commit fails.
 */
export async function deriveMissingProfileImages({
  images,
  dryRun = true,
  concurrency = 2,
  download,
  upload,
  updateMetadata,
  remove,
  buildDerivativePath,
  derive = generateDiscoveryDerivative,
  onRow = () => {},
}) {
  if (!Array.isArray(images)) throw new Error('Profile images must be an array.');
  if (typeof download !== 'function') throw new Error('A canonical image downloader is required.');
  if (typeof buildDerivativePath !== 'function') throw new Error('A derivative path builder is required.');
  if (!dryRun && [upload, updateMetadata, remove].some((adapter) => typeof adapter !== 'function')) {
    throw new Error('Apply mode requires upload, metadata update, and cleanup adapters.');
  }

  const selected = images.filter((image) => !image.discoveryStoragePath);
  const alreadyDerived = images.length - selected.length;
  const results = await mapWithConcurrency(selected, concurrency, async (image) => {
    const base = {
      imageId: image.id,
      profileId: image.profileId,
      isPrimary: image.isPrimary === true,
      storagePath: image.storagePath,
    };
    if (image.imageClearedByAdmin === true) {
      return { ...base, status: 'skipped_intentionally_cleared' };
    }

    let derivativePath = '';
    try {
      const canonical = await download(image);
      const sourceBytes = Buffer.isBuffer(canonical) ? canonical : Buffer.from(canonical || []);
      const derivative = await derive(sourceBytes);
      derivativePath = buildDerivativePath(image);
      const row = {
        ...base,
        status: dryRun ? 'dry_run_derived' : 'derived',
        currentBytes: sourceBytes.length,
        currentWidth: derivative.sourceWidth,
        currentHeight: derivative.sourceHeight,
        discoveryStoragePath: derivativePath,
        discoveryWidth: derivative.width,
        discoveryHeight: derivative.height,
        discoveryMimeType: derivative.contentType,
        discoveryByteLength: derivative.byteLength,
      };

      if (!dryRun) {
        await upload({
          storagePath: derivativePath,
          bytes: derivative.bytes,
          contentType: derivative.contentType,
        });
        try {
          await updateMetadata({ image, derivativePath, derivative });
        } catch (error) {
          if (!error?.preserveStagedObject) {
            try {
              await remove(derivativePath);
            } catch (cleanupError) {
              error.cleanupError = cleanupError;
            }
          }
          throw error;
        }
      }
      return row;
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        derivativePath,
        category: error?.code || 'derivative_failure',
        detail: error?.message || String(error),
        cleanupFailed: Boolean(error?.cleanupError),
        stagedObjectPreserved: Boolean(error?.preserveStagedObject),
      };
    }
  });

  results.forEach(onRow);
  const successful = results.filter((row) => ['dry_run_derived', 'derived'].includes(row.status));
  const currentPrimaryBytes = successful
    .filter((row) => row.isPrimary)
    .reduce((total, row) => total + row.currentBytes, 0);
  const derivativePrimaryBytes = successful
    .filter((row) => row.isPrimary)
    .reduce((total, row) => total + row.discoveryByteLength, 0);
  return {
    rows: results,
    summary: {
      imagesScanned: images.length,
      alreadyDerived,
      imagesNeedingDerivative: selected.length,
      derived: successful.length,
      failures: results.filter((row) => row.status === 'failed').length,
      skippedIntentionallyCleared: results.filter((row) => row.status === 'skipped_intentionally_cleared').length,
      totalCurrentBytes: successful.reduce((total, row) => total + row.currentBytes, 0),
      totalDerivativeBytes: successful.reduce((total, row) => total + row.discoveryByteLength, 0),
      currentPrimaryBytes,
      derivativePrimaryBytes,
      primaryReductionPercent: currentPrimaryBytes > 0
        ? Math.round((1 - derivativePrimaryBytes / currentPrimaryBytes) * 1000) / 10
        : 0,
    },
  };
}
