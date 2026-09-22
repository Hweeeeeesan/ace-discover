#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  DISCOVERY_IMAGE_LONG_EDGE,
  DISCOVERY_IMAGE_WEBP_QUALITY,
  PROFILE_DETAIL_LONG_EDGE,
  PROFILE_DETAIL_WEBP_QUALITY,
  deriveMissingProfileDetailImages,
  deriveMissingProfileImages,
  generateDiscoveryDerivative,
  generateProfileDetailDerivative,
} from '../lib/profile-image-derivatives.js';
import { generateProfileImageAssets, ingestProfileImages } from '../lib/profile-image-ingestion.js';
import { buildGalleryReplacementPlan } from '../lib/profile-image-migration.js';
import {
  buildDiscoveryDerivativeStoragePath,
  buildProfileDetailDerivativeStoragePath,
  isValidDiscoveryStorageImagePath,
  isValidProfileDetailStorageImagePath,
  profileImagePresentationStyle,
  withResolvedProfileImage,
} from '../lib/profile-images.js';
import { parseArguments } from './derive-profile-images.mjs';
import { parseArguments as parseProfileArguments } from './derive-profile-detail-images.mjs';

const imageId = '4f5d1d8a-8a6f-4d44-9aac-2a7358db7f92';
const canonicalPath = `fall-2026/ivy-ngo/${imageId}.jpg`;
const derivativePath = buildDiscoveryDerivativeStoragePath('fall-2026', 'ivy-ngo', imageId);
const profileDerivativePath = buildProfileDetailDerivativeStoragePath('fall-2026', 'ivy-ngo', imageId);
assert.equal(derivativePath, `fall-2026/ivy-ngo/derived/${imageId}-discovery.webp`);
assert.equal(isValidDiscoveryStorageImagePath(derivativePath), true);
assert.equal(profileDerivativePath, `fall-2026/ivy-ngo/derived/${imageId}-profile.webp`);
assert.equal(isValidProfileDetailStorageImagePath(profileDerivativePath), true);
assert.equal(isValidDiscoveryStorageImagePath(`${canonicalPath}?v=1`), false, 'derivative URLs must stay immutable and query-free');
assert.equal(PROFILE_DETAIL_LONG_EDGE, 1800);
assert.equal(PROFILE_DETAIL_WEBP_QUALITY, 84);
assert.equal(DISCOVERY_IMAGE_LONG_EDGE, 1400);
assert.equal(DISCOVERY_IMAGE_WEBP_QUALITY, 80);

const largeJpeg = await sharp({
  create: { width: 3000, height: 2000, channels: 3, background: { r: 90, g: 130, b: 170 } },
}).jpeg({ quality: 95 }).toBuffer();
const assets = await generateProfileImageAssets(largeJpeg);
assert.equal(assets.canonical.contentType, 'image/jpeg');
assert.deepEqual(
  { width: assets.profile.width, height: assets.profile.height },
  { width: 1800, height: 1200 },
  'ProfileDetail assets must be constrained to the detail long edge',
);
assert.deepEqual(
  { width: assets.canonical.width, height: assets.canonical.height },
  { width: 3000, height: 2000 },
  'the normalized canonical source must retain its full dimensions',
);
assert.deepEqual(
  { width: assets.discovery.width, height: assets.discovery.height },
  { width: 1400, height: 933 },
  'Discovery assets must be derived without changing aspect ratio',
);
assert.equal((await sharp(assets.profile.bytes).metadata()).format, 'webp');
assert.equal((await sharp(assets.discovery.bytes).metadata()).format, 'webp');

const smallJpeg = await sharp({
  create: { width: 600, height: 400, channels: 3, background: { r: 40, g: 80, b: 120 } },
}).jpeg().toBuffer();
const smallAssets = await generateProfileImageAssets(smallJpeg);
assert.deepEqual(
  { width: smallAssets.profile.width, height: smallAssets.profile.height },
  { width: 600, height: 400 },
  'ProfileDetail generation must never upscale',
);
assert.deepEqual(
  { width: smallAssets.discovery.width, height: smallAssets.discovery.height },
  { width: 600, height: 400 },
  'Discovery generation must never upscale',
);

const transparentPng = await sharp({
  create: { width: 900, height: 700, channels: 4, background: { r: 220, g: 80, b: 130, alpha: 0.35 } },
}).png().toBuffer();
const transparentAssets = await generateProfileImageAssets(transparentPng);
const alphaMetadata = await sharp(transparentAssets.profile.bytes).metadata();
const alphaStats = await sharp(transparentAssets.profile.bytes).stats();
assert.equal(alphaMetadata.format, 'webp');
assert.equal(alphaMetadata.hasAlpha, true, 'transparent inputs must remain alpha-capable WebP');
assert.ok(alphaStats.channels[3].min < 255, 'transparent pixels must not be flattened');

