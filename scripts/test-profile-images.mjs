#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  MAX_PROFILE_IMAGE_BYTES,
  ProfileImageIngestionError,
  classifyProfileImageSource,
  detectImageContentType,
  normalizeImageOrientation,
  rotateImage,
  validatedImageFromResponse,
} from '../lib/profile-image-ingestion.js';
import { migrateDatasetProfiles } from '../lib/profile-image-migration.js';
import {
  PROFILE_IMAGE_PLACEHOLDER,
  buildProfileImageStoragePath,
  buildPrimaryStoragePath,
  getPrimaryProfileImage,
  getProfileImages,
  isValidFocalCoordinate,
  isValidProfileImageId,
  isValidStorageImagePath,
  normalizeDisplayMode,
  normalizeFocalCoordinate,
  resolveProfileImageSources,
  withResolvedProfileImage,
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
assert.equal(isValidProfileImageId(imageId), true);
assert.equal(isValidProfileImageId(''), false);
assert.equal(isValidProfileImageId('spring-2026/same-person/primary.webp'), false);
const futurePath = buildProfileImageStoragePath('spring-2026', 'same-person', imageId, 'image/png');
assert.equal(futurePath, `spring-2026/same-person/${imageId}.png`);
assert.equal(isValidStorageImagePath(futurePath), true);
assert.equal(normalizeFocalCoordinate(), 50);
assert.equal(normalizeFocalCoordinate(undefined, 35), 35);
assert.equal(normalizeFocalCoordinate('35.5'), 50);
assert.equal(normalizeFocalCoordinate(-1), 50);
assert.equal(normalizeFocalCoordinate(101), 50);
assert.equal(normalizeFocalCoordinate(' '), 50);
assert.equal(normalizeFocalCoordinate(true), 50);
assert.equal(normalizeFocalCoordinate('not-a-number'), 50);
assert.equal(isValidFocalCoordinate(0), true);
assert.equal(isValidFocalCoordinate(100), true);
assert.equal(isValidFocalCoordinate('50'), false);
assert.equal(isValidFocalCoordinate(true), false);
assert.equal(isValidFocalCoordinate(NaN), false);
assert.equal(normalizeDisplayMode('portrait'), 'portrait');
assert.equal(normalizeDisplayMode('cover'), 'cover');
assert.equal(normalizeDisplayMode('contain'), 'cover');
assert.equal(normalizeDisplayMode(true), 'cover');
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
    { id: 'second', storageImagePath: `spring-2026/same-person/${imageId}.png`, position: 1, isPrimary: true, focalX: 50, focalY: 35, displayMode: 'portrait' },
    { id: 'first', storageImagePath: 'spring-2026/same-person/primary.webp', position: 0, isPrimary: false },
  ],
  image: driveImage,
};
assert.deepEqual(getProfileImages(relationalProfile).map((image) => image.id), ['first', 'second']);
assert.equal(getPrimaryProfileImage(relationalProfile).id, 'second');
assert.equal(getPrimaryProfileImage(relationalProfile).focalY, 35);
assert.equal(getPrimaryProfileImage(relationalProfile).displayMode, 'portrait');
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
assert.deepEqual(
  withResolvedProfileImage({ storageImagePath: springPath }, supabaseOptions).focalX,
  50,
  'legacy images must retain the centered focal default',
);
assert.equal(withResolvedProfileImage({ storageImagePath: springPath }, supabaseOptions).focalY, 35);
assert.equal(withResolvedProfileImage({ storageImagePath: springPath }, supabaseOptions).displayMode, 'cover');

const mixedProfiles = [
  { id: 'stored', storageImagePath: 'spring-2026/stored/primary.jpg', image: driveImage },
  { id: 'drive', image: driveImage },
].map((profile) => resolveProfileImageSources(profile, supabaseOptions));
assert.match(mixedProfiles[0].src, /storage\/v1\/object\/public/);
assert.equal(mixedProfiles[1].src, driveImage);

