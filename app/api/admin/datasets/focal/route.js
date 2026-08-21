import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { isValidFocalCoordinate } from '../../../../../lib/profile-images';
import { updateAdminProfileImageFocal } from '../../../../../lib/datasets/admin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '');
    const imageId = String(body?.imageId || '');
    const displayMode = body?.displayMode;
    if (!UUID.test(datasetId) || !profileId || !UUID.test(imageId)) {
      return Response.json({ error: 'Invalid profile image request.' }, { status: 400 });
    }
    if (!isValidFocalCoordinate(body?.focalX) || !isValidFocalCoordinate(body?.focalY)) {
      return Response.json({ error: 'Focal coordinates must be numbers from 0 to 100.' }, { status: 400 });
    }
    if (!['cover', 'portrait'].includes(displayMode)) {
      return Response.json({ error: 'Display mode must be cover or portrait.' }, { status: 400 });
    }

    const image = await updateAdminProfileImageFocal({
      datasetId,
      profileId,
      imageId,
      focalX: body.focalX,
      focalY: body.focalY,
      displayMode,
    });
    const datasetSlug = String(body?.datasetSlug || '');
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(datasetSlug)) {
      revalidatePath(`/profile/${datasetSlug}/${encodeURIComponent(profileId)}`);
    }
    revalidatePath(`/admin/preview/${datasetId}/${encodeURIComponent(profileId)}`);
    return Response.json({ ok: true, image });
  } catch (error) {
    return Response.json({ error: error.message || 'Focal point could not be saved.' }, { status: 422 });
  }
}
