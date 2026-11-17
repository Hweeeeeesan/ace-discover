import { createHash } from 'node:crypto';
import { sameImageSnapshot, sha256 } from './profile-image-compression.js';

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function cleanupCandidateFromMigration(entry) {
  if (!entry || !UUID.test(entry.imageId || '') || !UUID.test(entry.datasetId || '')
    || entry.status !== 'verified' || entry.dbSwitchStatus !== 'committed'
    || entry.postVerificationStatus !== 'verified' || !entry.committedSnapshot
    || entry.committedSnapshot.id !== entry.imageId
    || entry.committedSnapshot.dataset_id !== entry.datasetId
    || entry.committedSnapshot.profile_id !== entry.profileId
    || entry.committedSnapshot.storage_path !== entry.newPaths?.canonical
    || !entry.oldPaths?.canonical || entry.oldPaths.canonical === entry.newPaths.canonical
    || !HASH.test(entry.originalSha256 || '') || !HASH.test(entry.optimizedSha256 || '')
    || !Number.isSafeInteger(entry.originalBytes) || entry.originalBytes <= 0
    || !Number.isSafeInteger(entry.optimizedBytes) || entry.optimizedBytes <= 0) {
    throw new Error('Migration journal entry is incomplete or is not verified.');
  }
  return {
    imageId: entry.imageId,
    datasetId: entry.datasetId,
    profileId: entry.profileId,
    oldPath: entry.oldPaths.canonical,
    newPath: entry.newPaths.canonical,
    originalSha256: entry.originalSha256,
    optimizedSha256: entry.optimizedSha256,
    originalBytes: entry.originalBytes,
    optimizedBytes: entry.optimizedBytes,
    committedSnapshot: entry.committedSnapshot,
    migratedAt: entry.committedSnapshot.updated_at,
  };
}

export function validateBackupRecord(candidate, record, backupBytes, restoredBytes) {
  const blockers = [];
  if (!record) blockers.push('backup_record_missing');
  else {
    if (record.imageId !== candidate.imageId || record.oldPath !== candidate.oldPath
      || record.originalSha256 !== candidate.originalSha256) blockers.push('backup_record_mismatch');
    if (record.independentOfSupabaseBucket !== true || !record.location
      || !record.backupFile) blockers.push('backup_not_independent');
    if (!record.verifiedAt || Number.isNaN(Date.parse(record.verifiedAt))) blockers.push('backup_verification_missing');
    if (!record.restoreTestedAt || Number.isNaN(Date.parse(record.restoreTestedAt))
      || record.restoreSha256 !== candidate.originalSha256) blockers.push('backup_restore_test_missing');
  }
  if (!backupBytes) blockers.push('backup_missing');
  else if (sha256(backupBytes) !== candidate.originalSha256) blockers.push('backup_hash_mismatch');
  if (!restoredBytes) blockers.push('backup_restore_failure');
  else if (sha256(restoredBytes) !== candidate.originalSha256) blockers.push('backup_restore_hash_mismatch');
  return { valid: blockers.length === 0, blockers };
}

export function evaluateCleanup(candidate, evidence, {
  retentionDays = 7,
  now = new Date(),
} = {}) {
  const blockers = [];
  if (!sameImageSnapshot(candidate.committedSnapshot, evidence.currentRow)) blockers.push('database_reference_changed');
  if (!evidence.newBytes) blockers.push('new_object_missing');
  else if (evidence.newBytes.length !== candidate.optimizedBytes
    || sha256(evidence.newBytes) !== candidate.optimizedSha256) blockers.push('new_object_hash_mismatch');
  if (!evidence.oldBytes) blockers.push('old_object_missing');
  else if (evidence.oldBytes.length !== candidate.originalBytes
    || sha256(evidence.oldBytes) !== candidate.originalSha256) blockers.push('old_object_hash_mismatch');
  for (const [name, values] of Object.entries(evidence.references || {})) {
    if (Array.isArray(values) && values.length) blockers.push(`${name}_reference_present`);
  }
  if (evidence.activeOperation) blockers.push('active_operation');
  if (evidence.cleanupReservationConflict) blockers.push('cleanup_reservation_conflict');
  if (!evidence.protocolInstalled) blockers.push('guarded_cleanup_protocol_not_installed');
  if (!evidence.backup?.valid) blockers.push(...(evidence.backup?.blockers || ['backup_unverified']));
  const migrated = Date.parse(candidate.migratedAt || '');
  const retentionMs = retentionDays * 86_400_000;
  const retentionEndsAt = Number.isFinite(migrated) ? new Date(migrated + retentionMs).toISOString() : null;
  if (!retentionEndsAt || now.getTime() < Date.parse(retentionEndsAt)) blockers.push('retention_window_active');
  const uniqueBlockers = [...new Set(blockers)];
  const verification = {
    imageId: candidate.imageId,
    datasetId: candidate.datasetId,
    profileId: candidate.profileId,
    oldPath: candidate.oldPath,
    newPath: candidate.newPath,
    originalSha256: candidate.originalSha256,
    optimizedSha256: candidate.optimizedSha256,
    originalBytes: candidate.originalBytes,
    optimizedBytes: candidate.optimizedBytes,
    expectedRowUpdatedAt: candidate.committedSnapshot.updated_at,
    retentionDays,
    retentionEndsAt,
    backupRecordSha256: evidence.backupRecordSha256 || null,
    blockers: uniqueBlockers,
  };
  return { ...verification, eligible: uniqueBlockers.length === 0,
    verificationId: stableHash(verification) };
}

