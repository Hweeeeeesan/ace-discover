import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { getAdminDatasetProfile, setAdminProfilePublicVisibility } from '../../../../../lib/datasets/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '').trim();
    const hidden = body?.hidden;
    if (!UUID.test(datasetId) || !PROFILE_ID.test(profileId) || typeof hidden !== 'boolean') {
      return Response.json({ error: 'Invalid profile visibility request.' }, { status: 400 });
    }

    const current = await getAdminDatasetProfile(datasetId, profileId);
    if (!current) return Response.json({ error: 'Profile not found in the requested dataset.' }, { status: 404 });
    if (current.publicHidden === hidden) {
      return Response.json({ ok: true, publicHidden: hidden, unchanged: true });
    }

    const result = await setAdminProfilePublicVisibility({ datasetId, profileId, hidden });
    const datasetSlug = current.dataset.slug;
    revalidatePath('/', 'layout');
    revalidatePath(`/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profileId)}`);
    revalidatePath(`/admin`);
    revalidatePath(`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profileId)}`);
    return Response.json({ ok: true, publicHidden: result?.publicHidden === true });
  } catch (error) {
    return Response.json({ error: error.message || 'Profile visibility could not be changed.' }, { status: 422 });
  }
}
