import 'server-only';

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_SHEET_JSON_BYTES = 20 * 1024 * 1024;

function runSheetAnalyzer(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['scripts/analyze-sheet-values.py', inputPath, outputPath], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Google Sheet analysis exceeded the 60 second processing limit.'));
    }, 60_000);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Google Sheet analyzer could not start: ${error.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || 'The worksheet failed schema or privacy validation.'));
    });
  });
}

export async function analyzeGoogleSheetValues(tabTitle, values) {
  const serialized = JSON.stringify({ title: tabTitle, values });
  if (Buffer.byteLength(serialized) > MAX_SHEET_JSON_BYTES) {
    throw new Error('The selected worksheet exceeds the 20 MiB analysis limit.');
  }
  const sourceHash = createHash('sha256').update(serialized).digest('hex');
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ace-discover-sheet-'));
  const inputPath = join(temporaryDirectory, 'sheet.json');
  const outputPath = join(temporaryDirectory, 'normalized.json');
  try {
    await writeFile(inputPath, serialized, { mode: 0o600 });
    await runSheetAnalyzer(inputPath, outputPath);
    return {
      payload: JSON.parse(await readFile(outputPath, 'utf8')),
      sourceHash,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
