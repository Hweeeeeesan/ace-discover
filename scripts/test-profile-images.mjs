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
import {
  buildGalleryReplacementPlan,
  migrateDatasetProfileGalleries,
  migrateDatasetProfiles,
} from '../lib/profile-image-migration.js';
import { parseArguments as parseImageMigrationArguments } from './migrate-drive-images-to-supabase.mjs';
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
  resolveProfileImageSourcesForImage,
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
const secondaryResolved = resolveProfileImageSourcesForImage(
  { storageImagePath: `spring-2026/same-person/${imageId}.png` },
  supabaseOptions,
);
assert.match(secondaryResolved.src, /\/same-person\//);
assert.doesNotMatch(secondaryResolved.src, /primary\.webp/);
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
const fullResolutionJpeg = await sharp({
  create: { width: 641, height: 427, channels: 3, background: { r: 90, g: 130, b: 170 } },
}).jpeg().toBuffer();
const fullResolutionNormalized = await normalizeImageOrientation(fullResolutionJpeg, 'image/jpeg');
assert.deepEqual(
  { width: fullResolutionNormalized.width, height: fullResolutionNormalized.height },
  { width: 641, height: 427 },
  'normal JPEG ingestion must preserve original pixel dimensions',
);
const oriented = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 220, g: 30, b: 80 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
const normalized = await normalizeImageOrientation(oriented, 'image/jpeg');
const normalizedMetadata = await sharp(normalized.bytes).metadata();
assert.equal(normalizedMetadata.width, 1, 'EXIF orientation should be applied to pixel dimensions');
assert.equal(normalizedMetadata.height, 2, 'EXIF orientation should be applied to pixel dimensions');
assert.equal(normalizedMetadata.orientation, undefined, 'normalized output should not retain EXIF orientation');
assert.deepEqual(
  { width: normalized.width, height: normalized.height },
  { width: 1, height: 2 },
  'EXIF normalization may swap dimensions but must not downscale them',
);
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
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_file_type',
);
await assert.rejects(
  validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Length': String(MAX_PROFILE_IMAGE_BYTES + 1) } })),
  /15 MiB/,
);
await assert.rejects(
  validatedImageFromResponse(new Response(Buffer.from([0xff, 0xd8, 0xff, 0xdb]), { headers: { 'Content-Type': 'image/jpeg' } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'corrupt_image',
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

const galleryProfile = {
  id: 'gallery',
  name: 'Gallery',
  driveFolderId: '1234567890FOLDER',
  imageKind: 'drive-folder',
  profileImages: [],
};
const galleryCandidates = [1, 2, 3].map((position) => ({
  imageId: `${position}${String(position).repeat(7)}-${String(position).repeat(4)}-4${String(position).repeat(3)}-8${String(position).repeat(3)}-${String(position).repeat(12)}`,
  storagePath: `fall-2026/gallery/${String(position).repeat(8)}-${String(position).repeat(4)}-4${String(position).repeat(3)}-8${String(position).repeat(3)}-${String(position).repeat(12)}.jpg`,
  resolvedDriveFileId: `1234567890IMAGE${position}`,
  name: `photo${position}.jpg`,
}));
const createdGalleryRows = [];
const migrateGallery = () => migrateDatasetProfileGalleries({
  dataset: { id: 'dataset-id', slug: 'fall-2026' },
  profiles: [galleryProfile],
  dryRun: false,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 4,
    supportedImages: 3,
    images: galleryCandidates,
    rejected: [{ name: 'notes.pdf', category: 'unsupported_file_type', detail: 'Ignored.' }],
  }),
  createImage: async ({ image, makePrimary }) => {
    const row = {
      id: image.imageId,
      storagePath: image.storagePath,
      position: createdGalleryRows.length,
      isPrimary: makePrimary,
    };
    createdGalleryRows.push(row);
    galleryProfile.profileImages.push(row);
    return row;
  },
});
const firstGalleryRun = await migrateGallery();
const secondGalleryRun = await migrateGallery();
assert.equal(firstGalleryRun.summary.uploaded, 3);
assert.equal(firstGalleryRun.summary.rejected, 1);
assert.deepEqual(createdGalleryRows.map((row) => row.position), [0, 1, 2]);
assert.deepEqual(createdGalleryRows.map((row) => row.isPrimary), [true, false, false]);
assert.equal(firstGalleryRun.rows[0].primaryStoragePath, galleryCandidates[0].storagePath);
assert.equal(secondGalleryRun.summary.galleriesPreserved, 1);
assert.equal(createdGalleryRows.length, 3, 'rerunning a migrated gallery must not duplicate rows');

let adminIngestions = 0;
const adminPreserved = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'admin-managed',
    driveFolderId: '1234567890FOLDER',
    profileImages: [{ id: 'admin-image', storagePath: 'fall-2026/admin-managed/primary.jpg', position: 0, isPrimary: true }],
  }],
  ingestGallery: async () => { adminIngestions += 1; },
});
assert.equal(adminPreserved.rows[0].category, 'existing_relational_gallery');
assert.equal(adminIngestions, 0, 'Admin-managed relational galleries must remain authoritative');

