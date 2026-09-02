import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { removeAdminDataset } from '../../../../../lib/datasets/admin';
import { DatasetRemovalError, isValidDatasetId } from '../../../../../lib/datasets/removal';

export async function DELETE(request, context) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  const { datasetId } = await context.params;
  if (!isValidDatasetId(datasetId)) {
    return Response.json({ error: 'Invalid dataset ID.' }, { status: 400 });
  }

  try {
    const result = await removeAdminDataset(datasetId);
    revalidatePath('/admin');
    return Response.json({ ok: true, dataset: result });
  } catch (error) {
    const status = error instanceof DatasetRemovalError ? error.status : 422;
    return Response.json({
      error: error.message || 'Semester could not be removed.',
      category: error instanceof DatasetRemovalError ? error.category : 'dataset_removal_failed',
    }, { status });
  }
}
