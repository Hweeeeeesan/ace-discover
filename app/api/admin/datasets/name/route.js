import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { updateDatasetName } from '../../../../../lib/datasets/admin';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const { datasetId, name } = await request.json();
    const normalizedId = String(datasetId || '');
    const normalizedName = String(name || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(normalizedId) || !normalizedName || normalizedName.length > 100) {
      return Response.json({ error: 'Enter a dataset name between 1 and 100 characters.' }, { status: 400 });
    }
    const dataset = await updateDatasetName(normalizedId, normalizedName);
    revalidatePath('/admin');
    revalidatePath('/', 'layout');
    return Response.json({ dataset });
  } catch (error) {
    return Response.json({ error: error.message || 'Dataset name could not be changed.' }, { status: 422 });
  }
}
