export const MAX_WORKBOOK_BYTES = 15 * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = 16 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
]);

export function uploadRequestTooLarge(contentLength) {
  if (contentLength === null || contentLength === undefined || contentLength === '') return false;
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > MAX_UPLOAD_REQUEST_BYTES;
}

export function validateWorkbookFile(file) {
  if (!file || typeof file !== 'object' || typeof file.arrayBuffer !== 'function') return 'Choose an Excel workbook to analyze.';
  if (!String(file.name || '').toLowerCase().endsWith('.xlsx')) return 'Only .xlsx workbooks are supported.';
  if (!Number.isFinite(file.size) || file.size <= 0) return 'The workbook is empty.';
  if (file.size > MAX_WORKBOOK_BYTES) return 'The workbook exceeds the 15 MiB upload limit.';
  if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) return 'The uploaded file type is not an Excel workbook.';
  return '';
}
