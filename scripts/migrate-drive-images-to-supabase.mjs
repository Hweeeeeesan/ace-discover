#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { getDriveAuth } from '../lib/google-drive-server.js';
import {
  MAX_PROFILE_IMAGE_BYTES,
  detectImageContentType,
  ingestProfileImages,
} from '../lib/profile-image-ingestion.js';
import { migrateDatasetProfileGalleries } from '../lib/profile-image-migration.js';
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
    replaceExisting: false,
    report: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith('-') && !options.datasetSlug) options.datasetSlug = argument;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.explicitDryRun = true;
    else if (argument === '--profile' && value) options.profileId = value, index += 1;
    else if (argument === '--replace-existing') options.replaceExisting = true;
    else if (argument === '--limit' && value) options.limit = Number(value), index += 1;
    else if (argument === '--report' && value) options.report = value, index += 1;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.apply && options.explicitDryRun) throw new Error('Choose either --apply or --dry-run, not both.');
  if (options.replaceExisting && !options.profileId) {
    throw new Error('--replace-existing requires an explicit --profile PROFILE_ID selection.');
  }
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
  --apply                Upload a missing Drive gallery and create ordered profile_images rows.
  --profile PROFILE_ID   Inspect or migrate one profile in the dataset.
  --replace-existing     Explicitly replace that profile's relational gallery.
  --limit NUMBER         Process at most NUMBER selected profiles.
  --report PATH          CSV report path (default includes the dataset slug).

Required in .env.local:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_STORAGE_BUCKET=profile-images

The command never activates or archives datasets. Direct arbitrary URLs are
reported but never fetched. Replacement requires --profile and swaps metadata
transactionally only after all supported Drive images validate and upload.
Apply the checked-in Supabase migrations first.`);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeReport(filePath, rows) {
  const headers = [
    'profile_id', 'name', 'status', 'category', 'drive_source',
    'files_discovered', 'supported_images', 'uploaded', 'skipped_existing',
    'rejected', 'diagnostics', 'image_dimensions', 'metadata_strategy',
    'primary_storage_path', 'detail',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = {
      profile_id: row.profileId,
      name: row.name,
      status: row.status,
      category: row.category,
      drive_source: row.sourceKind,
      files_discovered: row.filesDiscovered,
      supported_images: row.supportedImages,
      uploaded: row.uploaded,
      skipped_existing: row.skippedExisting,
      rejected: JSON.stringify(row.rejected || []),
      diagnostics: JSON.stringify(row.diagnostics || []),
      image_dimensions: JSON.stringify(row.imageDimensions || []),
      metadata_strategy: row.metadataStrategy || '',
      primary_storage_path: row.primaryStoragePath,
      detail: row.detail,
    };
    lines.push(headers.map((header) => csvCell(values[header])).join(','));
  }
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${lines.join('\n')}\n`, 'utf8');
  return absolutePath;
}

