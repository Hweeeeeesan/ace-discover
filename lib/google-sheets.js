const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const GOOGLE_SHEETS_HOST = 'docs.google.com';
const DEFAULT_SERVICE_ACCOUNT = 'ace-discover-drive@ace-discover.iam.gserviceaccount.com';

export class GoogleSheetsError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'GoogleSheetsError';
    this.code = code;
    this.status = status;
  }
}

export function isValidGoogleSheetId(value) {
  return SHEET_ID_PATTERN.test(String(value || ''));
}

export function parseGoogleSheetUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new GoogleSheetsError('MALFORMED_URL', 'Enter a valid Google Sheets URL.', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== GOOGLE_SHEETS_HOST) {
    throw new GoogleSheetsError('MALFORMED_URL', 'Use a docs.google.com Google Sheets URL.', 400);
  }
  const match = parsed.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!match || !isValidGoogleSheetId(match[1])) {
    throw new GoogleSheetsError('MALFORMED_URL', 'The Google Sheets URL does not contain a valid Sheet ID.', 400);
  }
  return match[1];
}

function googleErrorMessage(payload = {}) {
  return String(payload?.error?.message || payload?.message || '').trim();
}

function googleErrorReasons(payload = {}) {
  const details = payload?.error?.errors;
  return Array.isArray(details) ? details.map((item) => String(item?.reason || '').toLowerCase()) : [];
}

export function googleSheetsApiError(status, payload, serviceAccountEmail = DEFAULT_SERVICE_ACCOUNT) {
  const message = googleErrorMessage(payload).toLowerCase();
  const reasons = googleErrorReasons(payload);
  const apiDisabled = reasons.some((reason) => ['accessnotconfigured', 'servicedisabled'].includes(reason))
    || /api.+(?:disabled|has not been used|not enabled)/i.test(message);
  if (apiDisabled) {
    return new GoogleSheetsError(
      'API_DISABLED',
      'Google Sheets API is not enabled for the ACE Discover Google Cloud project. Enable it and try again.',
      503,
    );
  }
  if (status === 429 || reasons.includes('ratelimitexceeded') || reasons.includes('userratelimitexceeded')) {
    return new GoogleSheetsError('RATE_LIMIT', 'Google Sheets is rate limiting requests. Wait a moment and try again.', 429);
  }
  if (status === 401) {
    return new GoogleSheetsError('AUTH_FAILED', 'Google service-account authentication failed. Check the server credentials.', 503);
  }
  if (status === 403 || status === 404) {
    return new GoogleSheetsError(
      'SHEET_UNAVAILABLE',
      `ACE Discover cannot read this Sheet. Share it with ${serviceAccountEmail} as Viewer and try again.`,
      403,
    );
  }
  return new GoogleSheetsError('GOOGLE_API_ERROR', 'Google Sheets could not be read. Try again shortly.', 502);
}

async function fetchGoogleJson(url, { accessToken, fetchImpl = fetch, timeoutMs = 15000, serviceAccountEmail } = {}) {
  if (!accessToken) {
    throw new GoogleSheetsError('AUTH_NOT_CONFIGURED', 'Google service-account credentials are not configured.', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw googleSheetsApiError(response.status, payload, serviceAccountEmail);
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new GoogleSheetsError('TIMEOUT', 'Google Sheets did not respond in time. Try again.', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSpreadsheetMetadata(sheetId, options = {}) {
  if (!isValidGoogleSheetId(sheetId)) throw new GoogleSheetsError('INVALID_SHEET_ID', 'Invalid Google Sheet ID.', 400);
  const fields = 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))';
  const payload = await fetchGoogleJson(
    `${SHEETS_API_BASE}/${encodeURIComponent(sheetId)}?fields=${encodeURIComponent(fields)}`,
    options,
  );
  const tabs = (payload.sheets || []).map((sheet) => ({
    id: Number(sheet?.properties?.sheetId),
    title: String(sheet?.properties?.title || '').slice(0, 200),
    index: Number(sheet?.properties?.index || 0),
    rowCount: Number(sheet?.properties?.gridProperties?.rowCount || 0),
    columnCount: Number(sheet?.properties?.gridProperties?.columnCount || 0),
  })).filter((tab) => tab.title);
  if (!tabs.length) throw new GoogleSheetsError('NO_WORKSHEETS', 'This Google Sheet has no readable worksheets.', 422);
  return {
    id: String(payload.spreadsheetId || sheetId),
    title: String(payload?.properties?.title || 'Google Sheet').slice(0, 200),
    tabs: tabs.sort((left, right) => left.index - right.index),
  };
}

export function chooseWorksheet(tabs = []) {
  if (tabs.length === 1) return tabs[0].title;
  const formsTabs = tabs.filter((tab) => /^form responses(?: \d+)?$/i.test(tab.title.trim()));
  if (formsTabs.length === 1) return formsTabs[0].title;
  return '';
}

export async function fetchWorksheetValues(sheetId, tabTitle, options = {}) {
  if (!isValidGoogleSheetId(sheetId)) throw new GoogleSheetsError('INVALID_SHEET_ID', 'Invalid Google Sheet ID.', 400);
  const safeTab = String(tabTitle || '').trim();
  if (!safeTab || safeTab.length > 200) throw new GoogleSheetsError('WORKSHEET_MISSING', 'Choose a valid worksheet.', 400);
  const range = `'${safeTab.replace(/'/g, "''")}'`;
  const payload = await fetchGoogleJson(
    `${SHEETS_API_BASE}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
    options,
  );
  const values = Array.isArray(payload.values) ? payload.values : [];
  if (values.length < 2 || !values[0]?.some((value) => String(value || '').trim())) {
    throw new GoogleSheetsError('EMPTY_SHEET', 'The selected worksheet is empty or has no response rows.', 422);
  }
  if (values.length > 10000 || values.some((row) => !Array.isArray(row) || row.length > 500)) {
    throw new GoogleSheetsError('SHEET_TOO_LARGE', 'The selected worksheet exceeds the 10,000-row or 500-column safety limit.', 413);
  }
  return values.map((row) => row.map((value) => String(value ?? '')));
}