const focalMetadata = { focalX: 0, focalY: 100, displayMode: 'cover' };
assert.deepEqual(profileImagePresentationStyle(focalMetadata), {
  objectFit: 'cover',
  objectPosition: '0% 100%',
});
assert.deepEqual(focalMetadata, { focalX: 0, focalY: 100, displayMode: 'cover' }, 'derivation must not mutate focal/display metadata');

const supabaseOptions = { supabaseUrl: 'https://ace-discover.supabase.co', bucket: 'profile-images' };
const discoveryResolved = withResolvedProfileImage({
  storageImagePath: derivativePath,
  focalX: 20,
  focalY: 70,
  displayMode: 'cover',
}, supabaseOptions);
assert.match(discoveryResolved.image, /\/derived\/.*-discovery\.webp$/, 'Discovery resolution must accept the derivative path projected by its RPC');
assert.deepEqual(
  { focalX: discoveryResolved.focalX, focalY: discoveryResolved.focalY, displayMode: discoveryResolved.displayMode },
  { focalX: 20, focalY: 70, displayMode: 'cover' },
);
const canonicalFallback = withResolvedProfileImage({ storageImagePath: canonicalPath }, supabaseOptions);
assert.match(canonicalFallback.image, new RegExp(`${imageId}\\.jpg$`), 'unbackfilled Discovery profiles must fall back to canonical');
const detailResolved = withResolvedProfileImage({
  storageImagePath: derivativePath,
  profileImages: [{
    id: imageId,
    storageImagePath: canonicalPath,
    profileStorageImagePath: profileDerivativePath,
    position: 0,
    isPrimary: true,
    focalX: 20,
    focalY: 70,
    displayMode: 'cover',
  }],
}, supabaseOptions);
assert.match(detailResolved.image, /-profile\.webp$/, 'ProfileDetail must prefer its dedicated derivative');
const detailFallback = withResolvedProfileImage({
  profileImages: [{ id: imageId, storageImagePath: canonicalPath, position: 0, isPrimary: true }],
}, supabaseOptions);
assert.match(detailFallback.image, new RegExp(`${imageId}\\.jpg$`), 'ProfileDetail must fall back to canonical');

const directUploads = [];
const direct = await ingestProfileImages({
  profile: { id: 'ivy-ngo', driveFileId: 'drive-file', imageKind: 'drive-file' },
  datasetSlug: 'fall-2026',
  driveAuth: {},
  dryRun: false,
  upload: async (asset) => directUploads.push(asset),
  remove: async () => {},
  createImageId: () => imageId,
  driveClient: {
    fetchDriveImage: async () => new Response(largeJpeg, {
      headers: { 'Content-Type': 'image/jpeg', 'x-drive-download-source': 'original_media' },
    }),
    listFilesInFolder: async () => [],
  },
});
assert.equal(direct.images.length, 1);
assert.equal(directUploads.length, 3, 'new ingestion must stage canonical, ProfileDetail, and Discovery objects before metadata');
assert.equal(directUploads[0].contentType, 'image/jpeg');
assert.equal(directUploads[1].contentType, 'image/webp');
assert.equal(directUploads[2].contentType, 'image/webp');
assert.equal(direct.images[0].storagePath, canonicalPath);
assert.equal(direct.images[0].profileStoragePath, profileDerivativePath);
assert.equal(direct.images[0].discoveryStoragePath, derivativePath);

function backfillImage(overrides = {}) {
  return {
    id: imageId,
    profileId: 'ivy-ngo',
    storagePath: canonicalPath,
    discoveryStoragePath: '',
    isPrimary: true,
    imageClearedByAdmin: false,
    ...overrides,
  };
}

const fakeDerivative = {
  bytes: Buffer.from('derived'),
  contentType: 'image/webp',
  width: 1400,
  height: 933,
  byteLength: 7,
  sourceWidth: 3000,
  sourceHeight: 2000,
};
let dryRunMutations = 0;
const dryRunResult = await deriveMissingProfileImages({
  images: [backfillImage()],
  dryRun: true,
  download: async () => Buffer.alloc(100),
  upload: async () => { dryRunMutations += 1; },
  updateMetadata: async () => { dryRunMutations += 1; },
  remove: async () => { dryRunMutations += 1; },
  buildDerivativePath: () => derivativePath,
  derive: async () => fakeDerivative,
});
assert.equal(dryRunMutations, 0, 'dry-run must make zero Storage or database changes');
assert.equal(dryRunResult.rows[0].status, 'dry_run_derived');

