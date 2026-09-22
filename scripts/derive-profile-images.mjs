#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { deriveMissingProfileImages } from '../lib/profile-image-derivatives.js';
import {
  buildDiscoveryDerivativeStoragePath,
  DEFAULT_PROFILE_IMAGE_BUCKET,
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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
    profileId: '',
    concurrency: 2,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith('-') && !options.datasetSlug) options.datasetSlug = argument;
    else if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.explicitDryRun = true;
    else if (argument === '--profile' && value) options.profileId = value, index += 1;
    else if (argument === '--concurrency' && value) options.concurrency = Number(value), index += 1;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.apply && options.explicitDryRun) throw new Error('Choose either --apply or --dry-run, not both.');
  if (options.datasetSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.datasetSlug)) {
    throw new Error('Dataset slug must contain lowercase letters, numbers, and single hyphens only.');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error('--concurrency must be an integer from 1 through 4.');
  }
  options.dryRun = !options.apply;
  return options;
}

function printHelp() {
  console.log(`Generate immutable Discovery derivatives for existing relational profile images.

Usage:
  npm run images:derive -- <dataset-slug> --dry-run
  npm run images:derive -- <dataset-slug> --apply
  npm run images:derive -- <dataset-slug> --dry-run --profile PROFILE_ID

Options:
  --dry-run              Default. Download and derive in memory; never upload or update rows.
  --apply                Upload each derivative, then atomically attach its metadata.
  --profile PROFILE_ID   Restrict work to one profile.
  --concurrency NUMBER   Parallel image limit, from 1 through 4 (default 2).

Apply mode requires the checked-in derivative migration. A failed image keeps
its canonical path untouched and does not stop the remaining images.`);
}

