import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { activateDataset } from '../../../../../lib/datasets/admin';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const { datasetId } = await request.json();
    if (!/^[0-9a-f-]{36}$/i.test(String(datasetId || ''))) {
      return Response.json({ error: 'Invalid dataset.' }, { status: 400 });
    }
    const dataset = await activateDataset(datasetId);
    revalidatePath('/', 'layout');
    return Response.json({ dataset });
  } catch (error) {
    return Response.json({ error: error.message || 'Dataset could not be activated.' }, { status: 422 });
  }
}
