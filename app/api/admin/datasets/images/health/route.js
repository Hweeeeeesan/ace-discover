import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import {
  getDatasetImageSourceHealth,
  getProfileImageSourceHealth,
} from '../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '');
    return Response.json(profileId
      ? await getProfileImageSourceHealth(datasetId, profileId)
      : await getDatasetImageSourceHealth(datasetId));
  } catch (error) {
    return Response.json({ error: error.message || 'Image source health could not be checked.' }, { status: 422 });
  }
}
