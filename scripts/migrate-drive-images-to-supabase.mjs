#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  fetchDriveImage,
  getDriveAuth,
  resolveImageFileFromFolder,
} from '../lib/google-drive-server.js';

const PLACEHOLDER = '/profile-placeholder.svg';
const DEFAULT_INPUT = 'data/profiles.json';
const DEFAULT_BUCKET = 'profile-images';
const DEFAULT_REPORT = 'reports/supabase-image-migration.csv';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PRIVATE_PROFILE_KEYS = new Set([
  'imageSourceUrl',
  'driveFileId',
  'driveFolderId',
  'storagePath',
  'resolvedDriveFileId',
  'imageIssue',
  'imageKind',
  'sourceGroup',
  'sourceRow',
]);
const SAFE_IMAGE_TYPES = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve('.env'));
loadEnvFile(resolve('.env.local'));

function parseArguments(argv) {
  const options = {
    input: DEFAULT_INPUT,
    output: 'data/profiles.supabase.json',
    moduleOutput: 'lib/profiles.supabase.js',
    report: DEFAULT_REPORT,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET,
    concurrency: 3,
    limit: Infinity,
    profileId: '',
    dryRun: false,
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === '--input' && value) options.input = value, index += 1;
    else if (argument === '--output' && value) options.output = value, index += 1;
    else if (argument === '--module-output' && value) options.moduleOutput = value, index += 1;
    else if (argument === '--report' && value) options.report = value, index += 1;
    else if (argument === '--bucket' && value) options.bucket = value, index += 1;
    else if (argument === '--concurrency' && value) options.concurrency = Number(value), index += 1;
    else if (argument === '--limit' && value) options.limit = Number(value), index += 1;
    else if (argument === '--profile' && value) options.profileId = value, index += 1;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error('--concurrency must be between 1 and 10.');
  }
  if (options.limit !== Infinity && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive number.');
  }

  return options;
}

function printHelp() {
  console.log(`Migrate profile images from Google Drive into a public Supabase Storage bucket.

Usage:
  npm run images:migrate -- [options]

Options:
  --dry-run                 Download and validate images without uploading.
  --apply                   Replace data/profiles.json and lib/profiles.js after migration.
  --profile PROFILE_ID      Process only one profile.
  --limit NUMBER            Process at most NUMBER eligible profiles.
  --concurrency NUMBER      Parallel downloads/uploads, 1-10 (default: 3).
  --bucket NAME             Supabase bucket (default: profile-images).
  --input PATH              Migration JSON input (default: data/profiles.json).
  --output PATH             Preview JSON output.
  --module-output PATH      Preview Next.js module output.
  --report PATH             CSV migration report.

Required for upload:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

For private Drive uploads or folder links, also configure a Google service
account or OAuth refresh token in .env.local and share the Drive files/folder
with that account.`);
}

function ensureParent(filePath) {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(filePath, rows) {
  ensureParent(filePath);
  const headers = [
    'profile_id',
    'name',
    'source_kind',
    'status',
    'resolved_drive_file_id',
    'storage_path',
    'public_url',
    'detail',
  ];
  const output = [headers.join(',')];
  for (const row of rows) {
    output.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  writeFileSync(filePath, `${output.join('\n')}\n`, 'utf8');
}

function publicProfile(profile) {
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => !PRIVATE_PROFILE_KEYS.has(key)),
  );
}

function writeProfileModule(filePath, profiles) {
  ensureParent(filePath);
  const publicProfiles = profiles.map(publicProfile);
  const moduleText = `export const profiles = ${JSON.stringify(publicProfiles, null, 2)};\n\nexport function getProfile(id) {\n  return profiles.find((profile) => profile.id === id);\n}\n`;
  writeFileSync(filePath, moduleText, 'utf8');
}

