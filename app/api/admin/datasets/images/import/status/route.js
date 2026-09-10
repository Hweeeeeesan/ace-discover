import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { getMissingProfileImageStatus } from '../../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    return Response.json(await getMissingProfileImageStatus(String(body?.datasetId || '')));
  } catch (error) {
    return Response.json({ error: error.message || 'Missing image status could not be loaded.' }, { status: 422 });
  }
}
