#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { applyOne, approvalRequest, isApproved, planMigrationEntry, rollbackOne, sameImageMetadata, samePaths } from '../lib/profile-image-compression-migration.js';
import { optimizeCanonical, sameImageSnapshot, sha256 } from '../lib/profile-image-compression.js';
import { DEFAULT_PROFILE_IMAGE_BUCKET, storageImagePublicUrl } from '../lib/profile-images.js';

const COLUMNS = 'id,dataset_id,profile_id,storage_path,profile_storage_path,discovery_storage_path,profile_width,profile_height,profile_mime_type,profile_byte_length,discovery_width,discovery_height,discovery_mime_type,discovery_byte_length,updated_at,position,is_primary,focal_x,focal_y,display_mode,source_type,source_drive_file_id,source_drive_folder_id,source_filename,source_modified_time,source_size';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const modes = new Set(['plan', 'verify', 'apply', 'rollback', 'status']);
const args = { mode: 'status', manifest: 'reports/image-compression-dry-run/manifest.json',
  journal: '', approvalFile: '', imageId: '', execute: false, confirmImageId: '',
  acceptUnverifiedCapacity: false, help: false };
let index = 2;
if (modes.has(process.argv[index])) args.mode = process.argv[index++];
for (; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--help') args.help = true;
  else if (arg === '--execute') args.execute = true;
  else if (arg === '--accept-unverified-capacity') args.acceptUnverifiedCapacity = true;
  else {
    const key = { '--manifest': 'manifest', '--journal': 'journal', '--approval-file': 'approvalFile',
      '--image-id': 'imageId', '--confirm-image-id': 'confirmImageId' }[arg];
    if (!key || !process.argv[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    args[key] = process.argv[++index];
  }
}
if (args.help) {
  console.log(`Local compression migration: status (default), plan, verify, apply, rollback.
  --manifest FILE --journal FILE --image-id UUID --approval-file FILE
  Mutations require --execute --confirm-image-id UUID; apply also needs
  --accept-unverified-capacity and an exact per-image visual approval.
  No mode deletes Storage objects.`);
  process.exit(0);
}
if (['apply', 'rollback'].includes(args.mode)
  && (!args.execute || !UUID.test(args.imageId) || args.confirmImageId !== args.imageId)) {
  throw new Error('Mutation requires --image-id UUID --execute --confirm-image-id SAME_UUID.');
}
if (args.mode === 'apply' && !args.acceptUnverifiedCapacity) {
  throw new Error('Apply requires --accept-unverified-capacity after checking the project quota state.');
}
if (args.imageId && !UUID.test(args.imageId)) throw new Error('Invalid image ID.');
const manifestPath = path.resolve(args.manifest);
const baseDir = path.dirname(manifestPath);
const journalPath = path.resolve(args.journal || path.join(baseDir, 'migration-journal.json'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const approvals = args.approvalFile ? JSON.parse(fs.readFileSync(path.resolve(args.approvalFile), 'utf8')) : [];
const entries = Object.values(manifest.entries || {})
  .filter((entry) => !args.imageId || entry.imageId === args.imageId)
  .filter((entry) => ['validated', 'ready_for_migration'].includes(entry.status));
if (args.imageId && entries.length !== 1) throw new Error('The selected image has no validated candidate.');
const journal = fs.existsSync(journalPath)
  ? JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  : { version: 1, createdAt: new Date().toISOString(), entries: {} };
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function journalEntry(plan) {
  const existing = journal.entries[plan.imageId];
  if (existing && (existing.datasetId !== plan.datasetId || existing.profileId !== plan.profileId
    || existing.originalSha256 !== plan.originalSha256 || existing.optimizedSha256 !== plan.optimizedSha256
    || JSON.stringify(existing.oldPaths) !== JSON.stringify(plan.oldPaths)
    || JSON.stringify(existing.newPaths) !== JSON.stringify(plan.newPaths))) {
    throw new Error('Existing journal entry does not match the selected manifest candidate.');
  }
  return existing || (journal.entries[plan.imageId] = { datasetId: plan.datasetId, profileId: plan.profileId,
    imageId: plan.imageId, oldPaths: plan.oldPaths, newPaths: plan.newPaths,
    originalBytes: plan.originalSize, optimizedBytes: plan.proposedSize,
    originalSha256: plan.originalSha256, optimizedSha256: plan.optimizedSha256,
    status: 'planned', uploads: {}, dbSwitchStatus: 'pending', postVerificationStatus: 'pending',
    rollbackAvailable: true, errors: [] });
}
const plans = entries.map((entry) => planMigrationEntry(entry, manifest.config));
if (args.mode === 'status') {
  const statuses = plans.map((plan) => ({ imageId: plan.imageId, profileId: plan.profileId,
    status: journal.entries[plan.imageId]?.status || (isApproved(plan, approvals) ? 'approved' : 'planned'),
    projectedSavingsBytes: plan.savingsBytes,
    actualStorageDeltaBytes: Object.values(journal.entries[plan.imageId]?.uploads || {})
      .reduce((n, upload) => n + (upload.status === 'verified' ? upload.bytes : 0), 0) }));
  console.log(JSON.stringify({ readOnly: true, statuses,
    projectedSavingsBytes: statuses.reduce((n, row) => n + row.projectedSavingsBytes, 0),
    actualStorageDeltaBytes: statuses.reduce((n, row) => n + row.actualStorageDeltaBytes, 0),
    note: 'Old objects are retained; apply temporarily increases Storage. Net savings require separately approved cleanup.' }, null, 2));
  process.exit(0);
}
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase service configuration is required; run with node --env-file=.env.local.');
const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;
if (bucket !== DEFAULT_PROFILE_IMAGE_BUCKET) throw new Error('Unexpected Storage bucket.');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const storage = client.storage.from(bucket);
async function readRow(plan) {
  const { data, error } = await client.from('profile_images').select(COLUMNS)
    .eq('id', plan.imageId).eq('dataset_id', plan.datasetId).eq('profile_id', plan.profileId).maybeSingle();
  if (error) throw new Error(`Image read failed: ${error.message}`);
  return data;
}
async function readFallback(plan) {
  const { data, error } = await client.from('dataset_profiles').select('storage_image_path')
    .eq('dataset_id', plan.datasetId).eq('profile_id', plan.profileId).maybeSingle();
  if (error || !data) throw new Error(`Primary fallback read failed: ${error?.message || 'missing'}`);
  return data.storage_image_path;
}
async function readObject(objectPath) {
  const { data, error } = await storage.download(objectPath);
  if (error) {
    if (Number(error.statusCode || error.status) === 404 || /not found|Object not found/i.test(error.message)) return null;
    throw new Error(`Storage read failed: ${error.message}`);
  }
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}
async function assertPublic(plan, row, paths) {
  if (!samePaths(row, paths)) return false;
  if (row.is_primary && await readFallback(plan) !== paths.canonical) return false;
  if (row.id !== plan.imageId || row.dataset_id !== plan.datasetId || row.profile_id !== plan.profileId
    || row.position !== plan.oldSnapshot.position || row.is_primary !== plan.oldSnapshot.is_primary
    || !sameImageMetadata(plan.oldSnapshot, row)) return false;
  for (const objectPath of [paths.canonical, paths.profile, paths.discovery].filter(Boolean)) {
    const publicUrl = storageImagePublicUrl({ supabaseUrl: url, bucket, storagePath: objectPath });
    if (!publicUrl) return false;
    const response = await fetch(publicUrl, { method: 'HEAD' });
    if (!response.ok) return false;
  }
  return true;
}
async function storageInventory() {
  const { data: buckets, error: bucketError } = await client.storage.listBuckets();
  if (bucketError || !buckets?.some((item) => item.name === bucket)) throw new Error('Bucket inventory unavailable.');
  let frontier = [''], totalBytes = 0, objectCount = 0;
  while (frontier.length) {
    const next = [];
    for (let start = 0; start < frontier.length; start += 8) {
      const batch = await Promise.all(frontier.slice(start, start + 8).map(async (folder) => {
        const all = [];
        for (let offset = 0; ; offset += 1000) {
          let response;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            response = await storage.list(folder, { limit: 1000, offset });
            if (!response.error || !/fetch failed/i.test(response.error.message)) break;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
          const { data, error } = response;
          if (error) throw new Error(`Storage inventory failed: ${error.message}`);
          all.push(...data);
          if (data.length < 1000) break;
        }
        return { folder, all };
      }));
      for (const { folder, all } of batch) for (const object of all) {
        const objectPath = folder ? `${folder}/${object.name}` : object.name;
        if (object.id === null) next.push(objectPath);
        else { objectCount += 1; totalBytes += Number(object.metadata?.size || 0); }
      }
    }
    frontier = next;
  }
  return { bucket, objectCount, totalBytes, freeAllowanceBytes: 1_000_000_000,
    uploadPermission: 'unverified without a write',
    bucketRestrictions: buckets.find((item) => item.name === bucket) };
}
async function inspect(plan) {
  const current = await readRow(plan);
  const primaryFallback = current?.is_primary ? await readFallback(plan) : null;
  const pathState = samePaths(current, plan.newPaths) ? 'new'
    : sameImageSnapshot(plan.oldSnapshot, current) ? 'old' : 'conflict';
  const oldObject = await readObject(plan.oldPaths.canonical);
  const derivativeObjects = await Promise.all([plan.oldPaths.profile, plan.oldPaths.discovery]
    .filter(Boolean).map((item) => readObject(item)));
  const outputPath = path.join(baseDir, 'review', plan.imageId,
    `optimized-full.${plan.proposedFormat === 'jpeg' ? 'jpg' : 'webp'}`);
  const optimized = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
  let optimizedBytesValid = Boolean(optimized && optimized.length === plan.proposedSize
    && sha256(optimized) === plan.optimizedSha256);
  if (optimizedBytesValid) {
    try {
      const metadata = await sharp(optimized).metadata();
      const entry = manifest.entries[plan.imageId];
      optimizedBytesValid = metadata.format === plan.proposedFormat
        && metadata.width === entry.dimensions?.width && metadata.height === entry.dimensions?.height
        && (metadata.orientation || 1) === 1 && (!entry.hasAlpha || metadata.hasAlpha);
    } catch { optimizedBytesValid = false; }
  }
  const technicallyReady = pathState === 'old' && Boolean(oldObject)
    && sha256(oldObject) === plan.originalSha256 && optimizedBytesValid
    && derivativeObjects.every(Boolean)
    && (!current?.is_primary || primaryFallback === current.storage_path);
  return { imageId: plan.imageId, profileId: plan.profileId, pathState,
    oldCanonicalPresent: Boolean(oldObject), originalHashMatches: oldObject ? sha256(oldObject) === plan.originalSha256 : false,
    optimizedBytesValid,
    oldDerivativesPresent: derivativeObjects.every(Boolean),
    primaryFallbackConsistent: !current?.is_primary || primaryFallback === current.storage_path,
    technicallyReady,
    safeToMigrate: technicallyReady && isApproved(plan, approvals),
    visualApproval: isApproved(plan, approvals) };
}
if (args.mode === 'plan' || args.mode === 'verify') {
  const checks = [];
  for (const plan of plans) checks.push(await inspect(plan));
  const capacity = await storageInventory();
  const eligible = plans.filter((plan) => checks.find((check) => check.imageId === plan.imageId)?.technicallyReady);
  const approvedEligible = plans.filter((plan) => checks.find((check) => check.imageId === plan.imageId)?.safeToMigrate);
  const plannedUploadBytes = eligible.reduce((n, plan) => n + plan.proposedSize
    + (plan.copiedDerivatives ? Number(plan.oldSnapshot.profile_byte_length || 0)
      + Number(plan.oldSnapshot.discovery_byte_length || 0) : 0), 0);
  const oneSetPeakExtraBytes = Math.max(0, ...eligible.map((plan) => plan.proposedSize
    + (plan.copiedDerivatives ? Number(plan.oldSnapshot.profile_byte_length || 0)
      + Number(plan.oldSnapshot.discovery_byte_length || 0) : 0)));
  const report = { readOnly: true, mode: args.mode, createdAt: new Date().toISOString(),
    capacity: { ...capacity, bucketRestrictions: {
      fileSizeLimit: capacity.bucketRestrictions?.file_size_limit || null,
      allowedMimeTypes: capacity.bucketRestrictions?.allowed_mime_types || null },
      estimatedOneSetPeakBytes: capacity.totalBytes + oneSetPeakExtraBytes,
      plannedUploadBytes, oneSetPeakExtraBytes,
      estimatedDownloadEgressBytes: eligible.reduce((n, plan) => n + plan.originalSize
        + (plan.copiedDerivatives ? Number(plan.oldSnapshot.profile_byte_length || 0)
          + Number(plan.oldSnapshot.discovery_byte_length || 0) : 0), 0) },
    checks, projectedNetSavingsBytesAfterSeparateCleanup: eligible.reduce((n, plan) => n + plan.savingsBytes, 0),
    approvedNetSavingsBytesAfterSeparateCleanup: approvedEligible.reduce((n, plan) => n + plan.savingsBytes, 0),
    approvalRequests: plans.map(approvalRequest),
    blockers: checks.filter((check) => !check.technicallyReady),
    awaitingVisualApproval: checks.filter((check) => check.technicallyReady && !check.visualApproval).map((check) => check.imageId) };
  atomicJson(path.join(baseDir, `migration-${args.mode}.json`), report);
  console.log(JSON.stringify({ report: path.join(baseDir, `migration-${args.mode}.json`),
    images: checks.length, technicallyReady: eligible.length, approved: approvedEligible.length,
    blockers: report.blockers.length,
    storageBytes: capacity.totalBytes, uploadPermission: capacity.uploadPermission,
    oneSetPeakExtraBytes, projectedNetSavingsBytesAfterSeparateCleanup: report.projectedNetSavingsBytesAfterSeparateCleanup }, null, 2));
  process.exit(0);
}
const plan = plans[0];
const record = journalEntry(plan);
const adapters = {
  readRow,
  readObject,
  async upload(asset) {
    const { error } = await storage.upload(asset.path, asset.bytes,
      { contentType: asset.contentType, cacheControl: '31536000', upsert: false });
    if (error) throw new Error(error.message);
  },
  async saveJournal() { atomicJson(journalPath, journal); },
  async swap(plan, expected, paths, rollback) {
    const { data, error } = await client.rpc('swap_profile_image_compression_assets', {
      requested_dataset_id: plan.datasetId, requested_profile_id: plan.profileId,
      requested_image_id: plan.imageId, expected_row: expected,
      replacement_paths: paths, requested_rollback: rollback,
    });
    if (error) throw new Error(error.message);
    return data;
  },
  async verifyResolved(plan, row) { return assertPublic(plan, row, plan.newPaths); },
  async prepareAssets(plan) {
    const original = await readObject(plan.oldPaths.canonical);
    if (!original || original.length !== plan.originalSize || sha256(original) !== plan.originalSha256) {
      throw new Error('Original canonical changed after visual approval.');
    }
    const outputPath = path.join(baseDir, 'review', plan.imageId,
      `optimized-full.${plan.proposedFormat === 'jpeg' ? 'jpg' : 'webp'}`);
    let optimized;
    if (fs.existsSync(outputPath)) optimized = fs.readFileSync(outputPath);
    else {
      const generated = await optimizeCanonical(original, plan.settings);
      if (generated.status !== 'validated') throw new Error('Approved compression no longer validates.');
      optimized = generated.bytes;
    }
    if (optimized.length !== plan.proposedSize || sha256(optimized) !== plan.optimizedSha256) {
      throw new Error('Approved optimized bytes changed.');
    }
    const metadata = await sharp(optimized).metadata();
    if (metadata.format !== plan.proposedFormat) throw new Error('Optimized format differs from path.');
    const entry = manifest.entries[plan.imageId];
    if (metadata.width !== entry.dimensions?.width || metadata.height !== entry.dimensions?.height
      || (metadata.orientation || 1) !== 1 || (entry.hasAlpha && !metadata.hasAlpha)) {
      throw new Error('Optimized dimensions, orientation, or alpha changed.');
    }
    const assets = [{ path: plan.newPaths.canonical, bytes: optimized,
      contentType: plan.proposedFormat === 'jpeg' ? 'image/jpeg' : 'image/webp' }];
    if (plan.copiedDerivatives) {
      for (const [oldPath, newPath] of [[plan.oldPaths.profile, plan.newPaths.profile],
        [plan.oldPaths.discovery, plan.newPaths.discovery]]) {
        const bytes = await readObject(oldPath);
        if (!bytes) throw new Error('Existing derivative is missing.');
        assets.push({ path: newPath, bytes, contentType: 'image/webp' });
      }
    }
    return assets;
  },
};
let result;
if (args.mode === 'apply') {
  if (!args.approvalFile || !isApproved(plan, approvals)) throw new Error('Exact per-image visual approval is required.');
  const capacity = await storageInventory();
  const requiredBytes = plan.proposedSize + (plan.copiedDerivatives
    ? Number(plan.oldSnapshot.profile_byte_length || 0) + Number(plan.oldSnapshot.discovery_byte_length || 0) : 0);
  if (capacity.bucketRestrictions?.file_size_limit && plan.proposedSize > capacity.bucketRestrictions.file_size_limit) {
    throw new Error('Proposed object exceeds bucket file size limit.');
  }
  console.log(JSON.stringify({ currentStorageBytes: capacity.totalBytes,
    expectedPeakBytes: capacity.totalBytes + requiredBytes, uploadPermission: 'unverified without a write' }));
  result = await applyOne(plan, true, record, adapters);
} else {
  result = await rollbackOne(plan, record, adapters);
}
record.status = result.status;
if (result.reason) record.errors.push({ at: new Date().toISOString(), reason: result.reason });
atomicJson(journalPath, journal);
console.log(JSON.stringify({ imageId: plan.imageId, ...result, journal: journalPath }, null, 2));
if (!['verified', 'rolled_back'].includes(result.status)) process.exitCode = 2;
