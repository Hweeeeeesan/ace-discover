import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { revalidatePublicDiscovery } from '../../../../../../../lib/datasets/revalidation';
import { applyExplicitProfileImageRestoration } from '../../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    if (body?.confirm !== true) {
      return Response.json({ error: 'Explicit restoration confirmation is required.' }, { status: 400 });
    }
    const result = await applyExplicitProfileImageRestoration(
      String(body?.datasetId || ''),
      String(body?.profileId || ''),
      Array.isArray(body?.driveFileIds) ? body.driveFileIds : [],
    );
    revalidatePublicDiscovery();
    revalidatePath(`/profile/${encodeURIComponent(result.dataset.slug)}/${encodeURIComponent(result.profile.id)}`);
    revalidatePath(`/admin/preview/${encodeURIComponent(result.dataset.id)}/${encodeURIComponent(result.profile.id)}`);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message || 'The selected source image could not be restored.' }, { status: 422 });
  }
}
