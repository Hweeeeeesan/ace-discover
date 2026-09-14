import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import {
  allowProfileQaIssue,
  getDatasetProfileQa,
  reopenProfileQaIssue,
  updateQaPublicField,
} from '../../../../../lib/profile-qa-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    return Response.json(await getDatasetProfileQa(String(body?.datasetId || '')));
  } catch (error) {
    return Response.json({ error: error.message || 'Public response QA could not be loaded.' }, { status: 422 });
  }
}

export async function PATCH(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const datasetId = String(body?.datasetId || '');
    const profileId = String(body?.profileId || '');
    const action = String(body?.action || '');
    let result;
    if (action === 'allow') {
      result = await allowProfileQaIssue({
        datasetId,
        profileId,
        field: String(body?.field || ''),
        rule: String(body?.rule || ''),
        sourceHash: String(body?.sourceHash || ''),
        actorId: authorization.identity.user.id,
      });
    } else if (action === 'reopen') {
      result = await reopenProfileQaIssue({
        datasetId,
        profileId,
        field: String(body?.field || ''),
        rule: String(body?.rule || ''),
        sourceHash: String(body?.sourceHash || ''),
      });
    } else if (action === 'edit' || action === 'hide') {
      if (action === 'edit' && typeof body?.value !== 'string') {
        return Response.json({ error: 'Edited public content must be text.' }, { status: 400 });
      }
      result = await updateQaPublicField({
        datasetId,
        profileId,
        field: String(body?.field || ''),
        value: action === 'hide' ? '' : body.value,
        actorId: authorization.identity.user.id,
      });
      revalidatePath('/', 'layout');
      revalidatePath(`/profile/${encodeURIComponent(result.datasetSlug)}/${encodeURIComponent(profileId)}`);
      revalidatePath(`/admin/preview/${encodeURIComponent(datasetId)}/${encodeURIComponent(profileId)}`);
    } else {
      return Response.json({ error: 'Unknown QA review action.' }, { status: 400 });
    }
    revalidatePath('/admin');
    return Response.json(result);
  } catch (error) {
    const conflict = /edited by someone else/i.test(error.message || '');
    return Response.json(
      { error: error.message || 'The QA review action failed.' },
      { status: conflict ? 409 : 422 },
    );
  }
}
