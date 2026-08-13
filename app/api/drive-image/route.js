import {
  fetchDriveImage,
  getDriveAuth,
  proxyImageResponse,
  resolveImageFileFromFolder,
} from '../../../lib/google-drive-server.js';
import {
  allowedDriveFileIds,
  allowedDriveFolderIds,
} from '../../../lib/drive-image-allowlist.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

function readDriveId(searchParams, key) {
  const value = String(searchParams.get(key) || '').trim();
  return VALID_DRIVE_ID.test(value) ? value : '';
}

function isImportedSource(fileId, folderId) {
  if (fileId) return allowedDriveFileIds.has(fileId);
  if (folderId) return allowedDriveFolderIds.has(folderId);
  return false;
}

export async function GET(request) {
  const url = new URL(request.url);
  const fileId = readDriveId(url.searchParams, 'fileId');
  const folderId = readDriveId(url.searchParams, 'folderId');

  if ((!fileId && !folderId) || (fileId && folderId)) {
    return new Response('Provide exactly one valid fileId or folderId.', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // Do not turn this endpoint into a general-purpose proxy for every file the
  // configured Google account can access. Only sources imported into a profile
  // are eligible.
  if (!isImportedSource(fileId, folderId)) {
    return new Response('Image source not found.', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  try {
    const auth = await getDriveAuth();
    let resolvedFileId = fileId;
    const sourceLabel = folderId ? 'drive-folder' : 'drive-file';

    if (folderId) {
      if (!auth.accessToken && !auth.apiKey) {
        return new Response('Google Drive credentials are required to search a folder.', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      const file = await resolveImageFileFromFolder(folderId, auth);
      if (!file) {
        return new Response('No accessible image was found in this Google Drive folder.', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      resolvedFileId = file.id;
    }

    const image = await fetchDriveImage(resolvedFileId, auth);
    if (!image) {
      return new Response('The Google Drive image is unavailable or not shared with the app.', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return proxyImageResponse(image, sourceLabel);
  } catch (error) {
    console.warn('Google Drive image proxy error.', error);
    return new Response('The Google Drive image could not be loaded.', {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
