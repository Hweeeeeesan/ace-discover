#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_PROFILE_IMAGE_BYTES,
  ProfileImageIngestionError,
  classifyProfileImageSource,
  detectImageContentType,
  validatedImageFromResponse,
} from '../lib/profile-image-ingestion.js';
import { migrateDatasetProfiles } from '../lib/profile-image-migration.js';
import {
  PROFILE_IMAGE_PLACEHOLDER,
  buildProfileImageStoragePath,
  buildPrimaryStoragePath,
  getPrimaryProfileImage,
  getProfileImages,
  isValidStorageImagePath,
  resolveProfileImageSources,
} from '../lib/profile-images.js';

const supabaseOptions = {
  supabaseUrl: 'https://ace-discover.supabase.co',
  bucket: 'profile-images',
};

const springPath = buildPrimaryStoragePath('spring-2026', 'same-person', 'image/webp');
const fallPath = buildPrimaryStoragePath('fall-2025', 'same-person', 'image/webp');
assert.equal(springPath, 'spring-2026/same-person/primary.webp');
assert.notEqual(springPath, fallPath, 'dataset-scoped paths must prevent cross-dataset collisions');
for (const malformed of [
  '',
  '../spring-2026/person/primary.webp',
  'spring-2026/person/../../secret.webp',
  'spring-2026/person/photo.webp',
  'spring-2026/person/primary.svg',
  '/spring-2026/person/primary.webp',
]) assert.equal(isValidStorageImagePath(malformed), false, `malformed path should be rejected: ${malformed}`);
assert.equal(isValidStorageImagePath(springPath), true);

const imageId = '4f5d1d8a-8a6f-4d44-9aac-2a7358db7f92';
const futurePath = buildProfileImageStoragePath('spring-2026', 'same-person', imageId, 'image/png');
assert.equal(futurePath, `spring-2026/same-person/${imageId}.png`);
assert.equal(isValidStorageImagePath(futurePath), true);
assert.notEqual(
  futurePath,
  buildProfileImageStoragePath('fall-2025', 'same-person', imageId, 'image/png'),
  'future image paths must remain isolated by dataset',
);
assert.throws(
  () => buildProfileImageStoragePath('spring-2026', 'person@example.com', imageId, 'image/png'),
  /Invalid profile ID/,
  'raw emails must not be accepted as profile path segments',
);

const driveImage = '/api/drive-image?fileId=1234567890ABCDE';
const storageFirst = resolveProfileImageSources({
  storageImagePath: springPath,
  image: driveImage,
  imageCandidates: [driveImage, PROFILE_IMAGE_PLACEHOLDER],
}, supabaseOptions);
assert.equal(
  storageFirst.src,
  'https://ace-discover.supabase.co/storage/v1/object/public/profile-images/spring-2026/same-person/primary.webp',
);
assert.equal(storageFirst.candidates[1], driveImage, 'Drive must remain the first fallback');
assert.equal(storageFirst.candidates.at(-1), PROFILE_IMAGE_PLACEHOLDER);

const oldDriveOnly = resolveProfileImageSources({ image: driveImage, imageCandidates: [driveImage] }, supabaseOptions);
assert.equal(oldDriveOnly.src, driveImage, 'old Drive-only profiles must continue to work');
const malformedStorage = resolveProfileImageSources({ storageImagePath: '../bad', image: driveImage }, supabaseOptions);
assert.equal(malformedStorage.src, driveImage, 'malformed Storage paths must fall back to Drive');
const placeholderOnly = resolveProfileImageSources({}, supabaseOptions);
assert.equal(placeholderOnly.src, PROFILE_IMAGE_PLACEHOLDER);

const relationalProfile = {
  storageImagePath: 'spring-2026/same-person/primary.webp',
  profileImages: [
    { id: 'second', storageImagePath: `spring-2026/same-person/${imageId}.png`, position: 1, isPrimary: true },
    { id: 'first', storageImagePath: 'spring-2026/same-person/primary.webp', position: 0, isPrimary: false },
  ],
  image: driveImage,
};
assert.deepEqual(getProfileImages(relationalProfile).map((image) => image.id), ['first', 'second']);
assert.equal(getPrimaryProfileImage(relationalProfile).id, 'second');
assert.equal(
  resolveProfileImageSources(relationalProfile, supabaseOptions).src,
  `https://ace-discover.supabase.co/storage/v1/object/public/profile-images/spring-2026/same-person/${imageId}.png`,
  'the relational primary image must be authoritative when present',
);
assert.equal(
  getPrimaryProfileImage({ storageImagePath: springPath }).storageImagePath,
  springPath,
  'legacy storageImagePath-only profiles must remain supported',
);

