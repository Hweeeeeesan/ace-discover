import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyOne, approvalRequest, isApproved, planMigrationEntry, rollbackOne, sameImageMetadata, samePaths } from '../lib/profile-image-compression-migration.js';
import { sha256 } from '../lib/profile-image-compression.js';

const imageId = '2e644249-4c6e-4bba-a027-c7c552e27615';
const datasetId = 'f44fa70d-a5ce-41ac-91b4-ad1261d29e23';
const assetId = '7bd41ac1-3714-4952-b647-f2e7b9793ee4';
const oldBytes = Buffer.from('old canonical bytes');
const newBytes = Buffer.from('new canonical');
const oldPaths = { canonical: `fall-2026/test-person/${imageId}.jpg`,
  profile: `fall-2026/test-person/derived/${imageId}-profile.webp`,
  discovery: `fall-2026/test-person/derived/${imageId}-discovery.webp` };
const row = { id: imageId, dataset_id: datasetId, profile_id: 'test-person',
  storage_path: oldPaths.canonical, profile_storage_path: oldPaths.profile,
  discovery_storage_path: oldPaths.discovery, updated_at: '2026-11-03T12:00:00Z',
  position: 2, is_primary: true, focal_x: 45, focal_y: 35, display_mode: 'cover',
  source_type: 'google_drive', source_drive_file_id: 'drive-file',
  source_drive_folder_id: 'drive-folder', source_filename: 'photo.jpg',
  source_modified_time: null, source_size: 999 };
const candidate = { imageId, datasetId, datasetSlug: 'fall-2026', profileId: 'test-person',
  oldSnapshot: row, oldPaths, status: 'validated', originalSize: oldBytes.length,
  proposedSize: newBytes.length, originalFormat: 'jpeg', proposedFormat: 'jpeg',
  originalSha256: sha256(oldBytes), proposedSha256: sha256(newBytes),
  newPaths: { assetId, canonical: `fall-2026/test-person/${assetId}.jpg`,
    profile: `fall-2026/test-person/derived/${assetId}-profile.webp`,
    discovery: `fall-2026/test-person/derived/${assetId}-discovery.webp` } };
const settings = { jpegQuality: 86, webpQuality: 90, minSavingsPercent: 10 };
const plan = planMigrationEntry(candidate, settings);
assert.equal(plan.copiedDerivatives, false, 'row-ID derivatives remain unchanged');
assert.equal(plan.newPaths.profile, oldPaths.profile);
assert.equal(plan.newPaths.discovery, oldPaths.discovery);
assert.equal(samePaths(row, oldPaths), true);
assert.equal(sameImageMetadata(row, { ...row, storage_path: 'different.jpg', updated_at: 'later' }), true);
assert.equal(sameImageMetadata(row, { ...row, source_drive_folder_id: 'changed' }), false);
const approval = { ...approvalRequest(plan), approved: true, reviewedAt: '2026-11-03T14:00:00Z' };
assert.equal(isApproved(plan, [approval]), true);
assert.equal(isApproved(plan, []), false);
assert.equal(isApproved(plan, [{ ...approval, optimizedSha256: sha256(Buffer.from('changed')) }]), false);
assert.equal(isApproved(plan, [{ ...approval, originalSha256: sha256(Buffer.from('changed')) }]), false);
assert.equal(isApproved(plan, [{ ...approval, settings: { ...settings, jpegQuality: 80 } }]), false);
assert.equal(isApproved(plan, [{ ...approval, newPaths: { ...plan.newPaths, canonical: oldPaths.canonical } }]), false);
assert.throws(() => planMigrationEntry({ ...candidate, datasetId: imageId }, settings), /identity/);
assert.throws(() => planMigrationEntry({ ...candidate, newPaths: { ...candidate.newPaths, canonical: 'fall-2026/../evil.jpg' } }, settings), /canonical path/);
assert.throws(() => planMigrationEntry({ ...candidate, oldPaths: { ...oldPaths, canonical: 'spring-2026/test-person/primary.jpg' } }, settings), /Old asset/);
const rotated = { ...row, storage_path: 'fall-2026/test-person/634cb633-10e1-4cce-84a5-130c011f36ca.jpg', updated_at: '2026-11-03T13:00:00Z' };
const derivativeChanged = { ...row, profile_storage_path: `fall-2026/test-person/derived/${assetId}-profile.webp` };

