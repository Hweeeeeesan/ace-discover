import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../../../lib/admin/authorization';
import { applyMissingProfileImages } from '../../../../../../../lib/profile-image-batch-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    if (body?.confirm !== true) {
      return Response.json({ error: 'Explicit confirmation is required before importing images.' }, { status: 400 });
    }
    const result = await applyMissingProfileImages(String(body?.datasetId || ''));
    revalidatePath('/');
    revalidatePath('/admin');
    for (const profile of result.profiles.filter((item) => item.status === 'ready')) {
      revalidatePath(`/profile/${encodeURIComponent(result.dataset.slug)}/${encodeURIComponent(profile.id)}`);
      revalidatePath(`/admin/preview/${encodeURIComponent(result.dataset.id)}/${encodeURIComponent(profile.id)}`);
    }
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message || 'Missing images could not be imported.' }, { status: 422 });
  }
}