const applyOrder = [];
const applyResult = await deriveMissingProfileImages({
  images: [backfillImage(), backfillImage({ id: 'f6e62e23-911e-4e7b-80b6-adfb9d0ff403', isPrimary: false })],
  dryRun: false,
  concurrency: 1,
  download: async () => Buffer.alloc(100),
  upload: async () => { applyOrder.push('upload'); },
  updateMetadata: async () => { applyOrder.push('metadata'); },
  remove: async () => { applyOrder.push('remove'); },
  buildDerivativePath: (image) => `fall-2026/ivy-ngo/derived/${image.id}-discovery.webp`,
  derive: async () => fakeDerivative,
});
assert.deepEqual(applyOrder, ['upload', 'metadata', 'upload', 'metadata'], 'apply must upload before each metadata update');
assert.equal(applyResult.summary.derived, 2, 'primary and secondary rows should both receive derivatives');

const rollbackOrder = [];
const metadataFailure = await deriveMissingProfileImages({
  images: [backfillImage()],
  dryRun: false,
  download: async () => Buffer.alloc(100),
  upload: async () => rollbackOrder.push('upload'),
  updateMetadata: async () => { rollbackOrder.push('metadata'); throw new Error('database unavailable'); },
  remove: async () => rollbackOrder.push('remove'),
  buildDerivativePath: () => derivativePath,
  derive: async () => fakeDerivative,
});
assert.deepEqual(rollbackOrder, ['upload', 'metadata', 'remove']);
assert.equal(metadataFailure.rows[0].status, 'failed');
assert.equal(metadataFailure.rows[0].storagePath, canonicalPath, 'metadata failure must preserve canonical identity');

let derivativeFailureMutations = 0;
const derivativeFailure = await deriveMissingProfileImages({
  images: [backfillImage()],
  dryRun: false,
  download: async () => Buffer.alloc(100),
  upload: async () => { derivativeFailureMutations += 1; },
  updateMetadata: async () => { derivativeFailureMutations += 1; },
  remove: async () => { derivativeFailureMutations += 1; },
  buildDerivativePath: () => derivativePath,
  derive: async () => { throw new Error('unsupported source'); },
});
assert.equal(derivativeFailureMutations, 0);
assert.equal(derivativeFailure.rows[0].status, 'failed');

let clearedDownloads = 0;
const intentionallyCleared = await deriveMissingProfileImages({
  images: [backfillImage({ imageClearedByAdmin: true })],
  dryRun: true,
  download: async () => { clearedDownloads += 1; return Buffer.alloc(10); },
  buildDerivativePath: () => derivativePath,
  derive: async () => fakeDerivative,
});
assert.equal(clearedDownloads, 0);
assert.equal(intentionallyCleared.rows[0].status, 'skipped_intentionally_cleared');

let profileDryRunMutations = 0;
const profileDryRun = await deriveMissingProfileDetailImages({
  images: [backfillImage({ profileStoragePath: '' })],
  dryRun: true,
  download: async () => Buffer.alloc(100),
  upload: async () => { profileDryRunMutations += 1; },
  updateMetadata: async () => { profileDryRunMutations += 1; },
  remove: async () => { profileDryRunMutations += 1; },
  buildDerivativePath: () => profileDerivativePath,
  derive: async () => ({ ...fakeDerivative, width: 1800, height: 1200 }),
});
assert.equal(profileDryRunMutations, 0, 'ProfileDetail dry-run must be zero mutation');
assert.equal(profileDryRun.rows[0].profileStoragePath, profileDerivativePath);

const profileApplyOrder = [];
await deriveMissingProfileDetailImages({
  images: [backfillImage({ profileStoragePath: '' })],
  dryRun: false,
  download: async () => Buffer.alloc(100),
  upload: async () => profileApplyOrder.push('upload'),
  updateMetadata: async () => profileApplyOrder.push('metadata'),
  remove: async () => profileApplyOrder.push('remove'),
  buildDerivativePath: () => profileDerivativePath,
  derive: async () => ({ ...fakeDerivative, width: 1800, height: 1200 }),
});
assert.deepEqual(profileApplyOrder, ['upload', 'metadata'], 'ProfileDetail apply must upload before CAS metadata');

