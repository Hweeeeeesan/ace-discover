#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  cleanupApprovalRequest,
  cleanupCandidateFromMigration,
  deleteSupersededObject,
  evaluateCleanup,
  isCleanupApproved,
  stableHash,
  validateBackupRecord,
} from '../lib/profile-image-compression-cleanup.js';
import { DEFAULT_PROFILE_IMAGE_BUCKET, storageImagePublicUrl } from '../lib/profile-images.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const modes = new Set(['plan', 'verify', 'status', 'delete']);
const args = { mode: 'status', migrationJournal: 'reports/image-compression-dry-run/migration-journal.json',
  cleanupJournal: '', backupRecord: '', approvalFile: '', verificationFile: '', imageId: '',
  oldPath: '', retentionDays: 7, execute: false, confirmImageId: '', confirmOldPath: '', help: false };
let index = 2;
if (modes.has(process.argv[index])) args.mode = process.argv[index++];
for (; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--help') args.help = true;
  else if (arg === '--execute') args.execute = true;
  else {
    const key = { '--migration-journal': 'migrationJournal', '--cleanup-journal': 'cleanupJournal',
      '--backup-record': 'backupRecord', '--approval-file': 'approvalFile',
      '--verification-file': 'verificationFile', '--image-id': 'imageId', '--old-path': 'oldPath',
      '--retention-days': 'retentionDays', '--confirm-image-id': 'confirmImageId',
      '--confirm-old-path': 'confirmOldPath' }[arg];
    if (!key || !process.argv[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    args[key] = process.argv[++index];
  }
}
args.retentionDays = Number(args.retentionDays);
if (args.help) {
  console.log(`Independent compression cleanup: status (default), plan, verify, delete.
  --migration-journal FILE --cleanup-journal FILE --image-id UUID --old-path PATH
  --backup-record FILE --approval-file FILE --verification-file FILE --retention-days N
  Delete requires --execute --confirm-image-id UUID --confirm-old-path EXACT_PATH.
  There is no bulk delete and no generic confirmation flag.`);
  process.exit(0);
}
if (!Number.isInteger(args.retentionDays) || args.retentionDays < 1 || args.retentionDays > 365) {
  throw new Error('Retention days must be an integer from 1 to 365.');
}
if (args.imageId && !UUID.test(args.imageId)) throw new Error('Invalid image ID.');
if (args.mode === 'delete' && (!args.execute || !UUID.test(args.imageId)
  || args.confirmImageId !== args.imageId || !args.oldPath || args.confirmOldPath !== args.oldPath)) {
  throw new Error('Delete requires an exact image, old path, --execute, and matching confirmations.');
}

const migrationJournalPath = path.resolve(args.migrationJournal);
const baseDir = path.dirname(migrationJournalPath);
const cleanupJournalPath = path.resolve(args.cleanupJournal || path.join(baseDir, 'cleanup-journal.json'));
const migrationJournal = JSON.parse(fs.readFileSync(migrationJournalPath, 'utf8'));
const migrationEntries = Object.values(migrationJournal.entries || {})
  .filter((entry) => !args.imageId || entry.imageId === args.imageId);
if (args.imageId && migrationEntries.length !== 1) throw new Error('Selected image is absent from the migration journal.');
const candidates = migrationEntries.map(cleanupCandidateFromMigration);
const cleanupJournal = fs.existsSync(cleanupJournalPath)
  ? JSON.parse(fs.readFileSync(cleanupJournalPath, 'utf8'))
  : { version: 1, createdAt: new Date().toISOString(), entries: {} };

function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filename);
}

