import sharp from 'sharp';
import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { fetchDriveImage, getDriveAuth } from '../../../../../../../lib/google-drive-server';
import { validatedImageFromResponse } from '../../../../../../../lib/profile-image-ingestion';
import { getDriveReconciliationThumbnailContext } from '../../../../../../../lib/profile-image-reconciliation-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const url = new URL(request.url);
    const datasetId = String(url.searchParams.get('datasetId') || '');
    const profileId = String(url.searchParams.get('profileId') || '');
    const driveFileId = String(url.searchParams.get('driveFileId') || '');
    const driveAuth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
    await getDriveReconciliationThumbnailContext(datasetId, profileId, driveFileId, { driveAuth });
    const response = await fetchDriveImage(driveFileId, driveAuth);
    if (!response) throw new Error('Drive image could not be read.');
    const image = await validatedImageFromResponse(response);
    const bytes = await sharp(image.bytes)
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76, effort: 3 })
      .toBuffer();
    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, max-age=300',
        'Content-Length': String(bytes.length),
      },
    });
  } catch (error) {
    return Response.json({ error: error.message || 'Drive thumbnail could not be loaded.' }, { status: 422 });
  }
}