assert.throws(
  () => parseImageMigrationArguments(['fall-2026', '--replace-existing']),
  /requires an explicit --profile/,
  'replacement must never be enabled dataset-wide',
);
const targetedDryRunOptions = parseImageMigrationArguments([
  'fall-2026', '--dry-run', '--replace-existing', '--profile', 'logan-ho',
]);
assert.equal(targetedDryRunOptions.dryRun, true);
assert.equal(targetedDryRunOptions.replaceExisting, true);
assert.equal(targetedDryRunOptions.profileId, 'logan-ho');

const replacementExisting = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    storagePath: 'fall-2026/repair/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
    position: 0,
    isPrimary: false,
    focalX: 18,
    focalY: 72,
    displayMode: 'portrait',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    storagePath: 'fall-2026/repair/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
    position: 1,
    isPrimary: true,
    focalX: 66,
    focalY: 24,
    displayMode: 'cover',
  },
];
const replacementNew = galleryCandidates.slice(0, 2).map((image) => ({
  ...image,
  storagePath: image.storagePath.replace('/gallery/', '/repair/'),
  width: 2400,
  height: 3600,
  byteLength: 800000,
  downloadSource: 'original_media',
}));
const preservedPlan = buildGalleryReplacementPlan(replacementExisting, replacementNew);
assert.equal(preservedPlan.metadataStrategy, 'preserve_by_position');
assert.deepEqual(
  preservedPlan.replacementRows.map((image) => ({
    isPrimary: image.isPrimary,
    focalX: image.focalX,
    focalY: image.focalY,
    displayMode: image.displayMode,
  })),
  [
    { isPrimary: false, focalX: 18, focalY: 72, displayMode: 'portrait' },
    { isPrimary: true, focalX: 66, focalY: 24, displayMode: 'cover' },
  ],
  'same-length deterministic replacements preserve primary/focal/display metadata by position',
);
const defaultPlan = buildGalleryReplacementPlan(replacementExisting, replacementNew.slice(0, 1));
assert.equal(defaultPlan.metadataStrategy, 'reset_to_defaults');
assert.deepEqual(
  defaultPlan.replacementRows.map((image) => ({
    isPrimary: image.isPrimary,
    focalX: image.focalX,
    focalY: image.focalY,
    displayMode: image.displayMode,
  })),
  [{ isPrimary: true, focalX: null, focalY: null, displayMode: 'cover' }],
  'unproven mappings use defaults and the first deterministic image as primary',
);

let dryRunReplacementCalls = 0;
const targetedReplacementDryRun = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'repair',
    driveFolderId: '1234567890FOLDER',
    profileImages: replacementExisting,
  }],
  dryRun: true,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 3,
    supportedImages: 2,
    allSupportedValidated: true,
    images: replacementNew,
    rejected: [{ name: 'raw.nef', category: 'unsupported_file_type', detail: 'Ignored.' }],
    diagnostics: [],
  }),
  replaceGallery: async () => { dryRunReplacementCalls += 1; },
  removeStorage: async () => assert.fail('dry-run must not remove Storage objects'),
});
assert.equal(targetedReplacementDryRun.rows[0].status, 'dry_run_replacement_validated');
assert.equal(targetedReplacementDryRun.rows[0].metadataStrategy, 'preserve_by_position');
assert.deepEqual(
  targetedReplacementDryRun.rows[0].imageDimensions.map(({ width, height }) => ({ width, height })),
  [{ width: 2400, height: 3600 }, { width: 2400, height: 3600 }],
);
assert.equal(dryRunReplacementCalls, 0, 'dry-run must not invoke the replacement RPC');

