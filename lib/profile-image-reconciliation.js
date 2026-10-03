import { SUPPORTED_PROFILE_IMAGE_MIME_TYPES } from './profile-image-constraints.js';

export const PROFILE_IMAGE_SOURCE_TYPES = Object.freeze({
  GOOGLE_DRIVE: 'google_drive',
  ADMIN_UPLOAD: 'admin_upload',
  LEGACY_UNKNOWN: 'legacy_unknown',
  LEGACY_PRESERVED: 'legacy_preserved',
});

export const IMAGE_DIFFERENCE_STATUSES = Object.freeze({
  NEW_IN_DRIVE: 'new_in_drive',
  MISSING_FROM_DRIVE: 'missing_from_drive',
  COUNT_MISMATCH: 'count_mismatch',
  LEGACY_REVIEW: 'legacy_review',
  SOURCE_ERROR: 'source_error',
  UP_TO_DATE: 'up_to_date',
});

const SUPPORTED_MIME_TYPES = new Set(SUPPORTED_PROFILE_IMAGE_MIME_TYPES);

function normalizedFile(file = {}) {
  return {
    id: String(file.id || ''),
    name: String(file.name || ''),
    mimeType: String(file.mimeType || '').toLowerCase(),
    size: Number(file.size || 0),
    modifiedTime: file.modifiedTime || null,
  };
}

function normalizedImage(image = {}) {
  return {
    id: String(image.id || ''),
    position: Number(image.position || 0),
    isPrimary: image.isPrimary === true,
    sourceType: String(image.sourceType || PROFILE_IMAGE_SOURCE_TYPES.LEGACY_UNKNOWN),
    sourceDriveFileId: String(image.sourceDriveFileId || ''),
    sourceDriveFolderId: String(image.sourceDriveFolderId || ''),
    sourceFilename: String(image.sourceFilename || ''),
    sourceModifiedTime: image.sourceModifiedTime || null,
    sourceSize: Number(image.sourceSize || 0),
  };
}

export function classifyDriveImageReconciliation({ profile = {}, driveFiles = [] } = {}) {
  const images = (profile.profileImages || []).map(normalizedImage);
  const files = driveFiles.map(normalizedFile);
  const supportedFiles = files.filter((file) => SUPPORTED_MIME_TYPES.has(file.mimeType));
  const unsupportedFiles = files.filter((file) => !SUPPORTED_MIME_TYPES.has(file.mimeType));
  const knownByDriveId = new Map(images
    .filter((image) => image.sourceType === PROFILE_IMAGE_SOURCE_TYPES.GOOGLE_DRIVE && image.sourceDriveFileId)
    .map((image) => [image.sourceDriveFileId, image]));
  const supportedById = new Map(supportedFiles.map((file) => [file.id, file]));
  const legacyImages = images.filter((image) => image.sourceType === PROFILE_IMAGE_SOURCE_TYPES.LEGACY_UNKNOWN);
  const knownFiles = supportedFiles.filter((file) => knownByDriveId.has(file.id));
  const unlinkedDriveFiles = supportedFiles.filter((file) => !knownByDriveId.has(file.id));
  const missingFromDrive = [...knownByDriveId.entries()]
    .filter(([driveFileId]) => !supportedById.has(driveFileId))
    .map(([driveFileId, image]) => ({ driveFileId, image }));

  let state = 'up_to_date';
  if (profile.imageClearedByAdmin === true) state = 'intentionally_cleared';
  else if (profile.driveFileId && !profile.driveFolderId) {
    const trackedDirectFiles = images.filter((image) => (
      image.sourceType === PROFILE_IMAGE_SOURCE_TYPES.GOOGLE_DRIVE && image.sourceDriveFileId
    ));
    if (legacyImages.length || trackedDirectFiles.length === 0) state = 'direct_file_review';
    else if (trackedDirectFiles.some((image) => image.sourceDriveFileId === profile.driveFileId)) state = 'direct_file_up_to_date';
    else state = 'direct_file_changed';
  }
  else if (!profile.driveFolderId) state = 'no_folder_source';
  else if (legacyImages.length) state = 'legacy_review';
  else if (unlinkedDriveFiles.length) state = 'new_images';
  else if (unsupportedFiles.length) state = 'unsupported_files';

  return {
    state,
    existingCount: images.length,
    knownCount: knownFiles.length,
    legacyCount: legacyImages.length,
    supportedCount: supportedFiles.length,
    unsupportedCount: unsupportedFiles.length,
    newCount: state === 'new_images' ? unlinkedDriveFiles.length : 0,
    missingFromDriveCount: missingFromDrive.length,
    images,
    legacyImages,
    knownFiles,
    unlinkedDriveFiles,
    newCandidates: state === 'new_images' ? unlinkedDriveFiles : [],
    unsupportedFiles,
    missingFromDrive,
  };
}

/**
 * Project the detailed reconciliation result into the small, stable status
 * vocabulary used by the Admin profile list. Legacy rows intentionally take
 * precedence over unmatched Drive IDs: without provenance, those IDs cannot
 * safely be called new.
 */
