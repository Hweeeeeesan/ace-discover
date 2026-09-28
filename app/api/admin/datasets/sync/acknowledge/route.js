import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import { acknowledgeMissingSourceProfiles } from '../../../../../../lib/datasets/admin';

export const runtime = 'nodejs';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const datasetId = String(body.datasetId || '');
    const profileIds = Array.isArray(body.profileIds) ? body.profileIds : [];
    if (!/^[0-9a-f-]{36}$/i.test(datasetId) || !profileIds.length || profileIds.some((profileId) => typeof profileId !== 'string' || profileId.trim().length === 0 || profileId.trim().length > 160)) {
      return Response.json({ error: 'Invalid missing-source acknowledgment.' }, { status: 400 });
    }

    const acknowledged = await acknowledgeMissingSourceProfiles({
      datasetId,
      profileIds,
      actorId: authorization.identity.user.id,
    });
    return Response.json({ acknowledged });
  } catch (error) {
    return Response.json({ error: error.message || 'Missing-source acknowledgment could not be saved.' }, { status: 422 });
  }
}