const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 120, g: 80, b: 40 } } }).jpeg().toBuffer();
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 40, g: 120, b: 80, alpha: 1 } } }).png().toBuffer();
assert.equal(detectImageContentType(jpeg), 'image/jpeg');
assert.equal(detectImageContentType(png), 'image/png');
assert.equal(detectImageContentType(Buffer.from('<svg></svg>')), '', 'SVG must not be accepted as a raster profile image');
const sniffed = await validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Type': 'text/html' } }));
assert.equal(sniffed.contentType, 'image/jpeg', 'content must be detected from bytes, not a filename or header');
const uprightMetadata = await sharp(jpeg).metadata();
const upright = await normalizeImageOrientation(jpeg, 'image/jpeg');
assert.deepEqual(await sharp(upright.bytes).metadata().then((metadata) => ({ width: metadata.width, height: metadata.height })), { width: uprightMetadata.width, height: uprightMetadata.height });
assert.deepEqual(upright.bytes, jpeg, 'upright JPEGs should not be needlessly recompressed');
const oriented = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 220, g: 30, b: 80 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
const normalized = await normalizeImageOrientation(oriented, 'image/jpeg');
const normalizedMetadata = await sharp(normalized.bytes).metadata();
assert.equal(normalizedMetadata.width, 1, 'EXIF orientation should be applied to pixel dimensions');
assert.equal(normalizedMetadata.height, 2, 'EXIF orientation should be applied to pixel dimensions');
assert.equal(normalizedMetadata.orientation, undefined, 'normalized output should not retain EXIF orientation');
assert.equal(normalized.contentType, 'image/jpeg');
const normalizedPng = await normalizeImageOrientation(png, 'image/png');
assert.equal(normalizedPng.contentType, 'image/png');
const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 40, g: 80, b: 160 } } }).webp().toBuffer();
assert.equal((await normalizeImageOrientation(webp, 'image/webp')).contentType, 'image/webp');
const rotated = await rotateImage(jpeg, 'image/jpeg', 90);
const rotatedMetadata = await sharp(rotated.bytes).metadata();
assert.equal(rotatedMetadata.width, 2);
assert.equal(rotatedMetadata.height, 2);
assert.equal(rotatedMetadata.orientation, undefined, 'rotated output should not retain EXIF orientation');
assert.equal(rotated.contentType, 'image/jpeg');
await assert.rejects(
  validatedImageFromResponse(new Response('not an image', { headers: { 'Content-Type': 'image/jpeg' } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_content',
);
await assert.rejects(
  validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Length': String(MAX_PROFILE_IMAGE_BYTES + 1) } })),
  /15 MiB/,
);
await assert.rejects(
  validatedImageFromResponse(new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb]), { headers: { 'Content-Type': 'image/jpeg' } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_content',
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
assert.match(multiImageMigrationSql, /focal_x numeric\(5, 2\) check \(focal_x between 0 and 100\)/);
assert.match(multiImageMigrationSql, /focal_y numeric\(5, 2\) check \(focal_y between 0 and 100\)/);
assert.match(multiImageMigrationSql, /display_mode text not null default 'cover' check \(display_mode in \('cover', 'portrait'\)\)/);
assert.match(multiImageMigrationSql, /foreign key \(dataset_id, profile_id\)[\s\S]*references public\.dataset_profiles\(dataset_id, profile_id\)[\s\S]*on delete cascade/);
assert.match(multiImageMigrationSql, /unique \(dataset_id, profile_id, position\)/);
assert.match(multiImageMigrationSql, /profile_images_one_primary_idx[\s\S]*where is_primary/);
assert.match(multiImageMigrationSql, /A profile with images must have exactly one primary image/);
assert.match(multiImageMigrationSql, /A profile image cannot be moved to another dataset profile/);
assert.match(multiImageMigrationSql, /from public\.dataset_profiles[\s\S]*where storage_image_path is not null[\s\S]*not exists[\s\S]*on conflict \(dataset_id, profile_id, storage_path\) do nothing/);
assert.match(multiImageMigrationSql, /jsonb_agg\([\s\S]*order by pi\.position, pi\.id/);
assert.match(multiImageMigrationSql, /'focalX', pi\.focal_x[\s\S]*'focalY', pi\.focal_y/);
assert.match(multiImageMigrationSql, /'displayMode', pi\.display_mode/);
assert.match(multiImageMigrationSql, /\{focalX\}[\s\S]*primary_image\.focal_x[\s\S]*\{focalY\}[\s\S]*primary_image\.focal_y/);
assert.match(multiImageMigrationSql, /\{displayMode\}[\s\S]*primary_image\.display_mode/);
assert.match(multiImageMigrationSql, /revoke all on table public\.profile_images from anon, authenticated/);
assert.doesNotMatch(multiImageMigrationSql, /grant (?:insert|update|delete) on table public\.profile_images to (?:anon|authenticated)/i);
assert.match(multiImageMigrationSql, /grant select, insert, update, delete on table public\.profile_images to service_role/);
const adminImageMigrationSql = await readFile(new URL('../supabase/migrations/202608210001_profile_image_admin_management.sql', import.meta.url), 'utf8');
assert.match(adminImageMigrationSql, /create or replace function public\.create_profile_image_metadata/);
assert.match(adminImageMigrationSql, /create or replace function public\.set_profile_image_primary/);
assert.match(adminImageMigrationSql, /create or replace function public\.reorder_profile_images/);
assert.match(adminImageMigrationSql, /create or replace function public\.delete_profile_image/);
assert.match(adminImageMigrationSql, /create or replace function public\.replace_profile_image_storage_path/);
assert.match(adminImageMigrationSql, /revoke all on function public\.create_profile_image_metadata/);
assert.match(adminImageMigrationSql, /grant execute on function public\.delete_profile_image\(uuid, text, uuid\) to service_role/);

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
const homepageSource = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(homepageSource, /export const dynamic = ['"]force-dynamic['"]/,
  'homepage must read current public image metadata instead of a static dataset snapshot');
const adminDatasetSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
assert.match(adminDatasetSource, /from\('profile_images'\)/, 'READY/Admin detail preview must load relational image metadata');
assert.match(adminDatasetSource, /focalX: image\.focal_x[\s\S]*focalY: image\.focal_y/);
assert.match(adminDatasetSource, /displayMode: image\.display_mode/);
assert.match(adminDatasetSource, /resolveProfileImage\(\{ \.\.\.row\.public_data, profileImages \}\)/, 'READY/Admin detail preview must use shared image resolution');
assert.match(adminDatasetSource, /updateAdminProfileImageFocal[\s\S]*\.eq\('dataset_id', datasetId\)[\s\S]*\.eq\('profile_id', profileId\)/);
assert.match(adminDatasetSource, /if \(imageError\)[\s\S]*\.select\('id,storage_path,position,is_primary,focal_x,focal_y'\)/, 'Admin preview should remain compatible before display_mode is applied');
assert.match(adminDatasetSource, /if \(fallback\.error\)[\s\S]*\.select\('id,storage_path,position,is_primary'\)/, 'Admin preview must retain image IDs when focal columns are not deployed yet');
const adminProfilePreviewSource = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');
assert.match(adminProfilePreviewSource, /editableImage[\s\S]*imageId: editableImage\?\.id/);
const profileDetailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
assert.match(profileDetailSource, /\{adminPreview && hasEditableImage\s*\n\s*\? <FocalPointEditor/, 'Admin previews must mount the focal editor only for relational images');
const profileImageSource = browserGraphSources[0];
assert.match(profileImageSource, /objectPosition: `\$\{focalX\}% \$\{focalY\}%`/);
assert.match(profileImageSource, /objectFit: displayMode === 'portrait' \? 'contain' : 'cover'/);
const focalEditorSource = await readFile(new URL('../components/FocalPointEditor.js', import.meta.url), 'utf8');
assert.match(focalEditorSource, /role="slider"/);
assert.match(focalEditorSource, /api\/admin\/datasets\/focal/);
const focalRouteSource = await readFile(new URL('../app/api/admin/datasets/focal/route.js', import.meta.url), 'utf8');
assert.match(focalRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(focalRouteSource, /isValidFocalCoordinate\(body\?\.focalX\)/);
assert.match(focalRouteSource, /isValidFocalCoordinate\(body\?\.focalY\)/);
assert.match(focalRouteSource, /return Response\.json\(\{ error: 'Focal coordinates must be numbers from 0 to 100\.' \}, \{ status: 400 \}\)/);
assert.doesNotMatch(focalRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
assert.match(focalRouteSource, /Display mode must be cover or portrait/);
const uploadRouteSource = await readFile(new URL('../app/api/admin/datasets/images/route.js', import.meta.url), 'utf8');
assert.match(uploadRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(uploadRouteSource, /normalizeImageOrientation/);
assert.match(uploadRouteSource, /buildProfileImageStoragePath/);
assert.doesNotMatch(uploadRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
const imageActionRouteSource = await readFile(new URL('../app/api/admin/datasets/images/action/route.js', import.meta.url), 'utf8');
assert.match(imageActionRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(imageActionRouteSource, /set-primary/);
assert.match(imageActionRouteSource, /reorder/);
assert.match(imageActionRouteSource, /delete/);
assert.match(imageActionRouteSource, /rotate-left/);
assert.match(imageActionRouteSource, /rotate-right/);
assert.match(imageActionRouteSource, /rotateImage/);
assert.match(imageActionRouteSource, /buildProfileImageStoragePath/);
assert.match(imageActionRouteSource, /replaceAdminProfileImageStoragePath/);
assert.match(imageActionRouteSource, /upsert: false/);
assert.doesNotMatch(imageActionRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
const imageManagerSource = await readFile(new URL('../components/AdminImageManager.js', import.meta.url), 'utf8');
assert.match(imageManagerSource, /api\/admin\/datasets\/images/);
assert.match(imageManagerSource, /FocalPointEditor/);
assert.match(imageManagerSource, /controlsOutside/);
assert.match(focalEditorSource, /focal-editor-canvas/);
assert.match(focalEditorSource, /focal-editor-editing-image/);
const profileSearchSource = await readFile(new URL('../components/AdminProfileSearch.js', import.meta.url), 'utf8');
assert.match(profileSearchSource, /profile\.name, profile\.id, profile\.major, profile\.role/);
assert.match(profileSearchSource, /No profiles match/);
const migrationToolSource = await readFile(new URL('../scripts/migrate-drive-images-to-supabase.mjs', import.meta.url), 'utf8');
assert.match(migrationToolSource, /pathExists\(storagePath\)[\s\S]*listImagePaths/, 'canonical-path reruns must recognize UUID-named image objects');
assert.match(migrationToolSource, /findExistingPath\(profile\)[\s\S]*listPrimaryPaths/, 'legacy recovery must remain limited to unambiguous primary objects');

console.log('Profile image Storage paths, resolution, ingestion, migration, security, and preview tests passed.');
