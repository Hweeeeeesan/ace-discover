import {
  compareDriveFilesNaturally,
  fetchDriveImage,
  listFilesInFolder,
  listImageFilesInFolder,
} from './google-drive-server.js';
import { randomUUID } from 'node:crypto';
import {
  buildPrimaryStoragePath,
  buildProfileImageStoragePath,
} from './profile-images.js';
import sharp from 'sharp';

export const MAX_PROFILE_IMAGE_BYTES = 15 * 1024 * 1024;
const VALID_DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const SUPPORTED_DRIVE_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export class ProfileImageIngestionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileImageIngestionError';
    this.code = code;
  }
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
export async function normalizeImageOrientation(bytes, contentType) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const image = sharp(input, { failOn: 'error', animated: contentType === 'image/gif' });
  const metadata = await image.metadata();
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

export async function rotateImage(bytes, contentType, degrees) {
  const angle = Number(degrees);
  if (![90, 180, 270].includes(angle)) throw new Error('Image rotation must be 90, 180, or 270 degrees.');
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const image = sharp(input, { failOn: 'error', animated: contentType === 'image/gif' });
  await image.metadata();
  return encodeOrientedImage(image.rotate(angle), contentType);
}

export async function validatedImageFromResponse(response) {
  if (!response?.ok) {
    throw new ProfileImageIngestionError('permission_fetch_failure', 'The Drive image did not return a successful response.');
  }
  const statedLength = Number(response.headers.get('content-length') || 0);
  if (statedLength > MAX_PROFILE_IMAGE_BYTES) {
    throw new ProfileImageIngestionError('image_too_large', 'The image exceeds the 15 MiB size limit.');
  }

  const chunks = [];
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_PROFILE_IMAGE_BYTES) {
        await reader.cancel('Profile image exceeded the ingestion size limit.').catch(() => {});
        throw new ProfileImageIngestionError('image_too_large', 'The image exceeds the 15 MiB size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks, received);
  if (!bytes.length) throw new ProfileImageIngestionError('corrupt_image', 'The downloaded image was empty.');
  if (bytes.length > MAX_PROFILE_IMAGE_BYTES) {
    throw new ProfileImageIngestionError('image_too_large', 'The image exceeds the 15 MiB size limit.');
  }
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    throw new ProfileImageIngestionError('unsupported_file_type', 'The downloaded content is not a supported JPEG, PNG, WebP, GIF, or AVIF image.');
  }
  try {
    const normalized = await normalizeImageOrientation(bytes, contentType);
    if (normalized.bytes.length > MAX_PROFILE_IMAGE_BYTES) {
      throw new ProfileImageIngestionError('image_too_large', 'The normalized image exceeds the 15 MiB size limit.');
    }
    return normalized;
  } catch (error) {
    if (error instanceof ProfileImageIngestionError) throw error;
    throw new ProfileImageIngestionError('corrupt_image', 'The image could not be decoded or orientation-normalized safely.');
  }
}

function rejectedImage(file, category, detail) {
  return {
    driveFileId: String(file?.id || file?.resolvedDriveFileId || ''),
    name: String(file?.name || ''),
    category,
    detail,
  };
}

