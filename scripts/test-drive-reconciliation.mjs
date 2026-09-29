import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ingestProfileImages } from '../lib/profile-image-ingestion.js';
import {
  classifyDriveImageReconciliation,
  commitDriveImageAppend,
  PROFILE_IMAGE_SOURCE_TYPES,
  reconciliationStatusCopy,
} from '../lib/profile-image-reconciliation.js';

const folderId = '1234567890FOLDER';
const file = (id, name, overrides = {}) => ({
  id,
  name,
  mimeType: 'image/jpeg',
  size: 120000,
  modifiedTime: '2026-09-25T20:00:00.000Z',
  ...overrides,
});
const image = (id, sourceType, sourceDriveFileId = '', overrides = {}) => ({
  id,
  position: overrides.position || 0,
  isPrimary: overrides.isPrimary === true,
  focalX: overrides.focalX ?? 50,
  focalY: overrides.focalY ?? 35,
  displayMode: overrides.displayMode || 'cover',
  sourceType,
  sourceDriveFileId,
  sourceDriveFolderId: sourceDriveFileId ? folderId : '',
});
const profile = (profileImages, overrides = {}) => ({
  id: 'person-one',
  driveFolderId: folderId,
  driveFileId: '',
  imageClearedByAdmin: false,
  profileImages,
  ...overrides,
});

const existingA = image('11111111-1111-4111-8111-111111111111', PROFILE_IMAGE_SOURCE_TYPES.GOOGLE_DRIVE, '1234567890FILEA', {
  position: 0, isPrimary: true, focalX: 22, focalY: 61, displayMode: 'portrait',
});
const existingB = image('22222222-2222-4222-8222-222222222222', PROFILE_IMAGE_SOURCE_TYPES.ADMIN_UPLOAD, '', { position: 1 });
const files = [file('1234567890FILEA', 'photo.jpg'), file('1234567890FILEB', 'photo.jpg')];
const presentationBefore = JSON.stringify([existingA, existingB]);

const newImagePreview = classifyDriveImageReconciliation({ profile: profile([existingA, existingB]), driveFiles: files });
assert.equal(newImagePreview.state, 'new_images');
assert.equal(newImagePreview.newCount, 1, 'one genuinely new Drive ID must appear in preview');
assert.equal(newImagePreview.newCandidates[0].id, '1234567890FILEB');
assert.equal(newImagePreview.images[0].isPrimary, true, 'primary metadata must remain intact in reconciliation state');
assert.equal(newImagePreview.images[1].sourceType, 'admin_upload', 'Admin uploads must not block Drive append');
assert.equal(newImagePreview.newCandidates[0].name, newImagePreview.knownFiles[0].name, 'duplicate filenames with different IDs are distinct');
assert.equal(JSON.stringify([existingA, existingB]), presentationBefore, 'preview must not mutate order, primary, focal, or display metadata');

const renamed = classifyDriveImageReconciliation({
  profile: profile([existingA]),
  driveFiles: [file('1234567890FILEA', 'favorite-photo.jpg')],
});
assert.equal(renamed.state, 'up_to_date', 'same Drive ID after rename must not duplicate');
assert.equal(renamed.newCount, 0);

const removed = classifyDriveImageReconciliation({ profile: profile([existingA, existingB]), driveFiles: [] });
assert.equal(removed.missingFromDriveCount, 1, 'removed Drive files are reported');
assert.equal(removed.existingCount, 2, 'removed Drive files never remove gallery rows');

const legacy = image('33333333-3333-4333-8333-333333333333', PROFILE_IMAGE_SOURCE_TYPES.LEGACY_UNKNOWN);
const legacyPreview = classifyDriveImageReconciliation({ profile: profile([legacy]), driveFiles: files });
assert.equal(legacyPreview.state, 'legacy_review');
assert.equal(legacyPreview.newCount, 0, 'unlinked files are not called new while legacy identity is unresolved');
assert.equal(legacyPreview.newCandidates.length, 0);
assert.equal(legacyPreview.unlinkedDriveFiles.length, 2);
assert.match(reconciliationStatusCopy(legacyPreview).summary, /predates Drive source tracking/i);

const reviewedLegacy = image('33333333-3333-4333-8333-333333333333', PROFILE_IMAGE_SOURCE_TYPES.LEGACY_PRESERVED);
const afterReview = classifyDriveImageReconciliation({ profile: profile([reviewedLegacy]), driveFiles: files });
assert.equal(afterReview.state, 'new_images', 'remaining Drive IDs become candidates only after explicit legacy review');
assert.equal(afterReview.newCount, 2);

const cleared = classifyDriveImageReconciliation({
  profile: profile([], { imageClearedByAdmin: true }),
  driveFiles: files,
});
assert.equal(cleared.state, 'intentionally_cleared');
assert.equal(cleared.newCount, 0, 'intentional clear cannot silently restore images');

