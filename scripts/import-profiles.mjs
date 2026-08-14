#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run profiles:import -- "path/to/workbook.xlsx"');
  process.exit(2);
}

const workbook = resolve(input);
try {
  await access(workbook);
} catch {
  console.error(`Workbook not found: ${workbook}`);
  process.exit(2);
}

const args = [
  'scripts/import-master-apps.py', workbook, 'lib/profiles.js',
  'reports/image-import-report.csv', 'data/profiles.json',
];
const child = spawn('python3', args, { cwd: process.cwd(), stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`Unable to start profile import: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
