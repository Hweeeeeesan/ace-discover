#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { getDriveAuth } from '../lib/google-drive-server.js';
import {
  MAX_PROFILE_IMAGE_BYTES,
  detectImageContentType,
  ingestProfileImage,
} from '../lib/profile-image-ingestion.js';
import { migrateDatasetProfiles } from '../lib/profile-image-migration.js';
import {
  DEFAULT_PROFILE_IMAGE_BUCKET,
  isValidStorageImagePath,
} from '../lib/profile-images.js';

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
    ) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve('.env'));
loadEnvFile(resolve('.env.local'));

export function parseArguments(argv) {
  const options = {
    datasetSlug: '',
    apply: false,
    explicitDryRun: false,
    limit: Infinity,
    profileId: '',
    report: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith('-') && !options.datasetSlug) options.datasetSlug = argument;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.explicitDryRun = true;
    else if (argument === '--profile' && value) options.profileId = value, index += 1;
    else if (argument === '--limit' && value) options.limit = Number(value), index += 1;
    else if (argument === '--report' && value) options.report = value, index += 1;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.apply && options.explicitDryRun) throw new Error('Choose either --apply or --dry-run, not both.');
  if (options.datasetSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.datasetSlug)) {
    throw new Error('Dataset slug must contain lowercase letters, numbers, and single hyphens only.');
  }
  if (options.limit !== Infinity && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer.');
  }
  options.dryRun = !options.apply;
  return options;
}

