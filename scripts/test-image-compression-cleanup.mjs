import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cleanupApprovalRequest,
  cleanupCandidateFromMigration,
  deleteSupersededObject,
  evaluateCleanup,
  isCleanupApproved,
  stableHash,
  validateBackupRecord,
} from '../lib/profile-image-compression-cleanup.js';
import { sha256 } from '../lib/profile-image-compression.js';

const imageId = '404b690f-d784-4858-9f64-3d78094120c2';
const datasetId = '124ea5be-f203-4667-8102-caeb3f1f65b0';
const operationId = '660d31fd-a9ce-4bd8-b6ca-daf18ad529dd';
const oldBytes = Buffer.from('recoverable original canonical');
const newBytes = Buffer.from('optimized canonical');
const oldPath = `fall-2026/test-person/${imageId}.jpg`;
const newPath = 'fall-2026/test-person/e56393c3-25a2-40cc-aba5-59e03938a0d4.jpg';
const row = { id: imageId, dataset_id: datasetId, profile_id: 'test-person', storage_path: newPath,
  profile_storage_path: `fall-2026/test-person/derived/${imageId}-profile.webp`,
  discovery_storage_path: `fall-2026/test-person/derived/${imageId}-discovery.webp`,
  profile_width: 1350, profile_height: 1800, profile_mime_type: 'image/webp', profile_byte_length: 100,
  discovery_width: 1050, discovery_height: 1400, discovery_mime_type: 'image/webp', discovery_byte_length: 80,
  updated_at: '2026-10-01T00:00:00Z', position: 1, is_primary: false, focal_x: 47, focal_y: 44,
  display_mode: 'cover', source_type: 'admin_upload', source_drive_file_id: null,
  source_drive_folder_id: null, source_filename: null, source_modified_time: null, source_size: null };
const migration = { imageId, datasetId, profileId: 'test-person', status: 'verified',
  dbSwitchStatus: 'committed', postVerificationStatus: 'verified', committedSnapshot: row,
  oldPaths: { canonical: oldPath }, newPaths: { canonical: newPath },
  originalSha256: sha256(oldBytes), optimizedSha256: sha256(newBytes),
  originalBytes: oldBytes.length, optimizedBytes: newBytes.length };
const candidate = cleanupCandidateFromMigration(migration);
assert.throws(() => cleanupCandidateFromMigration({ ...migration, status: 'applied' }), /not verified/);
assert.throws(() => cleanupCandidateFromMigration({ ...migration, committedSnapshot: null }), /incomplete/);

const backupRecord = { imageId, oldPath, originalSha256: sha256(oldBytes),
  independentOfSupabaseBucket: true, location: 'encrypted-offline-archive', backupFile: '/mounted/backup.jpg',
  verifiedAt: '2026-10-02T00:00:00Z', restoreTestedAt: '2026-10-03T00:00:00Z',
  restoreSha256: sha256(oldBytes) };
const backup = validateBackupRecord(candidate, backupRecord, oldBytes, Buffer.from(oldBytes));
assert.equal(backup.valid, true);
assert.ok(validateBackupRecord(candidate, null, null, null).blockers.includes('backup_record_missing'));
assert.ok(validateBackupRecord(candidate, backupRecord, Buffer.from('wrong'), oldBytes).blockers.includes('backup_hash_mismatch'));
assert.ok(validateBackupRecord(candidate, backupRecord, oldBytes, null).blockers.includes('backup_restore_failure'));
assert.ok(validateBackupRecord(candidate, { ...backupRecord, restoreSha256: sha256(newBytes) }, oldBytes, oldBytes)
  .blockers.includes('backup_restore_test_missing'));

function evidence(overrides = {}) {
  return { currentRow: row, newBytes, oldBytes,
    references: { profileImages: [], datasetProfiles: [], publicData: [], publicOverrides: [], archived: [] },
    activeOperation: false, cleanupReservationConflict: false, protocolInstalled: true,
    backup, backupRecordSha256: stableHash(backupRecord), ...overrides };
}
const verified = evaluateCleanup(candidate, evidence(), { retentionDays: 7, now: new Date('2026-10-10T00:00:00Z') });
assert.equal(verified.eligible, true);
for (const [change, blocker] of [
  [{ newBytes: null }, 'new_object_missing'],
  [{ newBytes: Buffer.from('wrong') }, 'new_object_hash_mismatch'],
  [{ oldBytes: null }, 'old_object_missing'],
  [{ oldBytes: Buffer.from('wrong') }, 'old_object_hash_mismatch'],
  [{ currentRow: { ...row, focal_x: 50, updated_at: '2026-10-09T00:00:00Z' } }, 'database_reference_changed'],
  [{ references: { profileImages: [{ id: 'other' }] } }, 'profileImages_reference_present'],
  [{ activeOperation: true }, 'active_operation'],
  [{ protocolInstalled: false }, 'guarded_cleanup_protocol_not_installed'],
  [{ backup: validateBackupRecord(candidate, null, null, null) }, 'backup_record_missing'],
]) {
  const result = evaluateCleanup(candidate, evidence(change), { retentionDays: 7, now: new Date('2026-10-10T00:00:00Z') });
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes(blocker), blocker);
}
const retention = evaluateCleanup(candidate, evidence(), { retentionDays: 30, now: new Date('2026-10-10T00:00:00Z') });
assert.ok(retention.blockers.includes('retention_window_active'));

