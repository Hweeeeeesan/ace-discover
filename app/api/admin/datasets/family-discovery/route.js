import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { setDatasetFamilyDiscoveryVisibility } from '../../../../../lib/datasets/admin';
import { revalidatePublicDiscovery } from '../../../../../lib/datasets/revalidation';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  try {
    const body = await request.json();
    const datasetId = String(body.datasetId || '');
    if (!/^[0-9a-f-]{36}$/i.test(datasetId)) {
      return Response.json({ error: 'Invalid dataset.' }, { status: 400 });
    }
    if (typeof body.showFamilyInDiscovery !== 'boolean') {
      return Response.json({ error: 'The Family Discovery setting must be boolean.' }, { status: 400 });
    }

    const result = await setDatasetFamilyDiscoveryVisibility(datasetId, body.showFamilyInDiscovery);
    revalidatePublicDiscovery();
    revalidatePath('/admin');
    revalidatePath(`/admin/preview/${encodeURIComponent(datasetId)}`);
    return Response.json({ dataset: result });
  } catch (error) {
    return Response.json({ error: error.message || 'The Family Discovery setting could not be updated.' }, { status: 422 });
  }
}
