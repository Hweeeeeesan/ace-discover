import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { setDatasetArchived } from '../../../../../lib/datasets/admin';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const { datasetId, status } = await request.json();
    if (!/^[0-9a-f-]{36}$/i.test(String(datasetId || '')) || !['ready', 'archived'].includes(status)) {
      return Response.json({ error: 'Invalid dataset status request.' }, { status: 400 });
    }
    await setDatasetArchived(datasetId, status === 'archived');
    revalidatePath('/admin');
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error.message || 'Dataset status could not be changed.' }, { status: 422 });
  }
}