function harness({ current = row, uploadFails = false, swapFails = false, commitThenThrow = false,
  verify = true, journalSaveFails = false } = {}) {
  let live = current ? { ...current } : null;
  let fallback = current?.storage_path || null;
  const objects = new Map([[oldPaths.canonical, oldBytes],
    [oldPaths.profile, Buffer.from('profile derivative')],
    [oldPaths.discovery, Buffer.from('discovery derivative')]]);
  const calls = { uploads: 0, swaps: 0, deletes: 0, saves: 0 };
  const adapters = {
    readRow: async () => live && { ...live },
    readObject: async (objectPath) => objects.get(objectPath) || null,
    prepareAssets: async () => {
      if (!objects.has(oldPaths.canonical)) throw new Error('Missing original Storage object');
      return [{ path: plan.newPaths.canonical, bytes: newBytes, contentType: 'image/jpeg' }];
    },
    upload: async (asset) => { calls.uploads++;
      if (uploadFails) throw new Error('upload failed');
      objects.set(asset.path, asset.bytes);
    },
    swap: async (_plan, expected, paths) => {
      calls.swaps++;
      if (swapFails) throw new Error('RPC failed');
      assert.equal(live.id, expected.id);
      live = { ...live, storage_path: paths.canonical,
        profile_storage_path: paths.profile, discovery_storage_path: paths.discovery,
        updated_at: new Date(Date.parse(live.updated_at) + 1000).toISOString() };
      if (live.is_primary) fallback = paths.canonical;
      if (commitThenThrow) throw new Error('response lost after commit');
    },
    verifyResolved: async (_plan, currentRow) => verify && samePaths(currentRow, _plan.newPaths)
      && (!currentRow.is_primary || fallback === currentRow.storage_path)
      && currentRow.position === row.position && currentRow.focal_x === row.focal_x
      && currentRow.source_drive_file_id === row.source_drive_file_id,
    saveJournal: async () => { calls.saves++;
      if (journalSaveFails) throw new Error('process died while saving journal');
    },
  };
  return { adapters, calls, objects, get live() { return live; }, set live(value) { live = value; },
    get fallback() { return fallback; }, set fallback(value) { fallback = value; } };
}
function emptyJournal() { return { status: 'planned', uploads: {}, dbSwitchStatus: 'pending' }; }
const success = harness();
const successfulJournal = emptyJournal();
assert.equal((await applyOne(plan, true, successfulJournal, success.adapters)).status, 'verified');
assert.equal(success.calls.uploads, 1);
assert.equal(success.calls.deletes, 0);
assert.equal(success.fallback, plan.newPaths.canonical);
assert.equal(success.live.id, row.id);
assert.equal(success.live.position, row.position);
assert.equal(success.live.focal_x, row.focal_x);
assert.equal(success.live.source_drive_file_id, row.source_drive_file_id);
assert.equal((await applyOne(plan, true, successfulJournal, success.adapters)).status, 'verified');
assert.equal(success.calls.uploads, 1, 'repeated apply does not upload again');
assert.equal((await rollbackOne(plan, successfulJournal, success.adapters)).status, 'rolled_back');
assert.equal(success.live.storage_path, oldPaths.canonical);
assert.equal(success.fallback, oldPaths.canonical);
assert.equal(success.calls.deletes, 0);
assert.equal((await rollbackOne(plan, successfulJournal, success.adapters)).status, 'rolled_back');

for (const changed of [rotated, derivativeChanged, null]) {
  const h = harness({ current: changed });
  const result = await applyOne(plan, true, emptyJournal(), h.adapters);
  assert.equal(result.status, 'conflicted');
  assert.equal(h.calls.uploads, 0);
}
assert.equal((await applyOne(plan, false, emptyJournal(), harness().adapters)).status, 'skipped');
const missing = harness(); missing.objects.delete(oldPaths.canonical);
assert.equal((await applyOne(plan, true, emptyJournal(), missing.adapters)).status, 'failed');
assert.equal((await applyOne(plan, true, emptyJournal(), harness({ uploadFails: true }).adapters)).status, 'failed');
assert.equal((await applyOne(plan, true, emptyJournal(), harness({ swapFails: true }).adapters)).status, 'failed');
const afterUpload = harness({ journalSaveFails: true });
const afterUploadJournal = emptyJournal();
assert.equal((await applyOne(plan, true, afterUploadJournal, afterUpload.adapters)).status, 'failed');
afterUpload.adapters.saveJournal = async () => {};
assert.equal((await applyOne(plan, true, afterUploadJournal, afterUpload.adapters)).status, 'verified');
assert.equal(afterUpload.calls.uploads, 1, 'resume recognizes matching uploaded bytes');
const afterCommit = harness({ commitThenThrow: true });
const afterCommitJournal = emptyJournal();
assert.equal((await applyOne(plan, true, afterCommitJournal, afterCommit.adapters)).status, 'verified');
assert.equal(afterCommit.calls.swaps, 1);
const crashAfterCommit = harness();
crashAfterCommit.live = { ...row, storage_path: plan.newPaths.canonical,
  profile_storage_path: plan.newPaths.profile, discovery_storage_path: plan.newPaths.discovery,
  updated_at: '2026-11-03T12:00:01Z' };
