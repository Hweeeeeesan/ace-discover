import {
  classifyProfileImageSource,
  ingestProfileImages,
  MIN_REPLACEMENT_FALLBACK_LONG_EDGE,
  MIN_REPLACEMENT_FALLBACK_SHORT_EDGE,
} from './profile-image-ingestion.js';
import { isValidStorageImagePath, PROFILE_IMAGE_PLACEHOLDER } from './profile-images.js';

export const IMAGE_SOURCE_HEALTH_STATES = Object.freeze({
  READY: 'ready',
  NEEDS_IMPORT: 'needs_import',
  UNSUPPORTED_SOURCE: 'unsupported_source',
  DEGRADED_SOURCE: 'degraded_source',
  INACCESSIBLE: 'inaccessible',
  NORMALIZATION_REQUIRED: 'normalization_required',
  FAILED: 'failed',
  NO_SOURCE: 'no_source',
});

const STATE_LABELS = Object.freeze({
  ready: 'Ready',
  needs_import: 'Needs import',
  unsupported_source: 'Unsupported source',
  degraded_source: 'Degraded source',
  inaccessible: 'Inaccessible',
  normalization_required: 'Normalization required',
  failed: 'Failed',
  no_source: 'No source',
});

const INACCESSIBLE_CATEGORIES = new Set([
  'credentials_missing',
  'drive_download_failure',
  'folder_inaccessible',
  'permission_denied_after_auth',
  'permission_fetch_failure',
]);
const UNSUPPORTED_CATEGORIES = new Set([
  'google_document',
  'unsupported_content',
  'unsupported_file_type',
]);
const NORMALIZATION_CATEGORIES = new Set([
  'oversized_image_normalized',
  'oversized_image_resized',
  'oversized_png_converted_to_jpeg',
  'oversized_png_converted_to_webp',
]);

function relationalImages(profile) {
  return Array.isArray(profile?.profileImages) ? profile.profileImages : [];
}

function usableFallback(profile) {
  const candidates = [profile?.image, ...(Array.isArray(profile?.imageCandidates) ? profile.imageCandidates : [])];
  return candidates.find((candidate) => (
    typeof candidate === 'string'
    && candidate.length > 0
    && candidate !== PROFILE_IMAGE_PLACEHOLDER
  )) || '';
}

function displayedImageSource(profile, galleryCount) {
  if (galleryCount > 0) return { key: 'relational_gallery', label: 'Supabase relational gallery' };
  if (isValidStorageImagePath(profile?.storageImagePath)) {
    return { key: 'legacy_storage', label: 'Legacy Storage image' };
  }
  const fallback = usableFallback(profile);
  if (fallback.startsWith('/api/drive-image')) return { key: 'drive_fallback', label: 'Drive fallback' };
  if (fallback) return { key: 'fallback_image', label: 'Fallback image' };
  return { key: 'placeholder', label: 'Placeholder' };
}

function mimeLabel(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'application/pdf') return 'PDF';
  if (normalized === 'image/heic' || normalized === 'image/heif') return 'HEIC/HEIF';
  return normalized || '';
}

function diagnosticCategory(item) {
  return String(item?.category || '');
}

function firstMimeType(inspection) {
  const item = [...(inspection?.rejected || []), ...(inspection?.diagnostics || [])]
    .find((entry) => entry?.mimeType);
  return String(item?.mimeType || '').toLowerCase();
}

function driveSourceSummary(source, inspection) {
  const mimeType = firstMimeType(inspection);
  const kind = source?.kind || 'none';
  const kindLabel = kind === 'drive-folder' ? 'Folder' : kind === 'drive-file' ? 'File' : 'None';
  return {
    kind,
    label: mimeType ? `${kindLabel} · ${mimeLabel(mimeType)}` : kindLabel,
    mimeType,
  };
}

function dimensionsFor(image) {
  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);
  return width > 0 && height > 0 ? { width, height, label: `${width}×${height}` } : null;
}

function replacementThumbnailIsAcceptable(image) {
  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);
  return Math.max(width, height) >= MIN_REPLACEMENT_FALLBACK_LONG_EDGE
    && Math.min(width, height) >= MIN_REPLACEMENT_FALLBACK_SHORT_EDGE;
}