const replacementCleanup = [];
let failedReplacementCalls = 0;
const failedTargetedReplacement = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'repair',
    driveFolderId: '1234567890FOLDER',
    profileImages: replacementExisting,
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 2,
    supportedImages: 2,
    allSupportedValidated: true,
    images: replacementNew.slice(0, 1),
    rejected: [{ name: 'photo2.jpg', category: 'supabase_upload_failure', detail: 'Upload failed.' }],
    diagnostics: [],
  }),
  replaceGallery: async () => { failedReplacementCalls += 1; },
  removeStorage: async (storagePath) => replacementCleanup.push(storagePath),
});
assert.equal(failedTargetedReplacement.rows[0].status, 'replacement_failed_preserved');
assert.equal(failedTargetedReplacement.rows[0].primaryStoragePath, replacementExisting[1].storagePath);
assert.equal(failedReplacementCalls, 0, 'partial replacement must not touch existing metadata');
assert.deepEqual(replacementCleanup, [replacementNew[0].storagePath], 'partial new uploads must be cleaned up');

const failedMetadataCleanup = [];
const failedMetadataReplacement = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'repair',
    driveFolderId: '1234567890FOLDER',
    profileImages: replacementExisting,
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 2,
    supportedImages: 2,
    allSupportedValidated: true,
    images: replacementNew,
    rejected: [],
    diagnostics: [],
  }),
  replaceGallery: async () => { throw new Error('transaction rolled back'); },
  removeStorage: async (storagePath) => failedMetadataCleanup.push(storagePath),
});
assert.equal(failedMetadataReplacement.rows[0].status, 'replacement_failed_preserved');
assert.equal(failedMetadataReplacement.rows[0].category, 'metadata_replacement_failure');
assert.equal(failedMetadataReplacement.rows[0].primaryStoragePath, replacementExisting[1].storagePath);
assert.deepEqual(
  failedMetadataCleanup,
  replacementNew.map((image) => image.storagePath),
  'a failed atomic metadata swap must clean new objects while retaining the old gallery',
);

const successfulReplacementEvents = [];
const successfulTargetedReplacement = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'repair',
    driveFolderId: '1234567890FOLDER',
    profileImages: replacementExisting,
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 2,
    supportedImages: 2,
    allSupportedValidated: true,
    images: replacementNew,
    rejected: [],
    diagnostics: [],
  }),
  replaceGallery: async ({ plan }) => {
    successfulReplacementEvents.push('metadata');
    assert.deepEqual(plan.expectedExistingImageIds, replacementExisting.map((image) => image.id));
  },
  removeStorage: async (storagePath) => successfulReplacementEvents.push(`remove:${storagePath}`),
});
assert.equal(successfulTargetedReplacement.rows[0].status, 'replaced');
assert.equal(successfulTargetedReplacement.summary.replaced, 1);
assert.deepEqual(
  successfulReplacementEvents,
  ['metadata', ...replacementExisting.map((image) => `remove:${image.storagePath}`)],
  'old Storage objects must be removed only after transactional metadata replacement succeeds',
);

const metadataCleanup = [];
let metadataAttempts = 0;
let partialPrimary = false;
const partialMetadata = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{ id: 'partial', driveFileId: '1234567890ABCDE', profileImages: [] }],
  dryRun: false,
  ingestGallery: async () => ({
    sourceKind: 'file', filesDiscovered: 2, supportedImages: 2, rejected: [],
    images: galleryCandidates.slice(0, 2).map((image) => ({
      ...image,
      storagePath: image.storagePath.replace('/gallery/', '/partial/'),
    })),
  }),
  createImage: async ({ image, makePrimary }) => {
    metadataAttempts += 1;
    if (metadataAttempts === 1) throw new Error('database unavailable');
    partialPrimary = makePrimary;
    return { storagePath: image.storagePath, position: 0, isPrimary: makePrimary };
  },
  removeStorage: async (storagePath) => metadataCleanup.push(storagePath),
});
assert.equal(partialMetadata.summary.uploaded, 1);
assert.equal(partialMetadata.summary.rejected, 1);
assert.equal(partialMetadata.rows[0].status, 'uploaded_with_rejections');
assert.equal(partialMetadata.rows[0].rejected[0].category, 'metadata_insert_failure');
assert.equal(metadataCleanup.length, 1, 'a failed metadata insert must clean up its uploaded object');
assert.equal(partialPrimary, true, 'the first image whose metadata succeeds must become primary');

