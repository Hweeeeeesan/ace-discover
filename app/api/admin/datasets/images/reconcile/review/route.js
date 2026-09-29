import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { reviewLegacyProfileImageProvenance } from '../../../../../../../lib/profile-image-reconciliation-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    if (body?.confirm !== true) {
      return Response.json({ error: 'Explicit confirmation is required.' }, { status: 400 });
    }
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '');
    const result = await reviewLegacyProfileImageProvenance({
      datasetId,
      profileId,
      imageId: String(body?.imageId || ''),
      driveFileId: String(body?.driveFileId || ''),
      preserveAsLegacy: body?.preserveAsLegacy === true,
    });
    revalidatePath(`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profileId)}`);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message || 'Drive identity review failed.' }, { status: 422 });
  }
}