export function cleanupApprovalRequest(verification) {
  return {
    verificationId: verification.verificationId,
    imageId: verification.imageId,
    datasetId: verification.datasetId,
    profileId: verification.profileId,
    oldPath: verification.oldPath,
    newPath: verification.newPath,
    originalSha256: verification.originalSha256,
    optimizedSha256: verification.optimizedSha256,
    originalBytes: verification.originalBytes,
    expectedRowUpdatedAt: verification.expectedRowUpdatedAt,
    retentionDays: verification.retentionDays,
    backupRecordSha256: verification.backupRecordSha256,
  };
}

export function isCleanupApproved(verification, approvals) {
  const approval = Array.isArray(approvals)
    ? approvals.find((item) => item?.imageId === verification.imageId) : null;
  if (!approval || approval.approved !== true || !approval.approvedAt
    || Number.isNaN(Date.parse(approval.approvedAt))) return false;
  const expected = cleanupApprovalRequest(verification);
  return Object.entries(expected).every(([key, value]) => JSON.stringify(approval[key]) === JSON.stringify(value));
}

export async function deleteSupersededObject(verification, approved, journal, adapters) {
  if (!verification?.eligible) return { status: 'blocked', reason: 'Current verification is not eligible.' };
  if (!approved) return { status: 'blocked', reason: 'Exact cleanup approval is missing or stale.' };
  if (!journal?.operationId || !UUID.test(journal.operationId)) {
    return { status: 'blocked', reason: 'Durable cleanup operation ID is missing.' };
  }
  try {
    const oldBefore = await adapters.readOld(verification.oldPath);
    if (journal.status === 'cleaned') {
      return oldBefore ? { status: 'conflicted', reason: 'Journal says cleaned but old object exists.' }
        : { status: 'cleaned', repeated: true, reclaimedBytes: verification.originalBytes };
    }
    journal.status = 'reserving';
    await adapters.saveJournal(journal);
    const reservation = await adapters.reserve(verification, journal.operationId);
    journal.reservation = reservation;
    journal.status = 'reserved';
    await adapters.saveJournal(journal);

    const fresh = await adapters.verifyReserved(verification, journal.operationId);
    if (!fresh?.eligible || fresh.verificationId !== verification.verificationId) {
      return { status: 'blocked', reason: 'Fresh verification changed after reservation.' };
    }
    let old = await adapters.readOld(verification.oldPath);
    if (old && (old.length !== verification.originalBytes || sha256(old) !== verification.originalSha256)) {
      return { status: 'blocked', reason: 'Old object hash changed after reservation.' };
    }
    if (old) {
      journal.status = 'deleting';
      await adapters.saveJournal(journal);
      try { await adapters.deleteOld(verification.oldPath); }
      catch (error) {
        old = await adapters.readOld(verification.oldPath);
        if (old) return { status: 'failed', reason: `Storage deletion failed: ${error.message}` };
      }
    }
    if (await adapters.readOld(verification.oldPath)) {
      return { status: 'failed', reason: 'Storage deletion could not be verified.' };
    }
    await adapters.finalize(verification, journal.operationId);
    if (await adapters.readOld(verification.oldPath)) {
      return { status: 'failed', reason: 'Old object reappeared after finalization.' };
    }
    journal.status = 'cleaned';
    journal.cleanedAt = new Date().toISOString();
    journal.reclaimedBytes = verification.originalBytes;
    await adapters.saveJournal(journal);
    return { status: 'cleaned', reclaimedBytes: verification.originalBytes };
  } catch (error) {
    return { status: 'failed', reason: String(error) };
  }
}
