import 'server-only';

import { getDriveAuth, getGoogleServiceAccountEmail } from './google-drive-server';
import {
  fetchSpreadsheetMetadata,
  fetchWorksheetValues,
  GoogleSheetsError,
} from './google-sheets';

async function sheetsAuth() {
  try {
    const auth = await getDriveAuth({ strict: true, serviceAccountOnly: true });
    if (!auth.authenticated || !auth.accessToken) {
      throw new GoogleSheetsError('AUTH_NOT_CONFIGURED', 'Google service-account credentials are not configured.', 503);
    }
    return {
      accessToken: auth.accessToken,
      serviceAccountEmail: getGoogleServiceAccountEmail(),
    };
  } catch (error) {
    if (error instanceof GoogleSheetsError) throw error;
    throw new GoogleSheetsError('AUTH_FAILED', 'Google service-account authentication failed. Check the server credentials.', 503);
  }
}

export async function inspectGoogleSheet(sheetId) {
  return fetchSpreadsheetMetadata(sheetId, await sheetsAuth());
}

export async function readGoogleWorksheet(sheetId, tabTitle) {
  return fetchWorksheetValues(sheetId, tabTitle, await sheetsAuth());
}