if (args.mode === 'status') {
  const entries = candidates.map((candidate) => ({ imageId: candidate.imageId,
    profileId: candidate.profileId, oldPath: candidate.oldPath,
    status: cleanupJournal.entries[candidate.imageId]?.status || 'not_planned',
    reclaimedBytes: cleanupJournal.entries[candidate.imageId]?.reclaimedBytes || 0 }));
  console.log(JSON.stringify({ readOnly: true, entries,
    cleanedObjects: entries.filter((entry) => entry.status === 'cleaned').length,
    actualReclaimedBytes: entries.reduce((sum, entry) => sum + entry.reclaimedBytes, 0) }, null, 2));
  process.exit(0);
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_PROFILE_IMAGE_BUCKET;
if (!url || !key) throw new Error('Supabase service configuration is required.');
if (bucket !== DEFAULT_PROFILE_IMAGE_BUCKET) throw new Error('Unexpected Storage bucket.');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const storage = client.storage.from(bucket);

async function allRows(table, columns) {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await client.from(table).select(columns).range(start, start + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function readObject(objectPath) {
  const { data, error } = await storage.download(objectPath);
  if (error) {
    if (Number(error.statusCode || error.status) === 404 || /not found|Object not found/i.test(error.message)) return null;
    throw new Error(`Storage read failed: ${error.message}`);
  }
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

async function protocolState() {
  const response = await fetch(`${url}/rest/v1/`, { headers: { apikey: key,
    Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' } });
  if (!response.ok) throw new Error(`OpenAPI read failed: ${response.status}`);
  const spec = await response.json();
  const reserve = spec.paths?.['/rpc/reserve_profile_image_compression_cleanup']?.post;
  const finalize = spec.paths?.['/rpc/finalize_profile_image_compression_cleanup']?.post;
  return { installed: Boolean(reserve && finalize), reserve: Boolean(reserve), finalize: Boolean(finalize) };
}

async function storageInventory() {
  let frontier = [''], totalBytes = 0, objectCount = 0;
  while (frontier.length) {
    const next = [];
    for (const folder of frontier) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await storage.list(folder, { limit: 1000, offset });
        if (error) throw new Error(`Storage inventory failed: ${error.message}`);
        for (const object of data) {
          const objectPath = folder ? `${folder}/${object.name}` : object.name;
          if (object.id === null) next.push(objectPath);
          else { objectCount += 1; totalBytes += Number(object.metadata?.size || 0); }
        }
        if (data.length < 1000) break;
      }
    }
    frontier = next;
  }
  return { objectCount, totalBytes };
}

function backupEvidence(candidate) {
  if (!args.backupRecord) return { validation: validateBackupRecord(candidate, null, null, null), recordSha256: null };
  const recordPath = path.resolve(args.backupRecord);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  let backupBytes = null, restoredBytes = null;
  try {
    backupBytes = fs.readFileSync(path.resolve(record.backupFile || ''));
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-compression-restore-'));
    const restorePath = path.join(restoreDir, path.basename(record.backupFile || 'original.bin'));
    fs.copyFileSync(path.resolve(record.backupFile || ''), restorePath);
    restoredBytes = fs.readFileSync(restorePath);
    fs.rmSync(restoreDir, { recursive: true });
  } catch { /* Converted to conservative blockers below. */ }
  return { record, validation: validateBackupRecord(candidate, record, backupBytes, restoredBytes),
    recordSha256: stableHash(record) };
}

const protocol = await protocolState();
const [imageRows, profileRows, datasets, imports] = await Promise.all([
  allRows('profile_images', 'id,dataset_id,profile_id,storage_path,profile_storage_path,discovery_storage_path'),
  allRows('dataset_profiles', 'dataset_id,profile_id,storage_image_path,public_data,public_overrides'),
  allRows('datasets', 'id,slug,status'),
  allRows('dataset_imports', 'id,target_dataset_id,normalized_profiles,expires_at'),
]);
const datasetStatus = new Map(datasets.map((dataset) => [dataset.id, dataset.status]));

async function collectEvidence(candidate, operationId = null) {
  const { data: currentRow, error } = await client.from('profile_images').select('*')
    .eq('id', candidate.imageId).eq('dataset_id', candidate.datasetId)
    .eq('profile_id', candidate.profileId).maybeSingle();
  if (error) throw new Error(`Image read failed: ${error.message}`);
  const [newBytes, oldBytes] = await Promise.all([readObject(candidate.newPath), readObject(candidate.oldPath)]);
  const textIncludes = (value) => JSON.stringify(value ?? {}).includes(candidate.oldPath);
  const referencedImages = imageRows.filter((row) => [row.storage_path, row.profile_storage_path,
    row.discovery_storage_path].includes(candidate.oldPath));
  const referencedProfiles = profileRows.filter((row) => row.storage_image_path === candidate.oldPath);
  const publicData = profileRows.filter((row) => textIncludes(row.public_data));
  const publicOverrides = profileRows.filter((row) => textIncludes(row.public_overrides));
  const archived = [...referencedImages, ...referencedProfiles, ...publicData, ...publicOverrides]
    .filter((row) => datasetStatus.get(row.dataset_id) === 'archived');
  const activeImports = imports.filter((item) => Date.parse(item.expires_at) > Date.now()
    && (item.target_dataset_id === candidate.datasetId || textIncludes(item.normalized_profiles)));
  let cleanupReservationConflict = false;
  if (protocol.installed) {
    const { data, error: reservationError } = await client.from('profile_image_compression_cleanups')
      .select('operation_id,status,old_storage_path').eq('old_storage_path', candidate.oldPath);
    if (reservationError) throw new Error(`Cleanup reservation read failed: ${reservationError.message}`);
    cleanupReservationConflict = data.some((item) => item.status === 'reserved' && item.operation_id !== operationId);
  }
  const backup = backupEvidence(candidate);
  const publicUrl = storageImagePublicUrl({ supabaseUrl: url, bucket, storagePath: candidate.newPath });
  const publicHead = publicUrl ? await fetch(publicUrl, { method: 'HEAD' }) : null;
  return { currentRow, newBytes, oldBytes,
    references: { profileImages: referencedImages, datasetProfiles: referencedProfiles,
      publicData, publicOverrides, archived },
    activeOperation: activeImports.length > 0,
    activeImports: activeImports.map((item) => item.id),
    cleanupReservationConflict, protocolInstalled: protocol.installed,
    backup: backup.validation, backupRecordSha256: backup.recordSha256,
    publicNewCanonicalStatus: publicHead?.status || null };
}

async function verifyCandidate(candidate, operationId = null) {
  const evidence = await collectEvidence(candidate, operationId);
  const verification = evaluateCleanup(candidate, evidence, { retentionDays: args.retentionDays });
  return { ...verification, publicNewCanonicalStatus: evidence.publicNewCanonicalStatus,
    activeImports: evidence.activeImports, backup: evidence.backup };
}

if (args.mode === 'plan' || args.mode === 'verify') {
  const inventory = await storageInventory();
  const results = [];
  for (const candidate of candidates) results.push(await verifyCandidate(candidate));
  const eligibleBytes = results.filter((item) => item.eligible)
    .reduce((sum, item) => sum + item.originalBytes, 0);
  const report = { readOnly: true, mode: args.mode, createdAt: new Date().toISOString(),
    protocol, retentionDays: args.retentionDays, currentStorageBytes: inventory.totalBytes,
    newCanonicalBytesStored: results.reduce((sum, item) => sum + item.optimizedBytes, 0),
    oldCanonicalBytesEligible: eligibleBytes,
    expectedStorageAfterDeletion: inventory.totalBytes - eligibleBytes,
    candidates: results,
    cleanupApprovalRequests: results.filter((item) => item.eligible).map(cleanupApprovalRequest),
    eligibleObjects: results.filter((item) => item.eligible).length,
    blockedObjects: results.filter((item) => !item.eligible).length };
  const reportPath = path.join(baseDir, `cleanup-${args.mode}.json`);
  atomicJson(reportPath, report);
  console.log(JSON.stringify({ report: reportPath, currentStorageBytes: inventory.totalBytes,
    eligibleObjects: report.eligibleObjects, blockedObjects: report.blockedObjects,
    oldCanonicalBytesEligible: eligibleBytes, expectedStorageAfterDeletion: report.expectedStorageAfterDeletion,
    blockers: results.map((item) => ({ imageId: item.imageId, blockers: item.blockers })) }, null, 2));
  process.exit(0);
}

if (!args.verificationFile || !args.approvalFile || !args.backupRecord) {
  throw new Error('Delete requires verification, cleanup approval, and backup record files.');
}
if (!protocol.installed) throw new Error('Guarded cleanup SQL protocol is not installed.');
const verificationReport = JSON.parse(fs.readFileSync(path.resolve(args.verificationFile), 'utf8'));
if (verificationReport.mode !== 'verify' || verificationReport.readOnly !== true
  || Date.now() - Date.parse(verificationReport.createdAt) > 15 * 60_000) {
  throw new Error('A successful cleanup verification from the last 15 minutes is required.');
}
const verification = verificationReport.candidates?.find((item) => item.imageId === args.imageId);
if (!verification?.eligible || verification.oldPath !== args.oldPath) throw new Error('Selected cleanup is not eligible.');
const approvals = JSON.parse(fs.readFileSync(path.resolve(args.approvalFile), 'utf8'));
if (!isCleanupApproved(verification, approvals)) throw new Error('Exact separate cleanup approval is required.');
const candidate = candidates[0];
const entry = cleanupJournal.entries[candidate.imageId] ||= { imageId: candidate.imageId,
  oldPath: candidate.oldPath, newPath: candidate.newPath, operationId: randomUUID(),
  status: 'authorized', verificationId: verification.verificationId, errors: [] };
if (entry.oldPath !== candidate.oldPath || entry.newPath !== candidate.newPath
  || entry.verificationId !== verification.verificationId) throw new Error('Cleanup journal conflicts with this verification.');
atomicJson(cleanupJournalPath, cleanupJournal);

const adapters = {
  readOld: readObject,
  saveJournal: async () => atomicJson(cleanupJournalPath, cleanupJournal),
  async reserve(item, operationId) {
    const { data, error } = await client.rpc('reserve_profile_image_compression_cleanup', {
      requested_operation_id: operationId, requested_dataset_id: item.datasetId,
      requested_profile_id: item.profileId, requested_image_id: item.imageId,
      requested_old_storage_path: item.oldPath, requested_new_storage_path: item.newPath,
      expected_updated_at: item.expectedRowUpdatedAt,
      requested_original_sha256: item.originalSha256,
      requested_optimized_sha256: item.optimizedSha256,
    });
    if (error) throw new Error(error.message);
    return data;
  },
  async verifyReserved(_item, operationId) { return verifyCandidate(candidate, operationId); },
  async deleteOld(oldPath) {
    const { data, error } = await storage.remove([oldPath]);
    if (error) throw new Error(error.message);
    if (!data?.some((item) => item.name === oldPath || item.name === path.basename(oldPath))) {
      throw new Error('Storage did not confirm the exact deleted path.');
    }
  },
  async finalize(item, operationId) {
    const { error } = await client.rpc('finalize_profile_image_compression_cleanup', {
      requested_operation_id: operationId, requested_image_id: item.imageId,
      requested_old_storage_path: item.oldPath, expected_updated_at: item.expectedRowUpdatedAt,
    });
    if (error) throw new Error(error.message);
  },
};
const result = await deleteSupersededObject(verification, true, entry, adapters);
if (result.reason) entry.errors.push({ at: new Date().toISOString(), reason: result.reason });
if (result.status === 'cleaned') {
  const after = await storageInventory();
  entry.actualStorageBytesAfter = after.totalBytes;
  entry.actualStorageMeasuredAt = new Date().toISOString();
}
atomicJson(cleanupJournalPath, cleanupJournal);
console.log(JSON.stringify({ imageId: candidate.imageId, oldPath: candidate.oldPath,
  ...result, cleanupJournal: cleanupJournalPath,
  actualStorageBytesAfter: entry.actualStorageBytesAfter || null }, null, 2));
if (result.status !== 'cleaned') process.exitCode = 2;
