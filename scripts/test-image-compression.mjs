import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  canResumeCandidate, optimizeCanonical, proposedPaths, sameImageSnapshot, stageAssetSwap,
} from '../lib/profile-image-compression.js';
import { isValidStorageImagePath } from '../lib/profile-images.js';

const id = '2e644249-4c6e-4bba-a027-c7c552e27615';
const row = { id, dataset_id: 'dataset', profile_id: 'test-person',
  storage_path: `fall-2026/test-person/${id}.jpg`,
  profile_storage_path: `fall-2026/test-person/derived/${id}-profile.webp`,
  discovery_storage_path: `fall-2026/test-person/derived/${id}-discovery.webp`,
  position: 1, is_primary: false, focal_x: 44, focal_y: 36, display_mode: 'cover',
  source_type: 'google_drive', source_drive_file_id: 'drive-id' };
const changed = { ...row, storage_path: `fall-2026/test-person/7bd41ac1-3714-4952-b647-f2e7b9793ee4.jpg` };
assert.equal(sameImageSnapshot(row, { ...row }), true);
assert.equal(sameImageSnapshot(row, changed), false, 'rotated Admin asset must conflict');
assert.equal(sameImageSnapshot(row, { ...row, focal_x: 55 }), false, 'focal edits must conflict');
assert.equal(sameImageSnapshot(row, null), false, 'deleted row must conflict');
assert.equal(canResumeCandidate({ status: 'validated', oldSnapshot: row }, row), true);
assert.equal(canResumeCandidate({ status: 'failed', oldSnapshot: row }, row), false, 'failed work must retry');
assert.equal(canResumeCandidate({ status: 'validated', oldSnapshot: row }, changed), false, 'changed row must replan');

const planned = proposedPaths({ datasetSlug: 'fall-2026', row, contentType: 'image/webp' });
assert.match(planned.canonical, /\.webp$/);
assert.ok(isValidStorageImagePath(planned.canonical));
assert.match(planned.profile, new RegExp(`${planned.assetId}-profile\\.webp$`));
assert.match(planned.discovery, new RegExp(`${planned.assetId}-discovery\\.webp$`));
const archived = proposedPaths({ datasetSlug: 'fall-2025', row: { ...row, profile_storage_path: null,
  discovery_storage_path: null }, contentType: 'image/jpeg' });
assert.equal(archived.profile, null);
assert.equal(archived.discovery, null);
assert.match(archived.canonical, /\.jpg$/);

const rgb = Buffer.alloc(1200 * 900 * 3);
for (let i = 0; i < rgb.length; i += 1) rgb[i] = i % 251;
const jpeg = await sharp(rgb, { raw: { width: 1200, height: 900, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
const jpegResult = await optimizeCanonical(jpeg, { minSavingsPercent: 1 });
assert.equal(jpegResult.status, 'validated');
assert.equal(jpegResult.contentType, 'image/jpeg');
assert.equal(jpegResult.optimized.width, 1200);
assert.equal(jpegResult.optimized.height, 900);
assert.ok(jpegResult.saving > 0);
const alpha = Buffer.alloc(500 * 400 * 4);
for (let i = 0; i < alpha.length; i += 4) {
  alpha[i] = 180; alpha[i + 1] = 70; alpha[i + 2] = 130; alpha[i + 3] = (i / 4) % 2 ? 0 : 255;
}
const png = await sharp(alpha, { raw: { width: 500, height: 400, channels: 4 } }).png().toBuffer();
const pngResult = await optimizeCanonical(png, { minSavingsPercent: 0 });
assert.equal(pngResult.status, 'validated');
assert.equal(pngResult.contentType, 'image/webp');
assert.equal(pngResult.optimized.hasAlpha, true);
assert.deepEqual([pngResult.optimized.width, pngResult.optimized.height], [500, 400]);
const oriented = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#47658b' } })
  .withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
const orientedResult = await optimizeCanonical(oriented, { minSavingsPercent: 0 });
assert.equal(orientedResult.status, 'validated');
assert.deepEqual([orientedResult.optimized.width, orientedResult.optimized.height], [100, 200]);
assert.equal(orientedResult.optimized.orientation, 1);
assert.equal((await optimizeCanonical(jpeg, { minSavingsPercent: 100 })).status, 'skipped');

const entry = { status: 'ready_for_migration', oldSnapshot: row, newPaths: planned,
  newAssets: [{ path: planned.canonical }, { path: planned.profile }] };
let calls = [];
const adapters = { upload: async (asset) => { calls.push(`upload:${asset.path}`); },
  verify: async (asset) => { calls.push(`verify:${asset.path}`); },
  compareAndSwap: async () => { calls.push('swap'); return true; },
  verifyPublic: async () => { calls.push('public'); } };
const successful = await stageAssetSwap({ entry, ...adapters });
assert.equal(successful.status, 'migrated_retained_old');
assert.deepEqual(successful.rollback.old, row);
assert.deepEqual(successful.rollback.next, planned);
assert.deepEqual(calls.slice(-2), ['swap', 'public']);
const uploadFailure = await stageAssetSwap({ entry, ...adapters,
  upload: async () => { throw new Error('upload failed'); } });
assert.equal(uploadFailure.status, 'failed');
assert.deepEqual(uploadFailure.staged, []);
const relationalFailure = await stageAssetSwap({ entry, ...adapters,
  compareAndSwap: async () => { throw new Error('database failed'); } });
assert.equal(relationalFailure.status, 'failed');
assert.equal(relationalFailure.staged.length, 2);
const conflict = await stageAssetSwap({ entry, ...adapters, compareAndSwap: async () => false });
assert.equal(conflict.status, 'conflict');
assert.deepEqual(conflict.rollback.old, row);
const publicFailure = await stageAssetSwap({ entry, ...adapters,
  verifyPublic: async () => { throw new Error('public URL failed'); } });
assert.equal(publicFailure.status, 'rollback_required');
assert.deepEqual(publicFailure.rollback.next, planned);
assert.equal(sameImageSnapshot(row, row), true, 'resume can reuse an unchanged snapshot');
assert.equal(sameImageSnapshot(row, changed), false, 'resume must replan changed images');
await assert.rejects(stageAssetSwap({ entry: { ...entry, status: 'validated' }, ...adapters }), /Visual approval/);
console.log('Image compression, path, conflict, failure, resume, rollback, and archived tests passed.');
