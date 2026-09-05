import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import { createDatasetImport, getAdminDatasetSyncTarget, prepareDatasetSync } from '../../../../../../lib/datasets/admin';
import { chooseWorksheet, GoogleSheetsError, isValidGoogleSheetId } from '../../../../../../lib/google-sheets';
import { inspectGoogleSheet, readGoogleWorksheet } from '../../../../../../lib/google-sheets-server';
import { analyzeGoogleSheetValues } from '../../../../../../lib/import/google-sheet';
import { semesterMetadata } from '../../../../../../lib/import/workbook';

export const runtime = 'nodejs';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = await request.json();
    const datasetId = String(body.datasetId || '');
    if (datasetId && !/^[0-9a-f-]{36}$/i.test(datasetId)) {
      return Response.json({ error: 'Invalid dataset.' }, { status: 400 });
    }

    const target = datasetId ? await getAdminDatasetSyncTarget(datasetId) : null;
    const sheetId = String(body.sheetId || target?.dataset.googleSheetId || '');
    if (!isValidGoogleSheetId(sheetId)) {
      return Response.json({ error: 'Connect a valid Google Sheet first.' }, { status: 400 });
    }
    const sheet = await inspectGoogleSheet(sheetId);
    const requestedTab = String(body.tab || target?.dataset.googleSheetTab || chooseWorksheet(sheet.tabs) || '').trim();
    const tab = sheet.tabs.find((candidate) => candidate.title === requestedTab);
    if (!tab) {
      throw new GoogleSheetsError('WORKSHEET_MISSING', 'The connected worksheet no longer exists. Reconnect and choose a worksheet.', 422);
    }
    const values = await readGoogleWorksheet(sheetId, tab.title);
    const { payload, sourceHash } = await analyzeGoogleSheetValues(tab.title, values);
    if (payload.criticalErrors?.length) {
      return Response.json({ error: payload.criticalErrors.join(' ') }, { status: 422 });
    }
    const source = { type: 'google_sheet', sheetId, tab: tab.title, title: sheet.title, hash: sourceHash };

    if (datasetId) {
      const result = await prepareDatasetSync({
        datasetId,
        payload,
        sourceHash,
      });
      return Response.json({
        mode: 'sync',
        previewHash: result.previewHash,
        sourceHash,
        sheetId,
        sheetTab: tab.title,
        metadata: result.metadata,
        health: result.payload.health,
        safeIssues: result.payload.safeIssues,
        diff: result.diff,
        sourceType: 'google_sheet',
        source: { title: sheet.title, tab: tab.title },
        unchangedSource: sourceHash === target.dataset.lastSourceHash,
      });
    }

    const metadata = semesterMetadata(body);
    const draft = await createDatasetImport({
      metadata,
      payload,
      userId: authorization.identity.user.id,
      source,
    });
    return Response.json({
      mode: 'create',
      importId: draft.id,
      expiresAt: draft.expires_at,
      metadata,
      health: payload.health,
      safeIssues: payload.safeIssues,
      sourceType: 'google_sheet',
      source: { title: sheet.title, tab: tab.title },
    });
  } catch (error) {
    const status = error instanceof GoogleSheetsError ? error.status : 422;
    return Response.json({ error: error.message || 'Google Sheet analysis failed.', code: error.code }, { status });
  }
}