const request = cleanupApprovalRequest(verified);
const approval = { ...request, approved: true, approvedAt: '2026-10-10T00:01:00Z' };
assert.equal(isCleanupApproved(verified, [approval]), true);
assert.equal(isCleanupApproved(verified, [{ ...approval, oldPath: newPath }]), false);
assert.equal(isCleanupApproved(verified, [{ ...approval, backupRecordSha256: sha256(oldBytes) }]), false);

function harness({ deleteFails = false, finalizeFails = 0, saveFailsAt = 0, old = oldBytes } = {}) {
  let stored = old, finalizeFailures = finalizeFails;
  const calls = { reserve: 0, deletes: 0, finalize: 0, saves: 0 };
  const adapters = {
    readOld: async () => stored,
    saveJournal: async () => { calls.saves += 1;
      if (saveFailsAt && calls.saves === saveFailsAt) throw new Error('journal crash'); },
    reserve: async (_item, id) => { calls.reserve += 1; assert.equal(id, operationId);
      return { operation_id: id, status: 'reserved' }; },
    verifyReserved: async () => verified,
    deleteOld: async () => { calls.deletes += 1;
      if (deleteFails) throw new Error('delete failed'); stored = null; },
    finalize: async () => { calls.finalize += 1;
      if (finalizeFailures-- > 0) throw new Error('finalize crash'); },
  };
  return { adapters, calls, get old() { return stored; }, set old(value) { stored = value; } };
}
function journal() { return { operationId, status: 'authorized' }; }

const success = harness();
const successJournal = journal();
assert.equal((await deleteSupersededObject(verified, true, successJournal, success.adapters)).status, 'cleaned');
assert.equal(success.old, null);
assert.equal(success.calls.deletes, 1);
assert.equal((await deleteSupersededObject(verified, true, successJournal, success.adapters)).status, 'cleaned');
assert.equal(success.calls.deletes, 1, 'repeated delete is idempotent');
assert.equal((await deleteSupersededObject(verified, false, journal(), harness().adapters)).status, 'blocked');
assert.equal((await deleteSupersededObject({ ...verified, eligible: false }, true, journal(), harness().adapters)).status, 'blocked');

const deleteFailure = harness({ deleteFails: true });
assert.equal((await deleteSupersededObject(verified, true, journal(), deleteFailure.adapters)).status, 'failed');
assert.ok(deleteFailure.old, 'failed deletion retains old object');
const changedAfterReserve = harness({ old: Buffer.from('changed') });
assert.equal((await deleteSupersededObject(verified, true, journal(), changedAfterReserve.adapters)).status, 'blocked');

const beforeDeleteCrash = harness({ saveFailsAt: 3 });
const beforeDeleteJournal = journal();
assert.equal((await deleteSupersededObject(verified, true, beforeDeleteJournal, beforeDeleteCrash.adapters)).status, 'failed');
assert.ok(beforeDeleteCrash.old, 'crash before deletion retains old object');
beforeDeleteCrash.adapters.saveJournal = async () => {};
assert.equal((await deleteSupersededObject(verified, true, beforeDeleteJournal, beforeDeleteCrash.adapters)).status, 'cleaned');

const afterDeleteCrash = harness({ finalizeFails: 1 });
const afterDeleteJournal = journal();
assert.equal((await deleteSupersededObject(verified, true, afterDeleteJournal, afterDeleteCrash.adapters)).status, 'failed');
assert.equal(afterDeleteCrash.old, null, 'crash after deletion is recoverable from reservation');
assert.equal((await deleteSupersededObject(verified, true, afterDeleteJournal, afterDeleteCrash.adapters)).status, 'cleaned');

const sql = fs.readFileSync('supabase/migrations/202611050001_guarded_image_compression_cleanup.sql', 'utf8');
assert.match(sql, /lock table public\.profile_images in share mode/i);
assert.match(sql, /profile_images_reject_cleaned_path/);
assert.match(sql, /before insert or update\s+on public\.profile_images/i,
  'reserved cleanup blocks Admin edits and rollback path changes');
assert.match(sql, /dataset_profiles_reject_cleaned_path/);
assert.match(sql, /dataset_imports_reject_cleaned_path/);
assert.match(sql, /status in \('reserved', 'deleted'\)/);
assert.match(sql, /Old path became referenced during cleanup/);
assert.match(sql, /grant execute on function public\.reserve_profile_image_compression_cleanup/);
assert.doesNotMatch(sql, /delete from storage\.objects/i);
const cli = fs.readFileSync('scripts/cleanup-image-compression.mjs', 'utf8');
assert.match(cli, /storage\.remove\(\[oldPath\]\)/, 'only one exact object can be removed');
assert.match(cli, /--confirm-image-id/);
assert.match(cli, /--confirm-old-path/);
assert.doesNotMatch(cli, /--yes|delete-all|delete all/i);

console.log('Compression cleanup eligibility, backup, approval, race, failure, crash, resume, and SQL guard tests passed.');
