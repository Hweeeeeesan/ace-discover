import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { previewExplicitProfileImageRestoration } from '../../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    return Response.json(await previewExplicitProfileImageRestoration(
      String(body?.datasetId || ''),
      String(body?.profileId || ''),
    ));
  } catch (error) {
    return Response.json({ error: error.message || 'Image restoration preview failed.' }, { status: 422 });
  }
}