function result({
  profile,
  source,
  state,
  summary,
  detail,
  focalMessage,
  inspection = null,
  canPreviewImport = false,
  canImport = false,
  acceptableForReplacement = false,
}) {
  const galleryCount = relationalImages(profile).length;
  const dimensions = (inspection?.images || []).map(dimensionsFor).filter(Boolean);
  return {
    state,
    label: STATE_LABELS[state],
    summary,
    detail,
    focalMessage,
    displayedFrom: displayedImageSource(profile, galleryCount),
    storageGallery: {
      count: galleryCount,
      label: galleryCount ? `${galleryCount} relational image${galleryCount === 1 ? '' : 's'}` : 'None',
    },
    driveSource: driveSourceSummary(source, inspection),
    dimensions,
    imageCount: Number(inspection?.images?.length || galleryCount),
    canPreviewImport,
    canImport,
    acceptableForReplacement,
    normalizationRequired: state === IMAGE_SOURCE_HEALTH_STATES.NORMALIZATION_REQUIRED,
    diagnosticCategories: Array.from(new Set([
      ...(inspection?.diagnostics || []).map(diagnosticCategory),
      ...(inspection?.rejected || []).map(diagnosticCategory),
    ].filter(Boolean))),
  };
}

function unsupportedResult(profile, source, inspection, mimeType = '') {
  const sourceType = mimeType || firstMimeType(inspection);
  if (sourceType === 'application/pdf') {
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.UNSUPPORTED_SOURCE,
      summary: "This profile's Drive source is a PDF, not an image.",
      detail: 'Replace the source with JPG, PNG, WebP, GIF, or AVIF before importing.',
      focalMessage: 'Current Drive source is a PDF and cannot be imported as a profile image.',
    });
  }
  if (['image/heic', 'image/heif'].includes(sourceType)) {
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.UNSUPPORTED_SOURCE,
      summary: 'This profile uses an unsupported HEIC/HEIF source.',
      detail: 'Convert the source to JPG, PNG, WebP, GIF, or AVIF before importing.',
      focalMessage: 'Current Drive source is HEIC/HEIF and cannot be imported as a profile image.',
    });
  }
  return result({
    profile,
    source,
    inspection,
    state: IMAGE_SOURCE_HEALTH_STATES.UNSUPPORTED_SOURCE,
    summary: 'The current source is not a supported profile image.',
    detail: 'Replace it with JPG, PNG, WebP, GIF, or AVIF before importing.',
    focalMessage: 'Current source cannot be imported as a profile image.',
  });
}