const mixedProfiles = [
  { id: 'stored', storageImagePath: 'spring-2026/stored/primary.jpg', image: driveImage },
  { id: 'drive', image: driveImage },
].map((profile) => resolveProfileImageSources(profile, supabaseOptions));
assert.match(mixedProfiles[0].src, /storage\/v1\/object\/public/);
assert.equal(mixedProfiles[1].src, driveImage);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.equal(detectImageContentType(jpeg), 'image/jpeg');
assert.equal(detectImageContentType(png), 'image/png');
assert.equal(detectImageContentType(Buffer.from('<svg></svg>')), '', 'SVG must not be accepted as a raster profile image');
const sniffed = await validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Type': 'text/html' } }));
assert.equal(sniffed.contentType, 'image/jpeg', 'content must be detected from bytes, not a filename or header');
await assert.rejects(
  validatedImageFromResponse(new Response('not an image', { headers: { 'Content-Type': 'image/jpeg' } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_content',
);
await assert.rejects(
  validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Length': String(MAX_PROFILE_IMAGE_BYTES + 1) } })),
  /15 MiB/,
);

assert.deepEqual(classifyProfileImageSource({ imageKind: 'direct-image-url', image: 'https://evil.example/a.jpg' }), {
  eligible: false,
  category: 'unsupported_content',
  detail: 'Direct web URLs are not fetched by the migration tool; replace the source with an approved Drive image.',
});
assert.deepEqual(classifyProfileImageSource({ imageKind: 'google-document' }).category, 'google_document');
assert.deepEqual(classifyProfileImageSource({ imageKind: 'drive-folder' }).category, 'drive_folder');

const dryProfiles = [
  { id: 'drive', name: 'Drive', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
  { id: 'missing', name: 'Missing', imageKind: 'missing' },
  { id: 'doc', name: 'Doc', imageKind: 'google-document' },
  { id: 'web', name: 'Web', imageKind: 'direct-image-url', image: 'https://evil.example/a.jpg' },
  { id: 'stored', name: 'Stored', storageImagePath: 'spring-2026/stored/primary.jpg' },
];
const dryIngested = [];
const dryRun = await migrateDatasetProfiles({
  dataset: { slug: 'spring-2026' },
  profiles: dryProfiles,
  dryRun: true,
  storagePathExists: async () => true,
  findExistingPath: async () => '',
  ingest: async (profile) => {
    dryIngested.push(profile.id);
    return { storagePath: `spring-2026/${profile.id}/primary.jpg`, contentType: 'image/jpeg', byteLength: 4 };
  },
  persistPath: async () => assert.fail('dry-run must never persist a path'),
});
assert.deepEqual(dryIngested, ['drive'], 'arbitrary URLs and invalid sources must never reach ingestion');
assert.deepEqual(dryRun.summary, {
  totalProfiles: 5,
  eligible: 1,
  alreadyMigrated: 1,
  uploaded: 0,
  skipped: 3,
  failed: 0,
});
assert.equal(dryRun.rows.find((row) => row.profileId === 'drive').status, 'dry_run_validated');
assert.equal(dryRun.rows.find((row) => row.profileId === 'missing').category, 'missing_source');
assert.equal(dryRun.rows.find((row) => row.profileId === 'doc').category, 'google_document');
assert.equal(dryRun.rows.find((row) => row.profileId === 'web').category, 'unsupported_content');

const failingRun = await migrateDatasetProfiles({
  dataset: { slug: 'spring-2026' },
  profiles: [{ id: 'broken', driveFileId: '1234567890ABCDE' }],
  dryRun: true,
  findExistingPath: async () => '',
  ingest: async () => { throw new ProfileImageIngestionError('permission_fetch_failure', 'Drive denied access.'); },
});
assert.equal(failingRun.summary.failed, 1);
assert.equal(failingRun.rows[0].category, 'permission_fetch_failure');

const malformedRun = await migrateDatasetProfiles({
  dataset: { slug: 'spring-2026' },
  profiles: [{ id: 'malformed', storageImagePath: 'spring-2026/malformed/photo.jpg' }],
  dryRun: true,
});
assert.equal(malformedRun.summary.failed, 1);
assert.equal(malformedRun.rows[0].category, 'malformed_storage_path');

const idempotentProfile = { id: 'rerun', driveFileId: '1234567890ABCDE', storageImagePath: '' };
let uploadCount = 0;
let persistCount = 0;
const runApply = () => migrateDatasetProfiles({
  dataset: { slug: 'spring-2026' },
  profiles: [idempotentProfile],
  dryRun: false,
  storagePathExists: async () => true,
  findExistingPath: async () => '',
  ingest: async () => {
    uploadCount += 1;
    return { storagePath: 'spring-2026/rerun/primary.jpg', contentType: 'image/jpeg', byteLength: 4 };
  },
  persistPath: async (profile, path) => {
    persistCount += 1;
    profile.storageImagePath = path;
  },
});
const firstApply = await runApply();
const secondApply = await runApply();
assert.equal(firstApply.summary.uploaded, 1);
assert.equal(secondApply.summary.alreadyMigrated, 1);
assert.equal(uploadCount, 1, 'rerunning must not overwrite a healthy Storage image');
assert.equal(persistCount, 1);

const repairedProfile = { id: 'repair', driveFileId: '1234567890ABCDE' };
let repaired = '';
let repairIngestions = 0;
const repairedRun = await migrateDatasetProfiles({
  dataset: { slug: 'spring-2026' },
  profiles: [repairedProfile],
  dryRun: false,
  findExistingPath: async () => 'spring-2026/repair/primary.webp',
  ingest: async () => { repairIngestions += 1; },
  persistPath: async (_profile, path) => { repaired = path; },
});
assert.equal(repairedRun.summary.alreadyMigrated, 1);
assert.equal(repairIngestions, 0, 'an uploaded object from a partial prior run should be reused');
assert.equal(repaired, 'spring-2026/repair/primary.webp');

const migrationSql = await readFile(new URL('../supabase/migrations/202608200001_profile_image_storage.sql', import.meta.url), 'utf8');
assert.match(migrationSql, /storage_image_path text/);
assert.match(migrationSql, /bucket_id = 'profile-images'/);
assert.match(migrationSql, /for select[\s\S]*to anon, authenticated/);
assert.doesNotMatch(migrationSql, /for (?:insert|update|delete)[\s\S]*to anon, authenticated/i);
assert.match(migrationSql, /grant execute on function public\.set_profile_storage_image_path\(uuid, text, text\) to service_role/);

const multiImageMigrationSql = await readFile(new URL('../supabase/migrations/202608200002_profile_images.sql', import.meta.url), 'utf8');
assert.match(multiImageMigrationSql, /create table if not exists public\.profile_images/);
assert.match(multiImageMigrationSql, /foreign key \(dataset_id, profile_id\)[\s\S]*references public\.dataset_profiles\(dataset_id, profile_id\)[\s\S]*on delete cascade/);
assert.match(multiImageMigrationSql, /unique \(dataset_id, profile_id, position\)/);
assert.match(multiImageMigrationSql, /profile_images_one_primary_idx[\s\S]*where is_primary/);
assert.match(multiImageMigrationSql, /A profile with images must have exactly one primary image/);
assert.match(multiImageMigrationSql, /A profile image cannot be moved to another dataset profile/);
assert.match(multiImageMigrationSql, /from public\.dataset_profiles[\s\S]*where storage_image_path is not null[\s\S]*not exists[\s\S]*on conflict \(dataset_id, profile_id, storage_path\) do nothing/);
assert.match(multiImageMigrationSql, /jsonb_agg\([\s\S]*order by pi\.position, pi\.id/);
assert.match(multiImageMigrationSql, /revoke all on table public\.profile_images from anon, authenticated/);
assert.doesNotMatch(multiImageMigrationSql, /grant (?:insert|update|delete) on table public\.profile_images to (?:anon|authenticated)/i);
assert.match(multiImageMigrationSql, /grant select, insert, update, delete on table public\.profile_images to service_role/);

const browserGraphSources = await Promise.all([
  '../components/ProfileImage.js',
  '../components/ProfileCard.js',
  '../components/ProfileDetail.js',
  '../lib/supabase/browser.js',
  '../lib/supabase/config.js',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
for (const source of browserGraphSources) {
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/, 'browser-reachable code must not reference the service key');
}
const profileCardSource = browserGraphSources[1];
assert.equal((profileCardSource.match(/<ProfileImage/g) || []).length, 1, 'discovery cards must continue rendering exactly one primary image');
const imageServerSource = await readFile(new URL('../lib/profile-images-server.js', import.meta.url), 'utf8');
assert.match(imageServerSource, /import 'server-only'/);
assert.doesNotMatch(imageServerSource, /SUPABASE_SERVICE_ROLE_KEY/);
const adminDatasetSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
assert.match(adminDatasetSource, /from\('profile_images'\)/, 'READY/Admin detail preview must load relational image metadata');
assert.match(adminDatasetSource, /resolveProfileImage\(\{ \.\.\.row\.public_data, profileImages \}\)/, 'READY/Admin detail preview must use shared image resolution');
const migrationToolSource = await readFile(new URL('../scripts/migrate-drive-images-to-supabase.mjs', import.meta.url), 'utf8');
assert.match(migrationToolSource, /pathExists\(storagePath\)[\s\S]*listImagePaths/, 'canonical-path reruns must recognize UUID-named image objects');
assert.match(migrationToolSource, /findExistingPath\(profile\)[\s\S]*listPrimaryPaths/, 'legacy recovery must remain limited to unambiguous primary objects');

console.log('Profile image Storage paths, resolution, ingestion, migration, security, and preview tests passed.');
