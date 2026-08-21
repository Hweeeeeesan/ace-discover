import {
  fetchDriveImage,
  listImageFilesInFolder,
} from './google-drive-server.js';
import { buildPrimaryStoragePath } from './profile-images.js';
import sharp from 'sharp';

export const MAX_PROFILE_IMAGE_BYTES = 15 * 1024 * 1024;
const VALID_DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

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
    return { bytes: input, contentType };
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

  const normalized = await output.toBuffer();
  return {
    bytes: normalized,
    contentType: detectImageContentType(normalized) || contentType,
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
    throw new ProfileImageIngestionError('unsupported_content', 'The image exceeds the 15 MiB size limit.');
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
        throw new ProfileImageIngestionError('unsupported_content', 'The image exceeds the 15 MiB size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks, received);
  if (!bytes.length) throw new ProfileImageIngestionError('unsupported_content', 'The downloaded image was empty.');
  if (bytes.length > MAX_PROFILE_IMAGE_BYTES) {
    throw new ProfileImageIngestionError('unsupported_content', 'The image exceeds the 15 MiB size limit.');
  }
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    throw new ProfileImageIngestionError('unsupported_content', 'The downloaded content is not a supported JPEG, PNG, WebP, GIF, or AVIF image.');
  }
  try {
    const normalized = await normalizeImageOrientation(bytes, contentType);
    if (normalized.bytes.length > MAX_PROFILE_IMAGE_BYTES) {
      throw new ProfileImageIngestionError('unsupported_content', 'The normalized image exceeds the 15 MiB size limit.');
    }
    return normalized;
  } catch (error) {
    if (error instanceof ProfileImageIngestionError) throw error;
    throw new ProfileImageIngestionError('unsupported_content', 'The image could not be decoded or orientation-normalized safely.');
  }
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
        validCandidates.push({ ...image, fileId: candidate.id, name: String(candidate.name || '') });
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
    };
  }

  try {
    const response = await driveClient.fetchDriveImage(fileId, driveAuth);
    if (!response) {
      throw new ProfileImageIngestionError(authFailureCategory(driveAuth), 'The Drive image is unavailable or not shared with the migration account.');
    }
    return {
      ...(await validatedImageFromResponse(response)),
      resolvedDriveFileId: fileId,
      recoveryCategory: driveAuth?.authenticated || driveAuth?.accessToken
        ? 'authenticated_file'
        : 'public_file',
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
    resolvedDriveFileId: image.resolvedDriveFileId,
    recoveryCategory: image.recoveryCategory,
  };
}
