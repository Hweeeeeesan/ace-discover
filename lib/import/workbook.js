import 'server-only';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MAX_WORKBOOK_BYTES, validateWorkbookFile } from './limits.js';

export { MAX_WORKBOOK_BYTES, validateWorkbookFile } from './limits.js';

function runAnalyzer(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['scripts/analyze-workbook.py', inputPath, outputPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Workbook analysis exceeded the 60 second processing limit.'));
    }, 60_000);

    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Workbook analyzer could not start: ${error.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'The workbook failed schema or privacy validation.'));
    });
  });
}

export async function analyzeWorkbookUpload(file) {
  const validationError = validateWorkbookFile(file);
  if (validationError) throw new Error(validationError);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('The uploaded file is not a valid .xlsx archive.');

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ace-discover-import-'));
  const inputPath = join(temporaryDirectory, 'upload.xlsx');
  const outputPath = join(temporaryDirectory, 'normalized.json');
  try {
    await writeFile(inputPath, bytes, { mode: 0o600 });
    await runAnalyzer(inputPath, outputPath);
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function semesterMetadata({ name, term, year }) {
  const safeTerm = ['Spring', 'Summer', 'Fall', 'Winter'].includes(term) ? term : '';
  const safeYear = Number(year);
  const safeName = String(name || '').trim().slice(0, 100);
  if (!safeTerm) throw new Error('Choose a valid semester term.');
  if (!Number.isInteger(safeYear) || safeYear < 2020 || safeYear > 2100) throw new Error('Choose a valid semester year.');
  if (!safeName) throw new Error('Enter a semester name.');
  return {
    name: safeName,
    term: safeTerm,
    year: safeYear,
    slug: `${safeTerm.toLowerCase()}-${safeYear}`,
  };
}