const profileFailureOrder = [];
const profileMetadataFailure = await deriveMissingProfileDetailImages({
  images: [backfillImage({ profileStoragePath: '' })],
  dryRun: false,
  download: async () => Buffer.alloc(100),
  upload: async () => profileFailureOrder.push('upload'),
  updateMetadata: async () => {
    profileFailureOrder.push('metadata');
    throw new Error('compare-and-set failed');
  },
  remove: async () => profileFailureOrder.push('remove'),
  buildDerivativePath: () => profileDerivativePath,
  derive: async () => ({ ...fakeDerivative, width: 1800, height: 1200 }),
});
assert.deepEqual(profileFailureOrder, ['upload', 'metadata', 'remove'],
  'a failed ProfileDetail metadata commit must clean up its staged derivative');
assert.equal(profileMetadataFailure.rows[0].status, 'failed');

let profileClearedDownloads = 0;
const profileIntentionallyCleared = await deriveMissingProfileDetailImages({
  images: [backfillImage({ profileStoragePath: '', imageClearedByAdmin: true })],
  dryRun: true,
  download: async () => { profileClearedDownloads += 1; return Buffer.alloc(100); },
  buildDerivativePath: () => profileDerivativePath,
  derive: async () => ({ ...fakeDerivative, width: 1800, height: 1200 }),
});
assert.equal(profileClearedDownloads, 0, 'ProfileDetail backfill must not read intentionally cleared images');
assert.equal(profileIntentionallyCleared.rows[0].status, 'skipped_intentionally_cleared');

let alreadyDerivedDownloads = 0;
const profileAlreadyDerived = await deriveMissingProfileDetailImages({
  images: [backfillImage({ profileStoragePath: profileDerivativePath })],
  dryRun: true,
  download: async () => { alreadyDerivedDownloads += 1; return Buffer.alloc(100); },
  buildDerivativePath: () => profileDerivativePath,
});
assert.equal(alreadyDerivedDownloads, 0, 'idempotent reruns must skip rows with ProfileDetail metadata');
assert.equal(profileAlreadyDerived.summary.alreadyDerived, 1);
assert.equal(profileAlreadyDerived.summary.imagesNeedingDerivative, 0);

assert.deepEqual(parseArguments(['fall-2026', '--dry-run', '--profile', 'ivy-ngo']), {
  datasetSlug: 'fall-2026',
  apply: false,
  explicitDryRun: true,
  profileId: 'ivy-ngo',
  concurrency: 2,
  help: false,
  dryRun: true,
});
assert.throws(() => parseArguments(['fall-2026', '--apply', '--dry-run']), /either --apply or --dry-run/);
assert.throws(() => parseArguments(['fall-2026', '--concurrency', '20']), /1 through 4/);
assert.equal(parseProfileArguments(['fall-2026', '--dry-run']).dryRun, true);

const replacementPlan = buildGalleryReplacementPlan(
  [{
    id: imageId,
    storagePath: canonicalPath,
    profileStoragePath: profileDerivativePath,
    discoveryStoragePath: derivativePath,
    position: 0,
    isPrimary: true,
    focalX: 0,
    focalY: 100,
    displayMode: 'portrait',
  }],
  [{
    imageId: 'f6e62e23-911e-4e7b-80b6-adfb9d0ff403',
    storagePath: 'fall-2026/ivy-ngo/f6e62e23-911e-4e7b-80b6-adfb9d0ff403.webp',
    profileStoragePath: 'fall-2026/ivy-ngo/derived/f6e62e23-911e-4e7b-80b6-adfb9d0ff403-profile.webp',
    profileWidth: 1800,
    profileHeight: 1200,
    profileMimeType: 'image/webp',
    profileByteLength: 234567,
    discoveryStoragePath: 'fall-2026/ivy-ngo/derived/f6e62e23-911e-4e7b-80b6-adfb9d0ff403-discovery.webp',
    discoveryWidth: 1400,
    discoveryHeight: 933,
    discoveryMimeType: 'image/webp',
    discoveryByteLength: 123456,
  }],
);
assert.equal(replacementPlan.replacementRows[0].focalX, 0);
assert.equal(replacementPlan.replacementRows[0].focalY, 100);
assert.equal(replacementPlan.replacementRows[0].displayMode, 'portrait');
assert.equal(replacementPlan.replacementRows[0].discoveryByteLength, 123456);
assert.equal(replacementPlan.replacementRows[0].profileByteLength, 234567);
assert.deepEqual(replacementPlan.oldStoragePaths, [canonicalPath, profileDerivativePath, derivativePath]);