function writeJson(filePath, profiles) {
  ensureParent(filePath);
  writeFileSync(filePath, `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
}

function supabaseHeaders(serviceKey, additional = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...additional,
  };
}

async function responseDetail(response) {
  const text = await response.text();
  return text.slice(0, 500);
}

async function ensurePublicBucket({ supabaseUrl, serviceKey, bucket }) {
  const bucketUrl = `${supabaseUrl}/storage/v1/bucket/${encodeURIComponent(bucket)}`;
  const current = await fetch(bucketUrl, {
    headers: supabaseHeaders(serviceKey),
  });

  if (current.ok) {
    const metadata = await current.json();
    if (!metadata.public) {
      const update = await fetch(bucketUrl, {
        method: 'PUT',
        headers: supabaseHeaders(serviceKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          public: true,
          file_size_limit: MAX_IMAGE_BYTES,
          allowed_mime_types: ['image/*'],
        }),
      });
      if (!update.ok) {
        throw new Error(`Unable to make Supabase bucket public (${update.status}): ${await responseDetail(update)}`);
      }
    }
    return;
  }

  if (current.status !== 404) {
    throw new Error(`Unable to inspect Supabase bucket (${current.status}): ${await responseDetail(current)}`);
  }

  const create = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: supabaseHeaders(serviceKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: true,
      file_size_limit: MAX_IMAGE_BYTES,
      allowed_mime_types: ['image/*'],
    }),
  });

  if (!create.ok) {
    throw new Error(`Unable to create Supabase bucket (${create.status}): ${await responseDetail(create)}`);
  }
}

function storageObjectUrl(supabaseUrl, bucket, storagePath) {
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
}

async function uploadImage({ supabaseUrl, serviceKey, bucket, storagePath, contentType, bytes }) {
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`,
    {
      method: 'POST',
      headers: supabaseHeaders(serviceKey, {
        'Content-Type': contentType,
        'Cache-Control': '31536000',
        'x-upsert': 'true',
      }),
      body: bytes,
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase upload failed (${response.status}): ${await responseDetail(response)}`);
  }
}

function extensionFor(contentType) {
  const mime = contentType.toLowerCase().split(';', 1)[0].trim();
  const extensions = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return extensions[mime] || 'img';
}

async function responseToImage(response) {
  if (!response?.ok) throw new Error('The image source did not return a successful response.');
  const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!SAFE_IMAGE_TYPES.has(contentType)) {
    throw new Error(`The source returned ${contentType || 'an unknown content type'} instead of a supported raster image.`);
  }

  const statedLength = Number(response.headers.get('content-length') || 0);
  if (statedLength > MAX_IMAGE_BYTES) {
    throw new Error(`The image is larger than ${MAX_IMAGE_BYTES} bytes.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('The downloaded image was empty.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`The image is larger than ${MAX_IMAGE_BYTES} bytes.`);

  return { buffer, contentType };
}

async function fetchExternalImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'User-Agent': 'ACE-Discover-Image-Migration/1.0',
    },
  });
  return responseToImage(response);
}