crashAfterCommit.fallback = plan.newPaths.canonical;
assert.equal((await applyOne(plan, true, emptyJournal(), crashAfterCommit.adapters)).status, 'verified');
assert.equal(crashAfterCommit.calls.uploads, 0);
assert.equal(crashAfterCommit.calls.swaps, 0);
const newerAdmin = harness();
const newerJournal = emptyJournal();
await applyOne(plan, true, newerJournal, newerAdmin.adapters);
newerAdmin.live = { ...newerAdmin.live, focal_x: 66, updated_at: '2026-11-03T12:02:00Z' };
assert.equal((await applyOne(plan, true, newerJournal, newerAdmin.adapters)).status, 'conflicted');
assert.equal((await rollbackOne(plan, newerJournal, newerAdmin.adapters)).status, 'conflicted');
const failedPublic = harness({ verify: false });
const failedPublicJournal = emptyJournal();
assert.equal((await applyOne(plan, true, failedPublicJournal, failedPublic.adapters)).status, 'failed');
assert.equal(failedPublicJournal.dbSwitchStatus, 'committed');

const replacementId = '634cb633-10e1-4cce-84a5-130c011f36ca';
const rotatedRow = { ...row, storage_path: `fall-2026/test-person/${replacementId}.jpg`,
  profile_storage_path: `fall-2026/test-person/derived/${replacementId}-profile.webp`,
  discovery_storage_path: `fall-2026/test-person/derived/${replacementId}-discovery.webp` };
const rotatedCandidate = { ...candidate, oldSnapshot: rotatedRow,
  oldPaths: { canonical: rotatedRow.storage_path, profile: rotatedRow.profile_storage_path,
    discovery: rotatedRow.discovery_storage_path } };
const rotatedPlan = planMigrationEntry(rotatedCandidate, settings);
assert.equal(rotatedPlan.copiedDerivatives, true);
const archivedRow = { ...row, dataset_id: datasetId, storage_path: 'fall-2025/test-person/primary.jpg',
  profile_storage_path: null, discovery_storage_path: null };
const archivedCandidate = { ...candidate, datasetSlug: 'fall-2025', oldSnapshot: archivedRow,
  oldPaths: { canonical: archivedRow.storage_path, profile: null, discovery: null },
  newPaths: { assetId, canonical: `fall-2025/test-person/${assetId}.jpg`, profile: null, discovery: null } };
const archivedPlan = planMigrationEntry(archivedCandidate, settings);
assert.equal(archivedPlan.newPaths.profile, null);
assert.equal(archivedPlan.newPaths.discovery, null);

const sql = fs.readFileSync('supabase/migrations/202611030001_guarded_image_compression_swap.sql', 'utf8');
assert.match(sql, /for update/);
assert.match(sql, /previous_image\.storage_path is distinct from expected_row/);
assert.match(sql, /previous_image\.profile_storage_path is distinct from expected_row/);
assert.match(sql, /previous_image\.discovery_storage_path is distinct from expected_row/);
assert.match(sql, /updated_at is distinct from/);
assert.match(sql, /profile_byte_length/);
assert.match(sql, /discovery_byte_length/);
assert.match(sql, /Primary fallback changed or is stale/);
assert.match(sql, /grant execute.*swap_profile_image_compression_assets/s);
assert.doesNotMatch(sql, /delete from|storage\.objects/i);
console.log('Guarded compression migration, approvals, crashes, rollback, archived, and no-deletion tests passed.');
