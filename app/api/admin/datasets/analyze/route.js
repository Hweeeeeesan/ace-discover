import { authorizeAdminRequest } from '../../../../../lib/admin/authorization';
import { createDatasetImport, createDatasetSyncImport } from '../../../../../lib/datasets/admin';
import { analyzeWorkbookUpload, semesterMetadata } from '../../../../../lib/import/workbook';
import { MAX_WORKBOOK_BYTES, uploadRequestTooLarge } from '../../../../../lib/import/limits';

export const runtime = 'nodejs';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;

  if (uploadRequestTooLarge(request.headers.get('content-length'))) {
    return Response.json({ error: 'The upload request exceeds the 16 MiB request limit.' }, { status: 413 });
  }

  try {
    const formData = await request.formData();
    const datasetId = String(formData.get('datasetId') || '');
    if (datasetId && !/^[0-9a-f-]{36}$/i.test(datasetId)) {
      return Response.json({ error: 'Invalid dataset.' }, { status: 400 });
    }
    const metadata = datasetId ? null : semesterMetadata({
      name: formData.get('name'), term: formData.get('term'), year: formData.get('year'),
    });
    const workbook = formData.get('workbook');
    if (workbook?.size > MAX_WORKBOOK_BYTES) {
      return Response.json({ error: 'The workbook exceeds the 15 MiB upload limit.' }, { status: 413 });
    }
    const payload = await analyzeWorkbookUpload(workbook);
    if (payload.criticalErrors?.length) {
      return Response.json({ error: payload.criticalErrors.join(' ') }, { status: 422 });
    }
    if (datasetId) {
      const result = await createDatasetSyncImport({
        datasetId,
        payload,
        userId: authorization.identity.user.id,
        source: { type: 'excel' },
      });
      return Response.json({
        mode: 'sync',
        importId: result.draft.id,
        expiresAt: result.draft.expires_at,
        metadata: result.metadata,
        health: result.health,
        safeIssues: result.safeIssues,
        diff: result.diff,
        sourceType: 'excel',
      });
    }
    const draft = await createDatasetImport({ metadata, payload, userId: authorization.identity.user.id });
    return Response.json({
      mode: 'create',
      importId: draft.id,
      expiresAt: draft.expires_at,
      metadata,
      health: payload.health,
      safeIssues: payload.safeIssues,
    });
  } catch (error) {
    return Response.json({ error: error.message || 'Workbook analysis failed.' }, { status: 422 });
  }
}