async function downloadProfileImage(profile, driveAuth) {
  let resolvedDriveFileId = profile.driveFileId || '';

  if (profile.driveFolderId) {
    const file = await resolveImageFileFromFolder(profile.driveFolderId, driveAuth);
    if (!file) throw new Error('No accessible image was found in the submitted Drive folder.');
    resolvedDriveFileId = file.id;
  }

  if (resolvedDriveFileId) {
    const response = await fetchDriveImage(resolvedDriveFileId, driveAuth);
    if (!response) throw new Error('The Drive file could not be downloaded as an image.');
    const image = await responseToImage(response);
    return { ...image, resolvedDriveFileId };
  }

  if (profile.imageSourceUrl?.startsWith('http')) {
    const image = await fetchExternalImage(profile.imageSourceUrl);
    return { ...image, resolvedDriveFileId: '' };
  }

  throw new Error('No downloadable image source is available for this profile.');
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

function eligibleProfile(profile) {
  return Boolean(
    profile.driveFileId
      || profile.driveFolderId
      || profile.imageKind === 'direct-image-url',
  );
}

function updatedCandidates(profile, publicUrl) {
  const oldCandidates = Array.isArray(profile.imageCandidates)
    ? profile.imageCandidates
    : [profile.image];
  return [...new Set([publicUrl, ...oldCandidates, PLACEHOLDER].filter(Boolean))];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const inputPath = resolve(options.input);
  if (!existsSync(inputPath)) {
    throw new Error(`Migration input not found: ${inputPath}. Re-run the spreadsheet importer first.`);
  }

  const profiles = JSON.parse(readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(profiles)) throw new Error('The migration input must contain a JSON array.');

  let selected = profiles.filter(eligibleProfile);
  if (options.profileId) selected = selected.filter((profile) => profile.id === options.profileId);
  selected = selected.slice(0, options.limit);

  if (!selected.length) {
    console.log('No eligible profiles matched the selected options.');
    return;
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!options.dryRun && (!supabaseUrl || !serviceKey)) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local, or use --dry-run.');
  }

  const driveAuth = await getDriveAuth();
  console.log(`Processing ${selected.length} profile image(s). Drive mode: ${driveAuth.mode}.`);

  if (!options.dryRun) {
    await ensurePublicBucket({ supabaseUrl, serviceKey, bucket: options.bucket });
    console.log(`Supabase bucket ready: ${options.bucket}`);
  }

  const updates = new Map();
  const report = await mapWithConcurrency(selected, options.concurrency, async (profile, index) => {
    const prefix = `[${index + 1}/${selected.length}] ${profile.name}`;
    try {
      const image = await downloadProfileImage(profile, driveAuth);
      const digest = createHash('sha256').update(image.buffer).digest('hex').slice(0, 16);
      const extension = extensionFor(image.contentType);
      const storagePath = `profiles/${profile.id}/${digest}.${extension}`;
      const publicUrl = options.dryRun
        ? ''
        : storageObjectUrl(supabaseUrl, options.bucket, storagePath);

      if (!options.dryRun) {
        await uploadImage({
          supabaseUrl,
          serviceKey,
          bucket: options.bucket,
          storagePath,
          contentType: image.contentType,
          bytes: image.buffer,
        });
      }

      updates.set(profile.id, {
        image: publicUrl || profile.image,
        imageCandidates: publicUrl ? updatedCandidates(profile, publicUrl) : profile.imageCandidates,
        imageKind: publicUrl ? 'supabase-storage' : profile.imageKind,
        imageIssue: publicUrl ? '' : profile.imageIssue,
        storagePath: publicUrl ? storagePath : profile.storagePath || '',
        resolvedDriveFileId: image.resolvedDriveFileId || profile.resolvedDriveFileId || '',
      });

      console.log(`${prefix}: ${options.dryRun ? 'validated' : 'uploaded'}`);
      return {
        profile_id: profile.id,
        name: profile.name,
        source_kind: profile.imageKind,
        status: options.dryRun ? 'validated' : 'uploaded',
        resolved_drive_file_id: image.resolvedDriveFileId,
        storage_path: options.dryRun ? '' : storagePath,
        public_url: publicUrl,
        detail: `${image.contentType}; ${image.buffer.length} bytes`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`${prefix}: skipped — ${detail}`);
      return {
        profile_id: profile.id,
        name: profile.name,
        source_kind: profile.imageKind,
        status: 'skipped',
        resolved_drive_file_id: '',
        storage_path: '',
        public_url: '',
        detail,
      };
    }
  });

  const migratedProfiles = profiles.map((profile) => (
    updates.has(profile.id) ? { ...profile, ...updates.get(profile.id) } : profile
  ));

  writeCsv(options.report, report);

  if (options.apply && !options.dryRun) {
    const dataBackup = `${options.input}.before-supabase`;
    const moduleBackup = 'lib/profiles.js.before-supabase';
    if (!existsSync(dataBackup)) copyFileSync(options.input, dataBackup);
    if (existsSync('lib/profiles.js') && !existsSync(moduleBackup)) copyFileSync('lib/profiles.js', moduleBackup);
    writeJson(options.input, migratedProfiles);
    writeProfileModule('lib/profiles.js', migratedProfiles);
    console.log('Applied migrated URLs to data/profiles.json and lib/profiles.js.');
  } else {
    writeJson(options.output, migratedProfiles);
    writeProfileModule(options.moduleOutput, migratedProfiles);
    console.log(`Preview data: ${options.output}`);
    console.log(`Preview module: ${options.moduleOutput}`);
  }

  const uploaded = report.filter((row) => row.status === 'uploaded').length;
  const validated = report.filter((row) => row.status === 'validated').length;
  const skipped = report.filter((row) => row.status === 'skipped').length;
  console.log(`Finished: uploaded=${uploaded}, validated=${validated}, skipped=${skipped}.`);
  console.log(`Report: ${options.report}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