const missingGallery = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{ id: 'missing', imageKind: 'missing', profileImages: [] }],
  ingestGallery: async () => assert.fail('missing sources must not be ingested'),
});
assert.equal(missingGallery.rows[0].category, 'missing_source');

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
const replacementMigrationSql = await readFile(new URL('../supabase/migrations/202609020001_targeted_profile_gallery_replacement.sql', import.meta.url), 'utf8');
assert.match(replacementMigrationSql, /create or replace function public\.replace_profile_image_gallery/);
assert.match(replacementMigrationSql, /for update/);
assert.match(replacementMigrationSql, /existing_image_ids is distinct from expected_existing_image_ids/);
assert.match(replacementMigrationSql, /delete from public\.profile_images[\s\S]*insert into public\.profile_images/);
assert.match(replacementMigrationSql, /grant execute on function public\.replace_profile_image_gallery\(uuid, text, uuid\[\], jsonb\)[\s\S]*to service_role/);

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
assert.match(adminDatasetSource, /resolveProfileImageSourcesForImage\(image/, 'Admin image cards must resolve each relational row independently');
assert.match(adminDatasetSource, /src: resolved\.src[\s\S]*candidates: resolved\.candidates/);
const adminProfilePreviewSource = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');
assert.match(adminProfilePreviewSource, /editableImage[\s\S]*imageId: editableImage\?\.id/);
const profileDetailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
assert.match(profileDetailSource, /import ProfileGallery from ['"]\.\/ProfileGallery['"]/);
assert.match(profileDetailSource, /<ProfileGallery[\s\S]*images=\{profile\.profileImages\}/);
assert.match(profileDetailSource, /\{adminPreview && hasEditableImage\s*\n\s*\? <FocalPointEditor/, 'Admin previews must mount the focal editor only for relational images');
const profileGallerySource = await readFile(new URL('../components/ProfileGallery.js', import.meta.url), 'utf8');
assert.match(profileGallerySource, /isPrimary/);
assert.match(profileGallerySource, /ArrowLeft/);
assert.match(profileGallerySource, /scrollTo/);
assert.match(profileGallerySource, /slideRefs/);
assert.match(profileGallerySource, /offsetLeft/);
assert.match(profileGallerySource, /disabled=\{activeIndex === 0\}/);
assert.match(profileGallerySource, /disabled=\{activeIndex === relationalImages\.length - 1\}/);
assert.match(profileGallerySource, /targetIndex = Math\.max\(0, Math\.min\(index, relationalImages\.length - 1\)\)/);
assert.match(profileGallerySource, /setActiveIndex\(Math\.max\(0, Math\.min\(nextIndex/);
assert.match(profileGallerySource, /focalX=\{image\.focalX\}[\s\S]*focalY=\{image\.focalY\}[\s\S]*displayMode=\{image\.displayMode\}/);
assert.match(profileGallerySource, /aria-label="Previous image"/);
assert.match(profileGallerySource, /View image \$\{index \+ 1\} of/);
const profileGalleryStyles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
assert.match(profileGalleryStyles, /\.profile-gallery-viewport[\s\S]*scroll-snap-type: x mandatory/);
assert.match(profileGalleryStyles, /\.profile-gallery-viewport[\s\S]*touch-action: pan-x pan-y/);
assert.match(profileGalleryStyles, /\.profile-gallery-slide[\s\S]*flex: 0 0 100%[\s\S]*width: 100%[\s\S]*min-width: 100%[\s\S]*scroll-snap-align: start/);
assert.match(profileGalleryStyles, /prefers-reduced-motion: reduce/);
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
assert.match(migrationToolSource, /migrateDatasetProfileGalleries/);
assert.match(migrationToolSource, /from\('profile_images'\)/, 'migration must inspect relational galleries before touching Drive');
assert.match(migrationToolSource, /create_profile_image_metadata/, 'migration must use the existing transactional metadata RPC');
assert.match(migrationToolSource, /removeStorage: inspector\.remove/, 'metadata failures must use Storage cleanup');
assert.match(migrationToolSource, /--replace-existing requires an explicit --profile/);
assert.match(migrationToolSource, /replace_profile_image_gallery/);
assert.match(migrationToolSource, /image_dimensions/);

console.log('Profile image Storage paths, resolution, ingestion, migration, security, and preview tests passed.');
