import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { scanDatasetImageDifferences } from '../../../../../../../lib/profile-image-difference-scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    return Response.json(await scanDatasetImageDifferences(String(body?.datasetId || '')));
  } catch (error) {
    return Response.json({ error: error.message || 'Drive image difference scan failed.' }, { status: 422 });
  }
}
