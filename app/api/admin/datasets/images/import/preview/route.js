import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { previewMissingProfileImages } from '../../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    return Response.json(await previewMissingProfileImages(String(body?.datasetId || '')));
  } catch (error) {
    return Response.json({ error: error.message || 'Missing image preview failed.' }, { status: 422 });
  }
}
