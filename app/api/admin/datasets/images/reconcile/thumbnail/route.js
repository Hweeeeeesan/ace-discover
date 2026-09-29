import { authorizeAdminReadRequest } from '../../../../../../../lib/admin/authorization';
import { renderAdminDriveThumbnail } from '../../../../../../../lib/admin-drive-thumbnail';
import { fetchDriveThumbnail, getDriveAuth } from '../../../../../../../lib/google-drive-server';
import { getDriveReconciliationThumbnailContext } from '../../../../../../../lib/profile-image-reconciliation-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  const authorization = await authorizeAdminReadRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const url = new URL(request.url);
    const datasetId = String(url.searchParams.get('datasetId') || '');
    const profileId = String(url.searchParams.get('profileId') || '');
    const driveFileId = String(url.searchParams.get('driveFileId') || '');
    const driveAuth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
    const { file } = await getDriveReconciliationThumbnailContext(datasetId, profileId, driveFileId, { driveAuth });
    const response = await fetchDriveThumbnail(driveFileId, driveAuth, file);
    return renderAdminDriveThumbnail(response);
  } catch (error) {
    return Response.json({ error: error.message || 'Drive thumbnail could not be loaded.' }, {
      status: 422,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
}