function mib(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

async function loadDataset(supabase, datasetSlug, profileId) {
  const { data: dataset, error: datasetError } = await supabase
    .from('datasets')
    .select('id,slug,name')
    .eq('slug', datasetSlug)
    .single();
  if (datasetError || !dataset) throw new Error(`Dataset ${datasetSlug} could not be read: ${datasetError?.message || 'not found'}`);

  let profilesQuery = supabase
    .from('dataset_profiles')
    .select('profile_id,public_data,image_cleared_by_admin')
    .eq('dataset_id', dataset.id);
  if (profileId) profilesQuery = profilesQuery.eq('profile_id', profileId);
  const { data: profiles, error: profilesError } = await profilesQuery.limit(1000);
  if (profilesError) throw new Error(`Dataset profiles could not be read: ${profilesError.message}`);
  if (profileId && !(profiles || []).length) throw new Error(`Profile ${profileId} was not found in ${datasetSlug}.`);

  let schemaReady = true;
  let imageQuery = supabase
    .from('profile_images')
    .select('id,profile_id,storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,position,is_primary')
    .eq('dataset_id', dataset.id);
  if (profileId) imageQuery = imageQuery.eq('profile_id', profileId);
  let { data: imageRows, error: imagesError } = await imageQuery.order('position', { ascending: true });
  if (imagesError) {
    schemaReady = false;
    let compatibilityQuery = supabase
      .from('profile_images')
      .select('id,profile_id,storage_path,position,is_primary')
      .eq('dataset_id', dataset.id);
    if (profileId) compatibilityQuery = compatibilityQuery.eq('profile_id', profileId);
    const compatibility = await compatibilityQuery.order('position', { ascending: true });
    imageRows = compatibility.data;
    imagesError = compatibility.error;
  }
  if (imagesError) throw new Error(`Relational images could not be read: ${imagesError.message}`);

  const profilesById = new Map((profiles || []).map((profile) => [profile.profile_id, profile]));
  return {
    dataset,
    schemaReady,
    images: (imageRows || []).map((image) => ({
      id: image.id,
      profileId: image.profile_id,
      profileName: String(profilesById.get(image.profile_id)?.public_data?.name || image.profile_id),
      storagePath: image.storage_path,
      discoveryStoragePath: image.discovery_storage_path || '',
      isPrimary: image.is_primary === true,
      position: image.position,
      imageClearedByAdmin: profilesById.get(image.profile_id)?.image_cleared_by_admin === true,
    })),
  };
}

export async function run(options) {
  if (!options.datasetSlug) throw new Error('A dataset slug is required.');
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const loaded = await loadDataset(supabase, options.datasetSlug, options.profileId);
  if (options.apply && !loaded.schemaReady) {
    throw new Error('Apply the profile image derivative migration before using --apply. Dry-run remains available.');
  }
  const storage = supabase.storage.from(process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET);

  const result = await deriveMissingProfileImages({
    images: loaded.images,
    dryRun: options.dryRun,
    concurrency: options.concurrency,
    download: async (image) => {
      const { data, error } = await storage.download(image.storagePath);
      if (error || !data) throw new Error(`Canonical image could not be read: ${error?.message || 'not found'}`);
      return Buffer.from(await data.arrayBuffer());
    },
    upload: async ({ storagePath, bytes, contentType }) => {
      const { error } = await storage.upload(storagePath, bytes, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
      if (error) throw new Error(`Derivative upload failed: ${error.message}`);
    },
    updateMetadata: async ({ image, derivativePath, derivative }) => {
      const { error } = await supabase.rpc('set_profile_image_discovery_derivative', {
        requested_dataset_id: loaded.dataset.id,
        requested_profile_id: image.profileId,
        requested_image_id: image.id,
        expected_storage_path: image.storagePath,
        requested_discovery_storage_path: derivativePath,
        requested_discovery_width: derivative.width,
        requested_discovery_height: derivative.height,
        requested_discovery_mime_type: derivative.contentType,
        requested_discovery_byte_length: derivative.byteLength,
      });
      if (!error) return;
      const confirmation = await supabase
        .from('profile_images')
        .select('storage_path,discovery_storage_path,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length')
        .eq('id', image.id)
        .eq('dataset_id', loaded.dataset.id)
        .eq('profile_id', image.profileId)
        .maybeSingle();
      if (
        !confirmation.error
        && confirmation.data?.storage_path === image.storagePath
        && confirmation.data?.discovery_storage_path === derivativePath
        && confirmation.data?.discovery_width === derivative.width
        && confirmation.data?.discovery_height === derivative.height
        && confirmation.data?.discovery_mime_type === derivative.contentType
        && Number(confirmation.data?.discovery_byte_length) === derivative.byteLength
      ) return;
      const metadataError = new Error(`Derivative metadata update failed: ${error.message}`);
      if (confirmation.error) metadataError.preserveStagedObject = true;
      throw metadataError;
    },
    remove: async (storagePath) => {
      const { error } = await storage.remove([storagePath]);
      if (error) throw new Error(`Staged derivative cleanup failed: ${error.message}`);
    },
    buildDerivativePath: (image) => buildDiscoveryDerivativeStoragePath(
      loaded.dataset.slug,
      image.profileId,
      image.id,
    ),
    onRow: (row) => {
      const dimensions = row.discoveryWidth ? `${row.currentWidth}x${row.currentHeight} -> ${row.discoveryWidth}x${row.discoveryHeight}` : '-';
      const bytes = row.discoveryByteLength ? `${mib(row.currentBytes)} MiB -> ${mib(row.discoveryByteLength)} MiB` : '-';
      console.log(`${row.profileId} ${row.isPrimary ? 'primary' : 'secondary'} ${row.status} ${dimensions} ${bytes}`);
    },
  });

  console.log(JSON.stringify({
    mode: options.dryRun ? 'dry-run' : 'apply',
    dataset: loaded.dataset.slug,
    profile: options.profileId || null,
    derivativeSchemaReady: loaded.schemaReady,
    ...result.summary,
    totalCurrentMiB: mib(result.summary.totalCurrentBytes),
    estimatedDerivativeMiB: mib(result.summary.totalDerivativeBytes),
    currentPrimaryMiB: mib(result.summary.currentPrimaryBytes),
    estimatedPrimaryMiB: mib(result.summary.derivativePrimaryBytes),
  }, null, 2));
  return { ...result, schemaReady: loaded.schemaReady };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  await run(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