function profileFromRow(row, profileImages = []) {
  return {
    ...(row.public_data || {}),
    id: row.profile_id,
    driveFileId: row.drive_file_id || '',
    driveFolderId: row.drive_folder_id || '',
    imageKind: row.image_kind || row.public_data?.imageKind || '',
    storageImagePath: row.storage_image_path || row.public_data?.storageImagePath || '',
    imageClearedByAdmin: row.image_cleared_by_admin === true,
    profileImages,
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
    .select('profile_id,public_data,drive_file_id,drive_folder_id,image_kind,storage_image_path,image_cleared_by_admin,ordinal')
    .eq('dataset_id', dataset.id)
    .order('ordinal', { ascending: true })
    .limit(1000);
  if (profilesError) {
    throw new Error(`Dataset profiles could not be read. Apply the image Storage migration first. ${profilesError.message}`);
  }
  if ((rows || []).length !== dataset.profile_count) {
    throw new Error(`Dataset integrity check failed: expected ${dataset.profile_count} profiles, received ${(rows || []).length}.`);
  }
  const { data: imageRows, error: imagesError } = await supabase
    .from('profile_images')
    .select('id,profile_id,storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary,focal_x,focal_y,display_mode')
    .eq('dataset_id', dataset.id)
    .order('position', { ascending: true });
  if (imagesError) {
    throw new Error(`Relational profile images could not be read. Apply the profile_images migrations first. ${imagesError.message}`);
  }
  const imagesByProfile = new Map();
  for (const image of imageRows || []) {
    const images = imagesByProfile.get(image.profile_id) || [];
    images.push({
      id: image.id,
      storagePath: image.storage_path,
      discoveryStoragePath: image.discovery_storage_path || '',
      position: image.position,
      isPrimary: image.is_primary,
      focalX: image.focal_x,
      focalY: image.focal_y,
      displayMode: image.display_mode,
    });
    imagesByProfile.set(image.profile_id, images);
  }
  return {
    dataset,
    profiles: (rows || []).map((row) => profileFromRow(row, imagesByProfile.get(row.profile_id) || [])),
  };
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

  async function listImagePaths(profileId) {
    const directory = `${datasetSlug}/${profileId}`;
    const { data, error } = await storage.list(directory, { limit: 100 });
    if (error) throw new Error(`Storage inspection failed for ${directory}: ${error.message}`);
    return (data || [])
      .map((object) => `${directory}/${object.name}`)
      .filter(isValidStorageImagePath);
  }

  async function listPrimaryPaths(profileId) {
    return (await listImagePaths(profileId))
      .filter((storagePath) => /\/primary\.(?:avif|gif|jpg|png|webp)$/.test(storagePath));
  }

  return {
    async pathExists(storagePath) {
      const parts = storagePath.split('/');
      const paths = await listImagePaths(parts[1]);
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
    async remove(storagePath) {
      const { error } = await storage.remove([storagePath]);
      if (error) throw new Error(`Supabase Storage cleanup failed: ${error.message}`);
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
  console.log(`${options.dryRun ? 'DRY RUN' : 'APPLY'}${options.replaceExisting ? ' TARGETED REPLACEMENT' : ''}: ${dataset.name} (${dataset.slug}, ${dataset.status})`);
  console.log(`Selected ${profiles.length} of ${allProfiles.length} profiles. Drive mode: ${driveAuth.mode}.`);

  const result = await migrateDatasetProfileGalleries({
    dataset,
    profiles,
    dryRun: options.dryRun,
    replaceExisting: options.replaceExisting,
    ingestGallery: (profile) => ingestProfileImages({
      profile,
      datasetSlug: dataset.slug,
      driveAuth,
      dryRun: options.dryRun,
      requireAllSupported: options.replaceExisting,
      upload: inspector.upload.bind(inspector),
      remove: inspector.remove.bind(inspector),
    }),
    createImage: async ({ profile, image, makePrimary }) => {
      const { data, error } = await supabase.rpc('create_profile_image_with_derivative', {
        requested_dataset_id: dataset.id,
        requested_profile_id: profile.id,
        requested_image_id: image.imageId,
        requested_storage_path: image.storagePath,
        requested_discovery_storage_path: image.discoveryStoragePath,
        requested_discovery_width: image.discoveryWidth,
        requested_discovery_height: image.discoveryHeight,
        requested_discovery_mime_type: image.discoveryMimeType,
        requested_discovery_byte_length: image.discoveryByteLength,
        requested_make_primary: makePrimary,
      });
      if (!error && data?.storagePath === image.storagePath) return data;
      const { data: confirmed } = await supabase
        .from('profile_images')
        .select('id,storage_path,discovery_storage_path,position,is_primary')
        .eq('id', image.imageId)
        .eq('dataset_id', dataset.id)
        .eq('profile_id', profile.id)
        .maybeSingle();
      if (
        confirmed?.storage_path === image.storagePath
        && confirmed?.discovery_storage_path === image.discoveryStoragePath
      ) {
        return {
          id: confirmed.id,
          storagePath: confirmed.storage_path,
          discoveryStoragePath: confirmed.discovery_storage_path,
          position: confirmed.position,
          isPrimary: confirmed.is_primary,
        };
      }
      throw new Error(`Profile image metadata insert failed: ${error?.message || 'the RPC did not confirm the requested path'}`);
    },
    replaceGallery: async ({ profile, plan }) => {
      const { data, error } = await supabase.rpc('replace_profile_image_gallery_with_derivatives', {
        requested_dataset_id: dataset.id,
        requested_profile_id: profile.id,
        expected_existing_image_ids: plan.expectedExistingImageIds,
        replacement_images: plan.replacementRows,
      });
      if (!error && Number(data?.replacementCount || 0) === plan.replacementRows.length) {
        return data;
      }

      const confirmation = await supabase
        .from('profile_images')
        .select('id,storage_path,discovery_storage_path,position,is_primary')
        .eq('dataset_id', dataset.id)
        .eq('profile_id', profile.id)
        .order('position', { ascending: true });
      if (confirmation.error) {
        const uncertain = new Error(
          `The replacement result could not be confirmed after an RPC problem: ${error?.message || 'unexpected response'}`,
        );
        uncertain.preserveStagedObjects = true;
        throw uncertain;
      }
      const confirmedRows = confirmation.data || [];
      const replacementConfirmed = confirmedRows.length === plan.replacementRows.length
        && confirmedRows.every((row, index) => {
          const expected = plan.replacementRows[index];
          return row.id === expected.imageId
            && row.storage_path === expected.storagePath
            && row.discovery_storage_path === expected.discoveryStoragePath
            && row.position === expected.position
            && row.is_primary === expected.isPrimary;
        });
      if (replacementConfirmed) {
        return { replacementCount: confirmedRows.length, confirmedAfterRpcProblem: true };
      }
      throw new Error(`Transactional profile gallery replacement failed: ${error?.message || 'the RPC did not confirm the requested gallery'}`);
    },
    removeStorage: inspector.remove.bind(inspector),
    onRow(row) {
      console.log(
        `${row.profileId}: ${row.status}${row.category ? ` (${row.category})` : ''}; `
        + `source=${row.sourceKind || 'none'} discovered=${row.filesDiscovered} `
        + `supported=${row.supportedImages} uploaded=${row.uploaded} `
        + `existing=${row.skippedExisting} rejected=${row.rejected.length} `
        + `diagnostics=${row.diagnostics.length}`,
      );
      for (const image of row.imageDimensions || []) {
        console.log(
          `  ${image.name || image.driveFileId || 'image'}: ${image.width}x${image.height}; `
          + `${image.byteLength} bytes; discovery=${image.discoveryWidth}x${image.discoveryHeight} `
          + `${image.discoveryByteLength} bytes ${image.discoveryMimeType}; source=${image.downloadSource}`,
        );
      }
      for (const diagnostic of row.diagnostics || []) {
        console.log(`  diagnostic=${diagnostic.category}: ${diagnostic.detail}`);
      }
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
