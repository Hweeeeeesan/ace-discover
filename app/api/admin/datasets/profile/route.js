import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { getAdminDatasetProfile, updateAdminPublicProfile } from '../../../../../lib/datasets/admin';
import { buildPublicOverridePatch } from '../../../../../lib/profile-overrides';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '').trim();
    if (!UUID.test(datasetId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profileId)) {
      return Response.json({ error: 'Invalid profile edit request.' }, { status: 400 });
    }
    const expectedUpdatedAt = body?.expectedUpdatedAt === null || body?.expectedUpdatedAt === undefined
      ? null
      : String(body.expectedUpdatedAt);
    if (expectedUpdatedAt !== null && Number.isNaN(Date.parse(expectedUpdatedAt))) {
      return Response.json({ error: 'Invalid profile edit version.' }, { status: 400 });
    }
    if (!body?.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return Response.json({ error: 'Profile values must be an object.' }, { status: 400 });
    }

    const current = await getAdminDatasetProfile(datasetId, profileId);
    if (!current) return Response.json({ error: 'Profile not found in the requested dataset.' }, { status: 404 });
    const overrides = buildPublicOverridePatch(
      current.importedPublicData,
      current.publicOverrides,
      body.values,
    );
    const result = await updateAdminPublicProfile({
      datasetId,
      profileId,
      overrides,
      expectedUpdatedAt,
      actorId: authorization.identity.user.id,
    });
    const datasetSlug = current.dataset.slug;
    revalidatePath('/', 'layout');
    revalidatePath(`/profile/${encodeURIComponent(datasetSlug)}/${encodeURIComponent(profileId)}`);
    revalidatePath(`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profileId)}`);
    return Response.json({ ok: true, publicOverrides: overrides, updatedAt: result.updatedAt });
  } catch (error) {
    const conflict = /edited by someone else/i.test(error.message || '');
    return Response.json(
      { error: error.message || 'Profile changes could not be saved.', code: conflict ? 'PROFILE_EDIT_CONFLICT' : 'PROFILE_EDIT_INVALID' },
      { status: conflict ? 409 : 422 },
    );
  }
}
