import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { saveDatasetImport } from '../../../../../lib/datasets/admin';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const { importId } = await request.json();
    if (!/^[0-9a-f-]{36}$/i.test(String(importId || ''))) {
      return Response.json({ error: 'Invalid import preview.' }, { status: 400 });
    }
    const dataset = await saveDatasetImport(importId, authorization.identity.user.id);
    revalidatePath('/admin');
    return Response.json({ dataset });
  } catch (error) {
    return Response.json({ error: error.message || 'Dataset could not be saved.' }, { status: 422 });
  }
}