function imageDiagnostic(file, category, detail) {
  return {
    driveFileId: String(file?.id || ''),
    name: String(file?.name || ''),
    category,
    detail,
  };
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
      rejected.push(rejectedImage(file, 'unsupported_file_type', `Ignored Drive item with MIME type ${mimeType || 'unknown'}.`));
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
  requireAllSupported = false,
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

  for (const candidate of gallery.candidates) {
    if (Number(candidate.size || 0) > MAX_PROFILE_IMAGE_BYTES) {
      rejected.push(rejectedImage(candidate, 'image_too_large', 'The Drive image exceeds the 15 MiB size limit.'));
      continue;
    }
    let response;
    try {
      response = await driveClient.fetchDriveImage(candidate.id, driveAuth);
    } catch (error) {
      rejected.push(rejectedImage(candidate, 'drive_download_failure', error?.message || 'The Drive image download failed.'));
      continue;
    }
    if (!response) {
      rejected.push(rejectedImage(candidate, 'drive_download_failure', 'The Drive image is unavailable to the migration account.'));
      continue;
    }

    let normalized;
    const downloadSource = String(response.headers.get('x-drive-download-source') || 'unspecified');
    try {
      normalized = await validatedImageFromResponse(response);
    } catch (error) {
      const category = error?.code === 'unsupported_file_type'
        && SUPPORTED_DRIVE_IMAGE_MIME_TYPES.has(String(candidate.mimeType || '').toLowerCase())
        ? 'corrupt_image'
        : error?.code || 'corrupt_image';
      rejected.push(rejectedImage(
        candidate,
        category,
        error?.message || 'The Drive image could not be validated.',
      ));
      continue;
    }

    if (downloadSource === 'thumbnail_fallback') {
      diagnostics.push(imageDiagnostic(
        candidate,
        'thumbnail_fallback_used',
        'Original/full-file download attempts failed; a Google thumbnail rendition was used as a last resort.',
      ));
    }

    const imageId = createImageId();
    const storagePath = buildProfileImageStoragePath(
      datasetSlug,
      profile.id,
      imageId,
      normalized.contentType,
    );
    stagedImages.push({
      imageId,
      storagePath,
      contentType: normalized.contentType,
      byteLength: normalized.bytes.length,
      width: normalized.width,
      height: normalized.height,
      downloadSource,
      resolvedDriveFileId: candidate.id,
      name: String(candidate.name || ''),
      bytes: normalized.bytes,
    });
  }

  const allSupportedValidated = stagedImages.length === gallery.candidates.length;
  if (!dryRun && (!requireAllSupported || allSupportedValidated)) {
    for (const staged of stagedImages) {
      if (typeof upload !== 'function') throw new Error('A Storage upload function is required outside dry-run mode.');
      try {
        await upload({
          storagePath: staged.storagePath,
          bytes: staged.bytes,
          contentType: staged.contentType,
        });
      } catch (error) {
        rejected.push(rejectedImage(staged, 'supabase_upload_failure', error?.message || 'Supabase Storage upload failed.'));
        continue;
      }
      const { bytes, ...image } = staged;
      images.push(image);
    }
  } else if (dryRun) {
    images.push(...stagedImages.map(({ bytes, ...image }) => image));
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

async function downloadApprovedDriveImage(profile, driveAuth, driveClient) {
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
        const image = await validatedImageFromResponse(response);
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
      downloadSource: validCandidates[0].downloadSource,
    };
  }

  try {
    const response = await driveClient.fetchDriveImage(fileId, driveAuth);
    if (!response) {
      throw new ProfileImageIngestionError(authFailureCategory(driveAuth), 'The Drive image is unavailable or not shared with the migration account.');
    }
    const validated = await validatedImageFromResponse(response);
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
  driveClient = { fetchDriveImage, listImageFilesInFolder },
}) {
  const source = classifyProfileImageSource(profile);
  if (!source.eligible) throw new ProfileImageIngestionError(source.category, source.detail);
  const image = await downloadApprovedDriveImage(profile, driveAuth, driveClient);
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
    width: image.width,
    height: image.height,
    downloadSource: image.downloadSource,
    diagnostics: image.downloadSource === 'thumbnail_fallback'
      ? [{
        driveFileId: image.resolvedDriveFileId,
        name: '',
        category: 'thumbnail_fallback_used',
        detail: 'Original/full-file download attempts failed; a Google thumbnail rendition was used as a last resort.',
      }]
      : [],
    resolvedDriveFileId: image.resolvedDriveFileId,
    recoveryCategory: image.recoveryCategory,
  };
}
