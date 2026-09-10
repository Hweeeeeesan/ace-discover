import 'server-only';

import { createHash } from 'node:crypto';
import { analyzeSheetValues } from './profile-normalization.js';

const MAX_SHEET_JSON_BYTES = 20 * 1024 * 1024;

export async function analyzeGoogleSheetValues(tabTitle, values) {
  const serialized = JSON.stringify({ title: tabTitle, values });
  if (Buffer.byteLength(serialized) > MAX_SHEET_JSON_BYTES) {
    throw new Error('The selected worksheet exceeds the 20 MiB analysis limit.');
  }
  const sourceHash = createHash('sha256').update(serialized).digest('hex');
  return { payload: analyzeSheetValues(tabTitle, values), sourceHash };
}