const direct = classifyDriveImageReconciliation({
  profile: profile([legacy], { driveFolderId: '', driveFileId: '1234567890FILEA' }),
  driveFiles: [],
});
assert.equal(direct.state, 'direct_file_review', 'single-file sources require replacement review');
const directChanged = classifyDriveImageReconciliation({
  profile: profile([existingA], { driveFolderId: '', driveFileId: '1234567890FILEB' }),
  driveFiles: [],
});
assert.equal(directChanged.state, 'direct_file_changed');
assert.match(reconciliationStatusCopy(directChanged).label, /Source image changed/);

const unsupported = classifyDriveImageReconciliation({
  profile: profile([existingA]),
  driveFiles: [file('1234567890FILEA', 'photo.jpg'), file('1234567890PDF00', 'notes.pdf', { mimeType: 'application/pdf' })],
});
assert.equal(unsupported.unsupportedCount, 1);
assert.equal(unsupported.newCount, 0);

const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: '#57a5d8' } }).png().toBuffer();
const downloaded = [];
const selectedIngestion = await ingestProfileImages({
  profile: profile([]),
  datasetSlug: 'fall-2026',
  driveAuth: { authenticated: true },
  dryRun: true,
  candidateDriveFileIds: ['1234567890FILEB'],
  createImageId: () => '44444444-4444-4444-8444-444444444444',
  driveClient: {
    listFilesInFolder: async () => files,
    fetchDriveImage: async (driveFileId) => {
      downloaded.push(driveFileId);
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  },
});
assert.deepEqual(downloaded, ['1234567890FILEB'], 'apply ingestion downloads only selected, revalidated Drive IDs');
assert.equal(selectedIngestion.images.length, 1);
assert.equal(selectedIngestion.images[0].resolvedDriveFileId, '1234567890FILEB');
assert.match(selectedIngestion.images[0].profileStoragePath, /-profile\.webp$/);
assert.match(selectedIngestion.images[0].discoveryStoragePath, /-discovery\.webp$/);
assert.equal(selectedIngestion.images[0].sourceModifiedTime, '2026-09-25T20:00:00.000Z');

await assert.rejects(() => ingestProfileImages({
  profile: profile([]),
  datasetSlug: 'fall-2026',
  driveAuth: { authenticated: true },
  dryRun: true,
  candidateDriveFileIds: ['1234567890MISSING'],
  driveClient: {
    listFilesInFolder: async () => files,
    fetchDriveImage: async () => assert.fail('changed source must fail before download'),
  },
}), /changed after preview/i);

const staged = [
  {
    ...selectedIngestion.images[0],
    imageId: '44444444-4444-4444-8444-444444444444',
  },
  {
    ...selectedIngestion.images[0],
    imageId: '55555555-5555-4555-8555-555555555555',
    storagePath: 'fall-2026/person-one/55555555-5555-4555-8555-555555555555.png',
    profileStoragePath: 'fall-2026/person-one/derived/55555555-5555-4555-8555-555555555555-profile.webp',
    discoveryStoragePath: 'fall-2026/person-one/derived/55555555-5555-4555-8555-555555555555-discovery.webp',
    resolvedDriveFileId: '1234567890FILEC',
  },
];
let cleaned = [];
await assert.rejects(() => commitDriveImageAppend({
  images: staged,
  append: async () => { throw new Error('DB failed'); },
  confirm: async () => [],
  cleanup: async (paths) => { cleaned = paths; },
}), /DB failed/);
assert.deepEqual(cleaned.sort(), staged.flatMap((item) => [item.storagePath, item.profileStoragePath, item.discoveryStoragePath]).sort(), 'DB failure cleans every staged object');

cleaned = [];
const confirmedAfterError = await commitDriveImageAppend({
  images: staged,
  append: async () => { throw new Error('network response lost'); },
  confirm: async () => staged,
  cleanup: async (paths) => { cleaned = paths; },
});
assert.equal(confirmedAfterError.confirmedAfterRpcProblem, true);
assert.deepEqual(cleaned, [], 'confirmed live objects must not be deleted after an uncertain RPC response');

cleaned = [];
await assert.rejects(() => commitDriveImageAppend({
  images: staged,
  append: async () => { throw new Error('partial'); },
  confirm: async () => staged.slice(0, 1),
  cleanup: async (paths) => { cleaned = paths; },
}), (error) => error.preserveStagedObjects === true);
assert.deepEqual(cleaned, [], 'partial confirmation fails closed without deleting possibly-live assets');

cleaned = [];
const concurrent = await commitDriveImageAppend({
  images: staged,
  append: async () => ({
    appendedCount: 1,
    appendedImageIds: [staged[0].imageId],
    skippedDriveFileIds: [staged[1].resolvedDriveFileId],
  }),
  confirm: async () => assert.fail('successful RPC does not need confirmation'),
  cleanup: async (paths) => { cleaned = paths; },
});
assert.equal(concurrent.appendedCount, 1);
assert.deepEqual(cleaned.sort(), [staged[1].storagePath, staged[1].profileStoragePath, staged[1].discoveryStoragePath].sort(), 'concurrent duplicate skip cleans only unused immutable assets');

let uploadAttempts = 0;
const failedStorageIngestion = await ingestProfileImages({
  profile: profile([]),
  datasetSlug: 'fall-2026',
  driveAuth: { authenticated: true },
  dryRun: false,
  requireAllSupported: true,
  candidateDriveFileIds: ['1234567890FILEB'],
  createImageId: () => '66666666-6666-4666-8666-666666666666',
  upload: async () => { uploadAttempts += 1; throw new Error('Storage unavailable'); },
  remove: async () => {},
  driveClient: {
    listFilesInFolder: async () => files,
    fetchDriveImage: async () => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
  },
});
assert.equal(uploadAttempts, 1);
assert.equal(failedStorageIngestion.images.length, 0, 'Storage failure leaves no image eligible for DB append');
assert.equal(failedStorageIngestion.rejected[0].category, 'supabase_upload_failure');

const migration = await readFile(new URL('../supabase/migrations/202609280003_drive_image_reconciliation.sql', import.meta.url), 'utf8');
const backfillMigration = await readFile(new URL('../supabase/migrations/202609280004_drive_image_reconciliation_backfill.sql', import.meta.url), 'utf8');
const finalizeMigration = await readFile(new URL('../supabase/migrations/202609280005_drive_image_reconciliation_finalize.sql', import.meta.url), 'utf8');
assert.match(migration, /source_type text/);
assert.match(migration, /alter column source_type set default 'admin_upload'/);
assert.match(migration, /source_type is null\s+or source_type in/);
assert.doesNotMatch(migration, /update\s+public\.profile_images\s+set\s+source_type\s*=\s*'legacy_unknown'/i);
assert.match(backfillMigration, /update\s+public\.profile_images\s+set\s+source_type\s*=\s*'legacy_unknown'/i);
assert.doesNotMatch(backfillMigration, /alter\s+table\s+public\.profile_images/i);
assert.match(finalizeMigration, /alter column source_type set not null/);
assert.match(finalizeMigration, /profile_images_source_type_valid/);
assert.match(migration, /source_drive_file_id text/);
assert.match(migration, /source_drive_folder_id text/);
assert.match(migration, /source_type = 'legacy_unknown'/, 'historical rows must fail closed');
assert.match(migration, /profile_images_drive_source_identity_idx[\s\S]*where source_drive_file_id is not null/i);
assert.match(migration, /append_google_drive_profile_images/);
assert.match(migration, /source_type = 'legacy_unknown'[\s\S]*raise exception 'Legacy image identity review must be completed/i);
assert.match(migration, /max\(position\) \+ 1/);
assert.match(migration, /next_position, false, 'google_drive'/, 'append must never make a new image primary');
assert.doesNotMatch(migration.match(/create or replace function public\.append_google_drive_profile_images[\s\S]*?end;\n\$\$;/)?.[0] || '', /delete from public\.profile_images/i);
assert.match(migration, /attach_profile_image_drive_provenance/);
assert.match(migration, /mark_profile_image_legacy_preserved/);
assert.match(migration, /Only an unreviewed legacy image/, 'review cannot overwrite known provenance');
assert.match(migration, /revoke all on function public\.append_google_drive_profile_images[\s\S]*from public, anon, authenticated/i);
assert.match(migration, /grant execute on function public\.append_google_drive_profile_images[\s\S]*to service_role/i);

const server = await readFile(new URL('../lib/profile-image-reconciliation-server.js', import.meta.url), 'utf8');
assert.match(server, /candidateDriveFileIds: selectedIds/);
assert.match(server, /requireAllSupported: true/);
assert.match(server, /commitDriveImageAppend/, 'DB append and staged cleanup must use the tested transaction coordinator');
assert.match(server, /source_drive_file_id === image\.resolvedDriveFileId/, 'RPC uncertainty must confirm exact provenance');

for (const route of ['preview', 'review', 'apply', 'thumbnail']) {
  const source = await readFile(new URL(`../app/api/admin/datasets/images/reconcile/${route}/route.js`, import.meta.url), 'utf8');
  assert.match(source, /authorizeAdminRequest/, `${route} reconciliation route must require Admin authorization`);
}

const manager = await readFile(new URL('../components/AdminImageManager.js', import.meta.url), 'utf8');
assert.match(manager, /Check Drive for new images/);
assert.match(manager, /Existing gallery predates Drive source tracking/);
assert.match(manager, /Not in current Drive folder/);
assert.match(manager, /confirm: true/);

const publicImages = await readFile(new URL('../lib/profile-images.js', import.meta.url), 'utf8');
assert.doesNotMatch(publicImages, /sourceDriveFileId|source_drive_file_id/, 'public profile image model must not expose provenance');

const sheetApply = await readFile(new URL('../app/api/admin/datasets/sync/apply/route.js', import.meta.url), 'utf8');
assert.doesNotMatch(sheetApply, /reconcil|append_google_drive_profile_images/, 'Sheet sync must not silently reconcile Drive galleries');

console.log('Drive reconciliation regression tests passed.');