function printHelp() {
  console.log(`Migrate one dataset's approved Google Drive profile images to Supabase Storage.

Usage:
  npm run images:migrate -- <dataset-slug> --dry-run
  npm run images:migrate -- <dataset-slug> --apply

Options:
  --dry-run              Default. Validate sources without uploading or changing profile data.
  --apply                Upload missing images and attach canonical storageImagePath values.
  --profile PROFILE_ID   Inspect or migrate one profile in the dataset.
  --limit NUMBER         Process at most NUMBER selected profiles.
  --report PATH          CSV report path (default includes the dataset slug).

Required in .env.local:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_STORAGE_BUCKET=profile-images

The command never activates or archives datasets. Direct arbitrary URLs are
reported but never fetched. Apply the checked-in Supabase migration first.`);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeReport(filePath, rows) {
  const headers = ['profile_id', 'name', 'status', 'category', 'storage_path', 'detail'];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = {
      profile_id: row.profileId,
      name: row.name,
      status: row.status,
      category: row.category,
      storage_path: row.storagePath,
      detail: row.detail,
    };
    lines.push(headers.map((header) => csvCell(values[header])).join(','));
  }
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${lines.join('\n')}\n`, 'utf8');
  return absolutePath;
}

function profileFromRow(row) {
  return {
    ...(row.public_data || {}),
    id: row.profile_id,
    driveFileId: row.drive_file_id || '',
    driveFolderId: row.drive_folder_id || '',
    imageKind: row.image_kind || row.public_data?.imageKind || '',
    storageImagePath: row.storage_image_path || row.public_data?.storageImagePath || '',
  };
}

async function loadDataset(supabase, datasetSlug) {
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name,status,profile_count')
    .eq('slug', datasetSlug)
    .single();
  if (datasetError || !dataset) throw new Error(`Dataset ${datasetSlug} was not found or could not be read: ${datasetError?.message || 'not found'}`);

  const { data: rows, error: profilesError } = await supabase
    .from('dataset_profiles')
    .select('profile_id,public_data,drive_file_id,drive_folder_id,image_kind,storage_image_path,ordinal')
    .eq('dataset_id', dataset.id)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (profilesError) {
    throw new Error(`Dataset profiles could not be read. Apply the image Storage migration first. ${profilesError.message}`);
  }
  if ((rows || []).length !== dataset.profile_count) {
    throw new Error(`Dataset integrity check failed: expected ${dataset.profile_count} profiles, received ${(rows || []).length}.`);
  }
  return { dataset, profiles: (rows || []).map(profileFromRow) };
}

function storageInspector(supabase, bucket, datasetSlug) {
  const storage = supabase.storage.from(bucket);

  async function validateStoredObject(storagePath) {
    const { data, error } = await storage.download(storagePath);
    if (error || !data) return false;
    if (!data.size || data.size > MAX_PROFILE_IMAGE_BYTES) return false;
    const bytes = Buffer.from(await data.arrayBuffer());
    return Boolean(detectImageContentType(bytes));
  }

  async function listPrimaryPaths(profileId) {
    const directory = `${datasetSlug}/${profileId}`;
    const { data, error } = await storage.list(directory, { limit: 20, search: 'primary.' });
    if (error) throw new Error(`Storage inspection failed for ${directory}: ${error.message}`);
    return (data || [])
      .map((object) => `${directory}/${object.name}`)
      .filter(isValidStorageImagePath);
  }

  return {
    async pathExists(storagePath) {
      const parts = storagePath.split('/');
      const paths = await listPrimaryPaths(parts[1]);
      return paths.includes(storagePath) && validateStoredObject(storagePath);
    },
    async findExistingPath(profile) {
      const paths = await listPrimaryPaths(profile.id);
      if (paths.length > 1) throw new Error('Multiple primary Storage objects exist for this profile; resolve the ambiguity manually.');
      if (!paths[0]) return '';
      if (!(await validateStoredObject(paths[0]))) throw new Error('The existing primary Storage object is empty, oversized, or not a supported image.');
      return paths[0];
    },
    async upload({ storagePath, bytes, contentType }) {
      const { error } = await storage.upload(storagePath, bytes, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
      if (!error) return;
      if (await this.pathExists(storagePath)) return;
      throw new Error(`Supabase Storage upload failed: ${error.message}`);
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  if (!options.datasetSlug) throw new Error('Provide a dataset slug. Example: npm run images:migrate -- spring-2026 --dry-run');

  const supabaseUrl = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required, including for dataset-scoped dry runs.');
  if (bucket !== DEFAULT_PROFILE_IMAGE_BUCKET) throw new Error(`SUPABASE_STORAGE_BUCKET must remain ${DEFAULT_PROFILE_IMAGE_BUCKET} for this migration.`);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { dataset, profiles: allProfiles } = await loadDataset(supabase, options.datasetSlug);
  let profiles = allProfiles;
  if (options.profileId) profiles = profiles.filter((profile) => profile.id === options.profileId);
  profiles = profiles.slice(0, options.limit);
  if (!profiles.length) throw new Error('No profiles matched the selected dataset and filters.');

  const inspector = storageInspector(supabase, bucket, dataset.slug);
  const driveAuth = await getDriveAuth({ strict: true });
  console.log(`${options.dryRun ? 'DRY RUN' : 'APPLY'}: ${dataset.name} (${dataset.slug}, ${dataset.status})`);
  console.log(`Selected ${profiles.length} of ${allProfiles.length} profiles. Drive mode: ${driveAuth.mode}.`);

  const result = await migrateDatasetProfiles({
    dataset,
    profiles,
    dryRun: options.dryRun,
    storagePathExists: inspector.pathExists,
    findExistingPath: inspector.findExistingPath,
    ingest: (profile) => ingestProfileImage({
      profile,
      datasetSlug: dataset.slug,
      driveAuth,
      dryRun: options.dryRun,
      upload: inspector.upload.bind(inspector),
    }),
    persistPath: async (profile, storagePath) => {
      const { data, error } = await supabase.rpc('set_profile_storage_image_path', {
        requested_dataset_id: dataset.id,
        requested_profile_id: profile.id,
        requested_storage_path: storagePath,
      });
      if (error) throw new Error(`The Storage upload succeeded but its canonical path could not be saved: ${error.message}`);
      if (data?.storageImagePath !== storagePath) throw new Error('The canonical Storage path RPC did not confirm the requested path.');
    },
    onRow(row) {
      console.log(`${row.profileId}: ${row.status}${row.category ? ` (${row.category})` : ''}`);
    },
  });
  result.summary.totalProfiles = allProfiles.length;

  const reportPath = writeReport(
    options.report || `reports/supabase-image-migration-${dataset.slug}.csv`,
    result.rows,
  );
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Report: ${reportPath}`);
  if (options.dryRun) console.log('Dry run complete: no images were uploaded and no profile data was changed.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