const migrationSource = await readFile(new URL('../supabase/migrations/202609210001_profile_image_derivatives.sql', import.meta.url), 'utf8');
for (const column of ['discovery_storage_path', 'discovery_width', 'discovery_height', 'discovery_mime_type', 'discovery_byte_length']) {
  assert.match(migrationSource, new RegExp(`add column if not exists ${column}`));
}
assert.match(migrationSource, /coalesce\(primary_discovery_storage_path, primary_storage_path, legacy_storage_image_path\)/);
assert.match(migrationSource, /when include_gallery then coalesce\(primary_storage_path, legacy_storage_image_path\)/);
assert.match(migrationSource, /set_profile_image_discovery_derivative/);
assert.match(migrationSource, /and discovery_storage_path is null/, 'backfill metadata updates must be compare-and-set');

const profileMigrationSource = await readFile(new URL('../supabase/migrations/202609220001_profile_detail_image_derivatives.sql', import.meta.url), 'utf8');
for (const column of ['profile_storage_path', 'profile_width', 'profile_height', 'profile_mime_type', 'profile_byte_length']) {
  assert.match(profileMigrationSource, new RegExp(`add column if not exists ${column}`));
}
assert.match(profileMigrationSource, /profile_images_profile_metadata_complete/);
assert.match(profileMigrationSource, /-profile\.webp/);
assert.match(profileMigrationSource, /set_profile_image_profile_derivative/);
assert.match(profileMigrationSource, /create_profile_image_gallery_with_profile_derivatives_if_empty/);
assert.match(profileMigrationSource, /replace_profile_image_gallery_with_profile_derivatives/);
assert.doesNotMatch(profileMigrationSource, /drop function public\.create_profile_image_with_derivative/,
  'the migration must preserve the old ingestion RPC during staged rollout');
assert.doesNotMatch(profileMigrationSource, /drop function public\.replace_profile_image_assets/,
  'the migration must preserve the old replacement RPC during staged rollout');
assert.match(profileMigrationSource, /and profile_storage_path is null/, 'ProfileDetail backfill must compare-and-set');
assert.match(profileMigrationSource, /when include_gallery then coalesce\(primary_profile_storage_path, primary_storage_path, legacy_storage_image_path\)/);
assert.match(profileMigrationSource, /else coalesce\(primary_discovery_storage_path, primary_storage_path, legacy_storage_image_path\)/);

const uploadRoute = await readFile(new URL('../app/api/admin/datasets/images/route.js', import.meta.url), 'utf8');
assert.match(uploadRoute, /generateProfileImageAssets/);
assert.match(uploadRoute, /assets\.canonical\.bytes/);
assert.match(uploadRoute, /assets\.profile\.bytes/);
assert.match(uploadRoute, /assets\.discovery\.bytes/);
assert.match(uploadRoute, /cacheControl: '31536000'/);
const actionRoute = await readFile(new URL('../app/api/admin/datasets/images/action/route.js', import.meta.url), 'utf8');
assert.match(actionRoute, /image\.discoveryStoragePath/);
assert.match(actionRoute, /image\.profileStoragePath/);
assert.match(actionRoute, /\[rotatedPath, profilePath, discoveryPath\]/);
const profileCard = await readFile(new URL('../components/ProfileCard.js', import.meta.url), 'utf8');
assert.match(profileCard, /eager=\{active \|\| index === 0\}/, 'only the active/first Discovery card should be eager');
const focalEditor = await readFile(new URL('../components/FocalPointEditor.js', import.meta.url), 'utf8');
assert.match(focalEditor, /eager=\{eager\}/);
const imageManager = await readFile(new URL('../components/AdminImageManager.js', import.meta.url), 'utf8');
assert.match(imageManager, /eager=\{index === 0\}/, 'only the first Admin image manager preview should be eager');

const backfillSource = await readFile(new URL('./derive-profile-images.mjs', import.meta.url), 'utf8');
assert.match(backfillSource, /dryRun: options\.dryRun/);
assert.match(backfillSource, /cacheControl: '31536000'/);
assert.match(backfillSource, /upsert: false/);
assert.match(backfillSource, /set_profile_image_discovery_derivative/);
assert.doesNotMatch(backfillSource, /signedUrl|createSignedUrl|\?token=/i, 'backfill must retain stable public paths');

const independentlyDerived = await generateDiscoveryDerivative(assets.canonical.bytes);
assert.equal(independentlyDerived.width, 1400);
assert.equal(independentlyDerived.contentType, 'image/webp');
const independentlyDerivedProfile = await generateProfileDetailDerivative(assets.canonical.bytes);
assert.equal(independentlyDerivedProfile.width, 1800);
assert.equal(independentlyDerivedProfile.contentType, 'image/webp');

console.log('Profile image derivative tests passed.');