export function imageDifferenceStatus(result = {}) {
  if (result.state === 'direct_file_changed' || result.state === 'direct_file_review'
    || result.state === 'intentionally_cleared') {
    return IMAGE_DIFFERENCE_STATUSES.SOURCE_ERROR;
  }
  if (result.legacyCount > 0) {
    return result.supportedCount !== result.existingCount
      ? IMAGE_DIFFERENCE_STATUSES.COUNT_MISMATCH
      : IMAGE_DIFFERENCE_STATUSES.LEGACY_REVIEW;
  }
  if (result.missingFromDriveCount > 0) return IMAGE_DIFFERENCE_STATUSES.MISSING_FROM_DRIVE;
  if (result.newCount > 0) return IMAGE_DIFFERENCE_STATUSES.NEW_IN_DRIVE;
  return IMAGE_DIFFERENCE_STATUSES.UP_TO_DATE;
}

export function reconciliationStatusCopy(result) {
  switch (result?.state) {
    case 'new_images':
      return {
        label: `${result.newCount} new Drive image${result.newCount === 1 ? '' : 's'} found`,
        summary: 'Existing gallery images will be preserved. New images can be appended after review.',
      };
    case 'legacy_review':
      return {
        label: 'Legacy gallery requires identity review',
        summary: 'Existing gallery predates Drive source tracking. Review required before new images can be identified safely.',
      };
    case 'intentionally_cleared':
      return {
        label: 'Admin cleared',
        summary: 'Drive files may be available, but reconciliation cannot restore an intentionally cleared gallery.',
      };
    case 'direct_file_review':
      return {
        label: 'Replacement review required',
        summary: 'This profile uses one untracked Drive file. Confirm source identity before any explicit replacement.',
      };
    case 'direct_file_changed':
      return {
        label: 'Source image changed — replacement review required',
        summary: 'The profile now references a different Drive file. Append reconciliation is not used for single-file sources.',
      };
    case 'direct_file_up_to_date':
      return { label: 'Source image is up to date', summary: 'The tracked single Drive file already belongs to this gallery.' };
    case 'no_folder_source':
      return { label: 'No Drive folder', summary: 'This profile does not have a Drive folder to reconcile.' };
    case 'unsupported_files':
      return {
        label: 'Gallery up to date',
        summary: `No new supported images were found. ${result.unsupportedCount} unsupported file${result.unsupportedCount === 1 ? ' was' : 's were'} ignored.`,
      };
    default:
      return { label: 'Gallery up to date', summary: 'Every tracked Drive image is already represented in the gallery.' };
  }
}

export function driveAppendPayload(image) {
  return {
    imageId: image.imageId,
    storagePath: image.storagePath,
    profileStoragePath: image.profileStoragePath,
    profileWidth: image.profileWidth,
    profileHeight: image.profileHeight,
    profileMimeType: image.profileMimeType,
    profileByteLength: image.profileByteLength,
    discoveryStoragePath: image.discoveryStoragePath,
    discoveryWidth: image.discoveryWidth,
    discoveryHeight: image.discoveryHeight,
    discoveryMimeType: image.discoveryMimeType,
    discoveryByteLength: image.discoveryByteLength,
    driveFileId: image.resolvedDriveFileId,
    sourceFilename: image.name || '',
    sourceModifiedTime: image.sourceModifiedTime || null,
    sourceSize: image.sourceSize || null,
  };
}

export function driveImageAssetPaths(images = []) {
  return images.flatMap((image) => [
    image.storagePath,
    image.profileStoragePath,
    image.discoveryStoragePath,
  ]).filter(Boolean);
}

export async function commitDriveImageAppend({ images, append, confirm, cleanup }) {
  let data;
  try {
    data = await append(images.map(driveAppendPayload));
  } catch (error) {
    let confirmedImages;
    try {
      confirmedImages = await confirm(images);
    } catch (confirmationError) {
      const uncertain = new Error(`Append outcome could not be confirmed; staged objects were retained to avoid deleting active images. ${error.message}`);
      uncertain.preserveStagedObjects = true;
      uncertain.cause = confirmationError;
      throw uncertain;
    }
    if (confirmedImages.length === images.length) {
      return {
        appendedCount: confirmedImages.length,
        appendedImageIds: confirmedImages.map((image) => image.imageId),
        skippedDriveFileIds: [],
        confirmedAfterRpcProblem: true,
      };
    }
    if (confirmedImages.length) {
      const uncertain = new Error(`Append returned an inconsistent partial confirmation; staged objects were retained for safe review. ${error.message}`);
      uncertain.preserveStagedObjects = true;
      throw uncertain;
    }
    await cleanup(driveImageAssetPaths(images));
    throw error;
  }

  const appendedIds = new Set((data?.appendedImageIds || []).map(String));
  const unused = images.filter((image) => !appendedIds.has(String(image.imageId)));
  await cleanup(driveImageAssetPaths(unused));
  return {
    appendedCount: Number(data?.appendedCount || 0),
    appendedImageIds: [...appendedIds],
    skippedDriveFileIds: data?.skippedDriveFileIds || [],
  };
}