export function classifyProfileImageHealth(profile = {}, inspection = null, inspectionError = null) {
  const galleryCount = relationalImages(profile).length;
  const source = classifyProfileImageSource(profile);
  if (galleryCount > 0) {
    return result({
      profile,
      source,
      state: IMAGE_SOURCE_HEALTH_STATES.READY,
      summary: 'The relational Storage gallery is authoritative.',
      detail: 'Drive source changes do not replace this gallery unless an Admin explicitly starts replacement.',
      focalMessage: 'Focal-point editing is available in the image manager below.',
      canPreviewImport: false,
      canImport: false,
      acceptableForReplacement: true,
    });
  }

  if (inspectionError) {
    const category = diagnosticCategory(inspectionError) || String(inspectionError?.code || '');
    if (UNSUPPORTED_CATEGORIES.has(category)) {
      return unsupportedResult(profile, source, {
        images: [],
        rejected: [{ category, mimeType: inspectionError?.details?.mimeType }],
        diagnostics: [],
      }, inspectionError?.details?.mimeType);
    }
    return result({
      profile,
      source,
      state: INACCESSIBLE_CATEGORIES.has(category)
        ? IMAGE_SOURCE_HEALTH_STATES.INACCESSIBLE
        : IMAGE_SOURCE_HEALTH_STATES.FAILED,
      summary: INACCESSIBLE_CATEGORIES.has(category)
        ? 'The Drive source could not be read by the image service.'
        : 'The source could not produce a valid profile image.',
      detail: 'Check sharing permissions and the source file, then re-check source health.',
      focalMessage: 'No editable Storage image yet. Fix the source before importing.',
    });
  }

  if (!source.eligible) {
    if (UNSUPPORTED_CATEGORIES.has(source.category)) {
      return unsupportedResult(profile, source, null);
    }
    if (isValidStorageImagePath(profile.storageImagePath)) {
      return result({
        profile,
        source,
        state: IMAGE_SOURCE_HEALTH_STATES.NEEDS_IMPORT,
        summary: 'A legacy Storage image is visible without relational gallery metadata.',
        detail: 'Add or import a relational Storage image before using focal-point controls.',
        focalMessage: 'No editable Storage image yet. The visible legacy image has no relational metadata.',
      });
    }
    return result({
      profile,
      source,
      state: IMAGE_SOURCE_HEALTH_STATES.NO_SOURCE,
      summary: usableFallback(profile)
        ? 'A fallback image is visible, but there is no usable Drive or relational Storage source.'
        : 'No usable Drive or relational Storage image source exists.',
      detail: 'Add a supported image to create an editable Storage gallery.',
      focalMessage: 'No editable Storage image yet. Add a supported image to enable focal-point editing.',
    });
  }

  const images = inspection?.images || [];
  const rejected = inspection?.rejected || [];
  const diagnostics = inspection?.diagnostics || [];
  const categories = new Set(rejected.map(diagnosticCategory));
  if (!images.length && [...categories].some((category) => UNSUPPORTED_CATEGORIES.has(category))) {
    return unsupportedResult(profile, source, inspection);
  }
  if (!images.length && [...categories].some((category) => INACCESSIBLE_CATEGORIES.has(category))) {
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.INACCESSIBLE,
      summary: 'The Drive item exists but could not be downloaded or read.',
      detail: 'Check ownership and sharing access, then re-check the source.',
      focalMessage: 'No editable Storage image yet. The Drive source is inaccessible.',
    });
  }
  if (!images.length) {
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.FAILED,
      summary: 'The source could not produce a valid profile image.',
      detail: rejected[0]?.detail || 'Replace or repair the source, then re-check it.',
      focalMessage: 'No editable Storage image yet. The current source failed image validation.',
    });
  }

  const thumbnailImages = images.filter((image) => image.downloadSource === 'thumbnail_fallback');
  if (thumbnailImages.length > 0) {
    const acceptableForReplacement = thumbnailImages.every(replacementThumbnailIsAcceptable);
    const size = dimensionsFor(thumbnailImages[0]);
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.DEGRADED_SOURCE,
      summary: `Only a Google thumbnail fallback is available${size ? ` (${size.label})` : ''}.`,
      detail: acceptableForReplacement
        ? 'The fallback is importable, but original media should be restored when possible.'
        : 'The fallback is too small for a safe gallery replacement. Fix or replace the Drive source first.',
      focalMessage: acceptableForReplacement
        ? 'Import this fallback to Storage to enable focal-point editing.'
        : 'Only a low-resolution thumbnail is available. Replace or fix the source before importing.',
      canPreviewImport: true,
      canImport: acceptableForReplacement,
      acceptableForReplacement,
    });
  }

  if (diagnostics.some((item) => NORMALIZATION_CATEGORIES.has(diagnosticCategory(item)))) {
    return result({
      profile,
      source,
      inspection,
      state: IMAGE_SOURCE_HEALTH_STATES.NORMALIZATION_REQUIRED,
      summary: `${images.length} supported image${images.length === 1 ? '' : 's'} can be imported after safe normalization.`,
      detail: 'The preview pipeline reduced oversized media under the final 15 MiB limit without uploading it.',
      focalMessage: 'Preview and import this image to Storage to enable focal-point editing.',
      canPreviewImport: true,
      canImport: true,
      acceptableForReplacement: rejected.length === 0,
    });
  }

  return result({
    profile,
    source,
    inspection,
    state: IMAGE_SOURCE_HEALTH_STATES.NEEDS_IMPORT,
    summary: `${images.length} valid Drive image${images.length === 1 ? '' : 's'} ${images.length === 1 ? 'is' : 'are'} ready to preview and import.`,
    detail: 'Importing creates the relational Storage gallery required for focal-point editing.',
    focalMessage: 'Import this image to Storage to enable focal-point editing.',
    canPreviewImport: true,
    canImport: true,
    acceptableForReplacement: rejected.length === 0,
  });
}

export async function inspectProfileImageHealth({
  profile,
  datasetSlug,
  driveAuth,
  driveAuthError = null,
  ingest = ingestProfileImages,
}) {
  const initial = classifyProfileImageHealth(profile);
  if (initial.state === IMAGE_SOURCE_HEALTH_STATES.READY || !classifyProfileImageSource(profile).eligible) {
    return initial;
  }
  if (driveAuthError) {
    return classifyProfileImageHealth(profile, null, {
      code: 'credentials_missing',
      details: {},
    });
  }
  try {
    const inspection = await ingest({
      profile,
      datasetSlug,
      driveAuth,
      dryRun: true,
      requireAllSupported: false,
    });
    return classifyProfileImageHealth(profile, inspection);
  } catch (error) {
    return classifyProfileImageHealth(profile, null, error);
  }
}

export function summarizeProfileImageHealth(profiles = []) {
  const counts = Object.fromEntries(Object.values(IMAGE_SOURCE_HEALTH_STATES).map((state) => [state, 0]));
  for (const profile of profiles) {
    if (Object.hasOwn(counts, profile.health.state)) counts[profile.health.state] += 1;
  }
  return {
    total: profiles.length,
    counts,
    profilesNeedingImport: counts.needs_import + counts.normalization_required + counts.degraded_source,
    issueCount: profiles.length - counts.ready,
  };
}

export function safeProfileImageHealth(profile, health) {
  return {
    id: String(profile?.id || ''),
    name: String(profile?.name || profile?.id || 'Unknown profile'),
    health,
  };
}
