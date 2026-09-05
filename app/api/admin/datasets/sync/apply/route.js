import { revalidatePath } from 'next/cache';
import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import { applyDatasetSyncImport, createDatasetSyncImport, prepareDatasetSync } from '../../../../../../lib/datasets/admin';
import { GoogleSheetsError, isValidGoogleSheetId } from '../../../../../../lib/google-sheets';
import { inspectGoogleSheet, readGoogleWorksheet } from '../../../../../../lib/google-sheets-server';
import { analyzeGoogleSheetValues } from '../../../../../../lib/import/google-sheet';
import { validateSyncApplyAcknowledgement } from '../../../../../../lib/datasets/sync';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const { importId, datasetId, acknowledgeRemoved } = body;
    if (!/^[0-9a-f-]{36}$/i.test(String(datasetId || ''))) {
      return Response.json({ error: 'Invalid sync preview.' }, { status: 400 });
    }
    let stagedImportId = importId;
    if (body.sourceType === 'google_sheet') {
      const sheetId = String(body.sheetId || '');
      const tab = String(body.sheetTab || '').trim();
      const expectedSourceHash = String(body.sourceHash || '');
      const expectedPreviewHash = String(body.previewHash || '');
      if (!isValidGoogleSheetId(sheetId) || !tab || !/^[0-9a-f]{64}$/.test(expectedSourceHash) || !/^[0-9a-f]{64}$/.test(expectedPreviewHash)) {
        return Response.json({ error: 'Invalid Google Sheet sync preview.' }, { status: 400 });
      }
      const sheet = await inspectGoogleSheet(sheetId);
      if (!sheet.tabs.some((candidate) => candidate.title === tab)) {
        throw new GoogleSheetsError('WORKSHEET_MISSING', 'The connected worksheet no longer exists. Check for updates again.', 422);
      }
      const values = await readGoogleWorksheet(sheetId, tab);
      const { payload, sourceHash } = await analyzeGoogleSheetValues(tab, values);
      if (sourceHash !== expectedSourceHash) {
        throw new GoogleSheetsError('SOURCE_CHANGED', 'The Google Sheet changed after this preview. Check for updates again.', 409);
      }
      const prepared = await prepareDatasetSync({ datasetId, payload, sourceHash });
      if (prepared.previewHash !== expectedPreviewHash) {
        throw new GoogleSheetsError('DATASET_CHANGED', 'The dataset changed after this preview. Check for updates again.', 409);
      }
      validateSyncApplyAcknowledgement(prepared.diff, acknowledgeRemoved === true);
      const staged = await createDatasetSyncImport({
        datasetId,
        payload,
        userId: authorization.identity.user.id,
        source: { type: 'google_sheet', sheetId, tab, title: sheet.title, hash: sourceHash },
        prepared,
      });
      stagedImportId = staged.draft.id;
    } else if (!/^[0-9a-f-]{36}$/i.test(String(importId || ''))) {
      return Response.json({ error: 'Invalid sync preview.' }, { status: 400 });
    }
    const dataset = await applyDatasetSyncImport(stagedImportId, datasetId, authorization.identity.user.id, acknowledgeRemoved === true);
    revalidatePath('/', 'layout');
    revalidatePath('/admin');
    return Response.json({ dataset });
  } catch (error) {
    const status = error instanceof GoogleSheetsError ? error.status : 422;
    return Response.json({ error: error.message || 'Dataset update could not be applied.', code: error.code }, { status });
  }
}
