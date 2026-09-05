import { authorizeAdminRequest } from '../../../../../../lib/admin/authorization';
import { chooseWorksheet, GoogleSheetsError, parseGoogleSheetUrl } from '../../../../../../lib/google-sheets';
import { inspectGoogleSheet } from '../../../../../../lib/google-sheets-server';

export const runtime = 'nodejs';

export async function POST(request) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok) return authorization.response;
  try {
    const { sheetUrl } = await request.json();
    const sheetId = parseGoogleSheetUrl(sheetUrl);
    const sheet = await inspectGoogleSheet(sheetId);
    return Response.json({
      sheetId: sheet.id,
      title: sheet.title,
      tabs: sheet.tabs,
      suggestedTab: chooseWorksheet(sheet.tabs),
    });
  } catch (error) {
    const status = error instanceof GoogleSheetsError ? error.status : 422;
    return Response.json({ error: error.message || 'Google Sheet connection failed.', code: error.code }, { status });
  }
}
