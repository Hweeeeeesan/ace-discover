#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  MAX_PROFILE_IMAGE_BYTES,
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  ProfileImageIngestionError,
  classifyProfileImageSource,
  detectImageContentType,
  ingestProfileImages,
  normalizeImageOrientation,
  normalizeProfileImage,
  rotateImage,
  validatedImageFromResponse,
} from '../lib/profile-image-ingestion.js';
import {
  buildGalleryReplacementPlan,
  migrateDatasetProfileGalleries,
  migrateDatasetProfiles,
} from '../lib/profile-image-migration.js';
import {
  assertImageImportDataset,
  imageImportStatus,
  presentImageImportResult,
  profileNeedsImageImport,
} from '../lib/profile-image-batch.js';
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
  profileImagePresentationStyle,
  resolveProfileImageSources,
  resolveProfileImageSourcesForImage,
  withResolvedProfileImage,
} from '../lib/profile-images.js';
import { buildDiscoveryResults } from '../lib/discovery.js';
import { discoveryProfile } from '../lib/datasets/model.js';
import { resolveEffectivePublicProfile } from '../lib/profile-overrides.js';

const supabaseOptions = {
  supabaseUrl: 'https://ace-discover.supabase.co',
  bucket: 'profile-images',
};

function deterministicRaster(width, height, channels, { transparent = false } = {}) {
  const pixels = Buffer.allocUnsafe(width * height * channels);
  let state = 0x12345678;
  for (let index = 0; index < pixels.length; index += channels) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
    pixels[index + 1] = (state >>> 8) & 0xff;
    pixels[index + 2] = (state >>> 16) & 0xff;
    if (channels === 4) pixels[index + 3] = transparent && index % 44 === 0 ? 96 : 255;
  }
  return pixels;
}

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
assert.equal(normalizeFocalCoordinate('35.5'), 35.5, 'database numeric strings must normalize to percentages');
assert.equal(normalizeFocalCoordinate(0), 0, 'zero is a valid focal boundary');
assert.equal(normalizeFocalCoordinate('0'), 0, 'a database zero string must not fall back');
assert.equal(normalizeFocalCoordinate(0.5), 0.5, 'fractional percentages remain percentages, not 0..1 coordinates');
assert.equal(normalizeFocalCoordinate(1), 1, 'one means one percent in the canonical 0..100 contract');
assert.equal(normalizeFocalCoordinate(50), 50);
assert.equal(normalizeFocalCoordinate(100), 100);
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
assert.deepEqual(
  profileImagePresentationStyle({ focalX: '0', focalY: '100', displayMode: 'cover' }),
  { objectFit: 'cover', objectPosition: '0% 100%' },
  'cover crops must apply normalized focal percentages through object-position',
);
assert.deepEqual(
  profileImagePresentationStyle({ focalX: 50, focalY: 0.5, displayMode: 'portrait' }),
  { objectFit: 'contain', objectPosition: '50% 0.5%' },
  'portrait mode intentionally contains the full image while preserving focal metadata',
);
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
const intentionallyCleared = {
  imageClearedByAdmin: true,
  storageImagePath: springPath,
  image: driveImage,
  imageCandidates: [driveImage],
  focalX: 9,
  focalY: 91,
  displayMode: 'portrait',
  profileImages: [{
    id: imageId,
    storageImagePath: futurePath,
    position: 0,
    isPrimary: true,
    focalX: 9,
    focalY: 91,
    displayMode: 'portrait',
  }],
};
assert.deepEqual(
  resolveProfileImageSources(intentionallyCleared, supabaseOptions),
  { src: PROFILE_IMAGE_PLACEHOLDER, candidates: [PROFILE_IMAGE_PLACEHOLDER] },
  'an explicit Admin clear must suppress relational, Storage, and Drive fallbacks',
);
assert.deepEqual(getProfileImages(intentionallyCleared), []);
assert.equal(getPrimaryProfileImage(intentionallyCleared), null);
assert.deepEqual(
  withResolvedProfileImage(intentionallyCleared, supabaseOptions),
  {
    ...intentionallyCleared,
    profileImages: [],
    focalX: 50,
    focalY: 35,
    displayMode: 'cover',
    image: PROFILE_IMAGE_PLACEHOLDER,
    imageCandidates: [PROFILE_IMAGE_PLACEHOLDER],
  },
  'deleted-image focal and display metadata must not survive effective resolution',
);

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
const databaseStringCoordinates = structuredClone(relationalProfile);
databaseStringCoordinates.profileImages[0].focalX = '0';
databaseStringCoordinates.profileImages[0].focalY = '100';
assert.deepEqual(
  getPrimaryProfileImage(databaseStringCoordinates),
  {
    id: 'second',
    storageImagePath: `spring-2026/same-person/${imageId}.png`,
    position: 1,
    isPrimary: true,
    focalX: 0,
    focalY: 100,
    displayMode: 'portrait',
  },
  'relational image coordinates must normalize once without losing zero',
);
const changedSecondary = structuredClone(relationalProfile);
changedSecondary.profileImages[1].focalX = 4;
changedSecondary.profileImages[1].focalY = 96;
assert.equal(withResolvedProfileImage(changedSecondary, supabaseOptions).focalX, 50, 'secondary focal edits must not affect discovery metadata');
assert.equal(withResolvedProfileImage(changedSecondary, supabaseOptions).focalY, 35, 'discovery keeps using the relational primary until primary changes');
const changedPrimary = structuredClone(relationalProfile);
changedPrimary.profileImages[0].focalX = 61;
changedPrimary.profileImages[0].focalY = 22;
changedPrimary.profileImages[0].displayMode = 'cover';
const resolvedChangedPrimary = withResolvedProfileImage(changedPrimary, supabaseOptions);
assert.equal(resolvedChangedPrimary.focalX, 61);
assert.equal(resolvedChangedPrimary.focalY, 22);
assert.equal(resolvedChangedPrimary.displayMode, 'cover');
assert.match(resolvedChangedPrimary.image, new RegExp(`${imageId}\\.png$`), 'discovery must use the latest relational primary source');
const imageOverrideAttempt = resolveEffectivePublicProfile(relationalProfile, {
  focalX: 1,
  focalY: 2,
  displayMode: 'cover',
  storageImagePath: 'fall-2025/other/primary.jpg',
});
assert.equal(imageOverrideAttempt.focalX, undefined, 'public profile overrides cannot provide image metadata');
assert.equal(getPrimaryProfileImage(imageOverrideAttempt).id, 'second');
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

const initialFocalProfile = {
  id: 'focal-regression',
  name: 'Focal Regression',
  role: 'Little',
  major: 'Testing',
  year: 'First year',
  storageImagePath: springPath,
  focalX: 50,
  focalY: 35,
  displayMode: 'cover',
  profileImages: [{
    id: imageId,
    storageImagePath: futurePath,
    position: 0,
    isPrimary: true,
    focalX: 50,
    focalY: 35,
    displayMode: 'cover',
  }],
};
const initialResolvedFocal = withResolvedProfileImage(initialFocalProfile, supabaseOptions);
assert.deepEqual(
  { focalX: initialResolvedFocal.focalX, focalY: initialResolvedFocal.focalY },
  { focalX: 50, focalY: 35 },
);
const savedFocalProfile = structuredClone(initialFocalProfile);
savedFocalProfile.profileImages[0].focalX = 20;
savedFocalProfile.profileImages[0].focalY = 70;
const detailAfterSave = withResolvedProfileImage(savedFocalProfile, supabaseOptions);
assert.deepEqual(
  {
    src: detailAfterSave.image,
    focalX: detailAfterSave.focalX,
    focalY: detailAfterSave.focalY,
    displayMode: detailAfterSave.displayMode,
  },
  {
    src: `https://ace-discover.supabase.co/storage/v1/object/public/profile-images/${futurePath}`,
    focalX: 20,
    focalY: 70,
    displayMode: 'cover',
  },
  'ProfileDetail resolution must use saved relational primary metadata over stale profile-level values',
);

// Mirrors the bulk RPC -> discoveryProfile -> resolveProfileImages path in
// lib/datasets/public.js. The RPC projects the current primary row onto these
// top-level fields before the profile enters Discovery.
const activeDatasetRpcProfile = {
  ...discoveryProfile(initialFocalProfile),
  storageImagePath: futurePath,
  focalX: 20,
  focalY: 70,
  displayMode: 'cover',
};
delete activeDatasetRpcProfile.profileImages;
const discoveryDatasetProfile = withResolvedProfileImage(activeDatasetRpcProfile, supabaseOptions);
const discoveryCardProfile = buildDiscoveryResults([discoveryDatasetProfile], { seed: 1 })[0].profile;
assert.deepEqual(
  {
    src: discoveryCardProfile.image,
    focalX: discoveryCardProfile.focalX,
    focalY: discoveryCardProfile.focalY,
    displayMode: discoveryCardProfile.displayMode,
  },
  {
    src: detailAfterSave.image,
    focalX: 20,
    focalY: 70,
    displayMode: 'cover',
  },
  'Discovery dataset normalization and filtering must preserve the latest primary metadata for ProfileCard',
);
assert.deepEqual(
  profileImagePresentationStyle(discoveryCardProfile),
  { objectFit: 'cover', objectPosition: '20% 70%' },
  'ProfileImage must render the saved Discovery focal point through object-position',
);

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

const underLimitJpeg = await normalizeProfileImage(jpeg);
const underLimitPng = await normalizeProfileImage(png);
assert.deepEqual(underLimitJpeg.bytes, jpeg, 'under-limit upright JPEG input must remain byte-for-byte unchanged');
assert.deepEqual(underLimitPng.bytes, png, 'under-limit upright PNG input must remain byte-for-byte unchanged');
assert.deepEqual(underLimitJpeg.diagnostics, []);
assert.deepEqual(underLimitPng.diagnostics, []);

const noisyWidth = 1200;
const noisyHeight = 800;
const noisyRgb = deterministicRaster(noisyWidth, noisyHeight, 3);
const noisyRgba = deterministicRaster(noisyWidth, noisyHeight, 4, { transparent: true });
const noisyOpaquePng = await sharp(noisyRgb, {
  raw: { width: noisyWidth, height: noisyHeight, channels: 3 },
}).png({ compressionLevel: 0 }).toBuffer();
const noisyTransparentPng = await sharp(noisyRgba, {
  raw: { width: noisyWidth, height: noisyHeight, channels: 4 },
}).png({ compressionLevel: 0 }).toBuffer();
const noisyJpeg = await sharp(noisyRgb, {
  raw: { width: noisyWidth, height: noisyHeight, channels: 3 },
}).jpeg({ quality: 100 }).toBuffer();
const noisyWebp = await sharp(noisyRgb, {
  raw: { width: noisyWidth, height: noisyHeight, channels: 3 },
}).webp({ lossless: true }).toBuffer();

const compressedAt92 = {
  png: await sharp(noisyOpaquePng).autoOrient().webp({
    quality: 92, alphaQuality: 100, effort: 4, smartSubsample: true,
  }).toBuffer(),
  transparentPng: await sharp(noisyTransparentPng).autoOrient().webp({
    quality: 92, alphaQuality: 100, effort: 4, smartSubsample: true,
  }).toBuffer(),
  jpeg: await sharp(noisyJpeg).autoOrient().jpeg({
    quality: 92, chromaSubsampling: '4:2:0', mozjpeg: true, progressive: true,
  }).toBuffer(),
  webp: await sharp(noisyWebp).autoOrient().webp({
    quality: 92, alphaQuality: 100, effort: 4, smartSubsample: true,
  }).toBuffer(),
};

async function normalizeWithoutResize(input, firstAttemptBytes) {
  assert.ok(input.length > firstAttemptBytes.length + 64, 'the fixture must begin above its simulated final limit');
  return normalizeProfileImage(input, {
    finalByteLimit: firstAttemptBytes.length + 64,
    inputByteLimit: input.length + 1024,
    qualityStages: [92],
    resizeScales: [],
    minLongEdge: 1,
  });
}

const oversizedOpaquePng = await normalizeWithoutResize(noisyOpaquePng, compressedAt92.png);
assert.equal(oversizedOpaquePng.contentType, 'image/webp');
assert.equal(oversizedOpaquePng.resized, false, 'compression sufficient at full dimensions must not resize');
assert.deepEqual(
  { width: oversizedOpaquePng.width, height: oversizedOpaquePng.height },
  { width: noisyWidth, height: noisyHeight },
);
assert.ok(oversizedOpaquePng.diagnostics.some((entry) => entry.category === 'oversized_png_converted_to_webp'));
assert.ok(oversizedOpaquePng.diagnostics.some((entry) => entry.category === 'oversized_image_normalized'));

const oversizedTransparentPng = await normalizeWithoutResize(
  noisyTransparentPng,
  compressedAt92.transparentPng,
);
assert.equal(oversizedTransparentPng.contentType, 'image/webp');
const transparentOutput = sharp(oversizedTransparentPng.bytes);
const transparentMetadata = await transparentOutput.metadata();
const transparentStats = await transparentOutput.ensureAlpha().stats();
assert.equal(transparentMetadata.hasAlpha, true, 'transparent oversized PNG output must retain an alpha channel');
assert.ok(transparentStats.channels.at(-1).min < 255, 'transparent pixels must survive normalization');
assert.match(
  oversizedTransparentPng.diagnostics.find((entry) => entry.category === 'oversized_png_converted_to_webp').detail,
  /preserving transparency/,
);

const oversizedJpeg = await normalizeWithoutResize(noisyJpeg, compressedAt92.jpeg);
assert.equal(oversizedJpeg.contentType, 'image/jpeg', 'oversized JPEG input must remain JPEG');
assert.equal(oversizedJpeg.resized, false);
const oversizedWebp = await normalizeWithoutResize(noisyWebp, compressedAt92.webp);
assert.equal(oversizedWebp.contentType, 'image/webp', 'oversized WebP input must remain WebP');
assert.equal(oversizedWebp.resized, false);

const halfSizeWebp = await sharp(noisyOpaquePng)
  .autoOrient()
  .resize({ width: noisyWidth / 2, height: noisyHeight / 2, fit: 'inside', kernel: sharp.kernel.lanczos3 })
  .webp({ quality: 92, alphaQuality: 100, effort: 4, smartSubsample: true })
  .toBuffer();
const resizeOnlyLimit = Math.floor((compressedAt92.png.length + halfSizeWebp.length) / 2);
const resizeRequired = await normalizeProfileImage(noisyOpaquePng, {
  finalByteLimit: resizeOnlyLimit,
  inputByteLimit: noisyOpaquePng.length + 1024,
  qualityStages: [92],
  resizeScales: [0.5],
  minLongEdge: 1,
});
assert.equal(resizeRequired.resized, true, 'dimensions must change only after the full-size encoding misses the limit');
assert.ok(resizeRequired.bytes.length <= resizeOnlyLimit);
assert.ok(resizeRequired.width < noisyWidth && resizeRequired.height < noisyHeight);
assert.ok(
  Math.abs((resizeRequired.width / resizeRequired.height) - (noisyWidth / noisyHeight)) < 0.01,
  'high-quality resizing must preserve aspect ratio',
);
assert.ok(resizeRequired.diagnostics.some((entry) => entry.category === 'oversized_image_resized'));

await assert.rejects(
  normalizeProfileImage(noisyOpaquePng, {
    finalByteLimit: 100,
    inputByteLimit: noisyOpaquePng.length + 1024,
    qualityStages: [92],
    resizeScales: [],
    minLongEdge: 1,
  }),
  (error) => error instanceof ProfileImageIngestionError
    && error.code === 'image_too_large_after_normalization'
    && error.details.originalBytes === noisyOpaquePng.length
    && error.details.finalBytes > 100,
  'an image that cannot meet the final limit must fail with an explicit post-normalization category',
);
await assert.rejects(
  normalizeProfileImage(noisyOpaquePng, {
    inputByteLimit: noisyOpaquePng.length + 1024,
    maxInputPixels: 100,
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'image_dimensions_too_large',
  'decode pixel limits must guard against decompression bombs',
);

const andrewWidth = 2050;
const andrewHeight = 2050;
const andrewOpaqueRgba = deterministicRaster(andrewWidth, andrewHeight, 4);
const andrewOversizedPng = await sharp(andrewOpaqueRgba, {
  raw: { width: andrewWidth, height: andrewHeight, channels: 4 },
}).png({ compressionLevel: 0 }).toBuffer();
assert.ok(andrewOversizedPng.length > MAX_PROFILE_IMAGE_BYTES, 'Andrew-like PNG fixture must exceed the real 15 MiB final limit');
assert.ok(andrewOversizedPng.length < MAX_PROFILE_IMAGE_INPUT_BYTES);
const andrewNormalized = await normalizeProfileImage(andrewOversizedPng);
assert.equal(andrewNormalized.contentType, 'image/webp');
assert.ok(andrewNormalized.bytes.length <= MAX_PROFILE_IMAGE_BYTES, 'production normalization must enforce the real 15 MiB final limit');
assert.deepEqual(
  { width: andrewNormalized.width, height: andrewNormalized.height },
  { width: andrewWidth, height: andrewHeight },
  'an Andrew-like oversized PNG must retain dimensions when compression alone succeeds',
);

await assert.rejects(
  validatedImageFromResponse(new Response('not an image', { headers: { 'Content-Type': 'image/jpeg' } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_file_type',
);
await assert.rejects(
  validatedImageFromResponse(new Response(jpeg, { headers: { 'Content-Length': String(MAX_PROFILE_IMAGE_INPUT_BYTES + 1) } })),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'image_input_too_large',
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

const andrewFiles = [
  { id: '1234567890ANDREW4', name: 'Photo4.png', mimeType: 'image/png', size: andrewOversizedPng.length },
  { id: '1234567890ANDREW1', name: 'Photo1.png', mimeType: 'image/png', size: andrewOversizedPng.length },
  { id: '1234567890ANDREWJ', name: '000003790016.jpg', mimeType: 'image/jpeg', size: noisyJpeg.length },
  { id: '1234567890ANDREW3', name: 'Photo3.png', mimeType: 'image/png', size: andrewOversizedPng.length },
];
const andrewImageIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
];
const andrewReplacement = await ingestProfileImages({
  profile: { id: 'andrew-cam', driveFolderId: '1234567890FOLDER', imageKind: 'drive-folder' },
  datasetSlug: 'fall-2026',
  driveAuth: {},
  dryRun: true,
  requireAllSupported: true,
  createImageId: () => andrewImageIds.shift(),
  driveClient: {
    listFilesInFolder: async () => andrewFiles,
    fetchDriveImage: async (fileId) => new Response(
      fileId.endsWith('ANDREWJ') ? noisyJpeg : andrewOversizedPng,
      { headers: { 'Content-Type': fileId.endsWith('ANDREWJ') ? 'image/jpeg' : 'image/png' } },
    ),
  },
});
assert.equal(andrewReplacement.allSupportedValidated, true, 'Andrew-like mixed replacement set must validate completely');
assert.equal(andrewReplacement.rejected.length, 0);
assert.deepEqual(
  andrewReplacement.images.map((image) => image.name),
  ['000003790016.jpg', 'Photo1.png', 'Photo3.png', 'Photo4.png'],
  'normalization must not change natural Drive ordering',
);
assert.deepEqual(
  andrewReplacement.images.map((image) => image.contentType),
  ['image/jpeg', 'image/webp', 'image/webp', 'image/webp'],
  'the under-limit JPEG stays JPEG while the three oversized opaque PNGs become WebP',
);
assert.ok(andrewReplacement.images.every((image) => image.byteLength <= MAX_PROFILE_IMAGE_BYTES));
assert.equal(
  andrewReplacement.diagnostics.filter((entry) => entry.category === 'oversized_image_normalized').length,
  3,
);
assert.ok(
  andrewReplacement.diagnostics
    .filter((entry) => entry.category === 'oversized_image_normalized')
    .every((entry) => entry.originalBytes > MAX_PROFILE_IMAGE_BYTES
      && entry.finalBytes <= MAX_PROFILE_IMAGE_BYTES
      && entry.finalMime === 'image/webp'),
  'normalization diagnostics must include original/final sizes, dimensions, and MIME',
);

const andrewExisting = [
  ...replacementExisting,
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    storagePath: 'fall-2026/andrew-cam/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png',
    position: 2,
    isPrimary: false,
    focalX: 0,
    focalY: 100,
    displayMode: 'cover',
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    storagePath: 'fall-2026/andrew-cam/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png',
    position: 3,
    isPrimary: false,
    focalX: 31,
    focalY: 59,
    displayMode: 'portrait',
  },
].map((image, position) => ({
  ...image,
  storagePath: image.storagePath.replace('/repair/', '/andrew-cam/'),
  position,
}));
const andrewReplacementPreview = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'andrew-cam',
    driveFolderId: '1234567890FOLDER',
    profileImages: andrewExisting,
  }],
  dryRun: true,
  replaceExisting: true,
  ingestGallery: async () => andrewReplacement,
});
assert.equal(andrewReplacementPreview.rows[0].status, 'dry_run_replacement_validated');
assert.equal(andrewReplacementPreview.rows[0].metadataStrategy, 'preserve_by_position');
const andrewMetadataPlan = buildGalleryReplacementPlan(andrewExisting, andrewReplacement.images);
assert.deepEqual(
  andrewMetadataPlan.replacementRows.map(({ isPrimary, focalX, focalY, displayMode }) => ({
    isPrimary, focalX, focalY, displayMode,
  })),
  andrewExisting.map(({ isPrimary, focalX, focalY, displayMode }) => ({
    isPrimary, focalX, focalY, displayMode,
  })),
  're-encoding and resizing must not alter focal, display, primary, or positional metadata',
);

let irreducibleReplacementUploads = 0;
const irreducibleReplacement = await ingestProfileImages({
  profile: { id: 'andrew-cam', driveFolderId: '1234567890FOLDER', imageKind: 'drive-folder' },
  datasetSlug: 'fall-2026',
  driveAuth: {},
  dryRun: false,
  requireAllSupported: true,
  normalizationOptions: {
    finalByteLimit: 300,
    inputByteLimit: noisyOpaquePng.length + 1024,
    qualityStages: [92],
    resizeScales: [],
    minLongEdge: 1,
  },
  upload: async () => { irreducibleReplacementUploads += 1; },
  driveClient: {
    listFilesInFolder: async () => [
      { id: '1234567890SMALL', name: 'one.jpg', mimeType: 'image/jpeg', size: jpeg.length },
      { id: '1234567890LARGE', name: 'two.png', mimeType: 'image/png', size: noisyOpaquePng.length },
    ],
    fetchDriveImage: async (fileId) => new Response(fileId.endsWith('SMALL') ? jpeg : noisyOpaquePng),
  },
});
assert.equal(irreducibleReplacement.allSupportedValidated, false);
assert.equal(irreducibleReplacementUploads, 0, 'one irreducible image must prevent every staged replacement upload');
assert.equal(irreducibleReplacement.rejected[0]?.category, 'image_too_large_after_normalization');
const irreducibleMigration = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'andrew-cam',
    driveFolderId: '1234567890FOLDER',
    profileImages: andrewExisting,
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => irreducibleReplacement,
  replaceGallery: async () => assert.fail('incomplete normalized replacement must not mutate metadata'),
  removeStorage: async () => assert.fail('validation failure occurs before any staged object exists'),
});
assert.equal(irreducibleMigration.rows[0].status, 'replacement_failed_preserved');
assert.equal(irreducibleMigration.rows[0].primaryStoragePath, andrewExisting[1].storagePath);

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

let clearedRestorePlan = null;
const explicitlyRestoredClearedProfile = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'moderated-profile',
    driveFolderId: '1234567890FOLDER',
    imageClearedByAdmin: true,
    profileImages: [],
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 1,
    supportedImages: 1,
    allSupportedValidated: true,
    images: replacementNew.slice(0, 1),
    rejected: [],
    diagnostics: [],
  }),
  replaceGallery: async ({ plan }) => { clearedRestorePlan = plan; },
});
assert.equal(explicitlyRestoredClearedProfile.rows[0].status, 'replaced');
assert.deepEqual(clearedRestorePlan.expectedExistingImageIds, []);
assert.equal(clearedRestorePlan.replacementRows[0].isPrimary, true);

const failedClearedRestorationCleanup = [];
const failedClearedRestoration = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'moderated-profile',
    driveFolderId: '1234567890FOLDER',
    imageClearedByAdmin: true,
    profileImages: [],
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 1,
    supportedImages: 1,
    allSupportedValidated: true,
    images: replacementNew.slice(0, 1),
    rejected: [],
    diagnostics: [],
  }),
  replaceGallery: async () => { throw new Error('transaction rolled back'); },
  removeStorage: async (storagePath) => failedClearedRestorationCleanup.push(storagePath),
});
assert.equal(failedClearedRestoration.rows[0].status, 'replacement_failed_preserved');
assert.equal(failedClearedRestoration.rows[0].primaryStoragePath, '');
assert.deepEqual(failedClearedRestorationCleanup, [replacementNew[0].storagePath]);

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

const batchDataset = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'fall-2026',
  name: 'Fall 2026',
  status: 'ready',
};
const eligibleBatchProfile = {
  id: 'hazel-tran',
  name: 'Hazel Tran',
  driveFolderId: '1234567890FOLDER',
  profileImages: [],
};
assert.equal(profileNeedsImageImport(eligibleBatchProfile), true, 'Drive source plus no gallery must be eligible');
assert.equal(profileNeedsImageImport({ ...eligibleBatchProfile, profileImages: [{ id: imageId }] }), false, 'any relational gallery must be preserved');
assert.equal(profileNeedsImageImport({ id: 'no-source', profileImages: [] }), false, 'profiles without Drive sources must be ignored');
assert.equal(profileNeedsImageImport({ ...eligibleBatchProfile, storageImagePath: 'fall-2026/hazel-tran/primary.jpg' }), false, 'legacy/Admin image state must not be appended to');
const intentionallyClearedBatchProfile = {
  ...eligibleBatchProfile,
  id: 'moderated-profile',
  imageClearedByAdmin: true,
};
assert.equal(
  profileNeedsImageImport(intentionallyClearedBatchProfile),
  false,
  'automatic missing-image import must not repopulate an intentionally cleared profile',
);
assert.deepEqual(imageImportStatus(batchDataset, [
  eligibleBatchProfile,
  { ...eligibleBatchProfile, id: 'has-gallery', profileImages: [{ id: imageId }] },
  { id: 'no-source', profileImages: [] },
  intentionallyClearedBatchProfile,
]), {
  dataset: { id: batchDataset.id, name: 'Fall 2026', slug: 'fall-2026' },
  profilesScanned: 4,
  profilesNeedingImport: 1,
  profilesSkippedIntentionallyCleared: 1,
  profilesSkippedExistingGallery: 1,
});

let intentionallyClearedAutomaticIngestions = 0;
const intentionallyClearedAutomaticImport = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [intentionallyClearedBatchProfile],
  dryRun: false,
  ingestGallery: async () => { intentionallyClearedAutomaticIngestions += 1; },
});
assert.equal(intentionallyClearedAutomaticIngestions, 0);
assert.equal(intentionallyClearedAutomaticImport.summary.intentionallyCleared, 1);
assert.equal(intentionallyClearedAutomaticImport.rows[0].category, 'intentionally_cleared');
assert.throws(
  () => assertImageImportDataset({ ...batchDataset, status: 'archived' }),
  /Archived datasets must be restored/,
  'Admin batch import must reject archived datasets',
);

let previewMutationCalls = 0;
const batchPreviewMigration = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [eligibleBatchProfile],
  dryRun: true,
  ingestGallery: async () => ({
    sourceKind: 'folder',
    filesDiscovered: 2,
    supportedImages: 1,
    images: [{
      ...galleryCandidates[0],
      resolvedDriveFileId: 'PRIVATE_DRIVE_FILE_ID',
      storagePath: 'fall-2026/hazel-tran/11111111-1111-4111-8111-111111111111.jpg',
      width: 1081,
      height: 1497,
      byteLength: 400000,
    }],
    rejected: [{ driveFileId: 'PRIVATE_UNSUPPORTED_ID', name: 'notes.pdf', category: 'unsupported_file_type' }],
    diagnostics: [],
  }),
  createGallery: async () => { previewMutationCalls += 1; },
  recheckGallery: async () => { previewMutationCalls += 1; },
  removeStorage: async () => { previewMutationCalls += 1; },
});
assert.equal(previewMutationCalls, 0, 'preview must perform zero DB or Storage mutations');
const batchPreview = presentImageImportResult(batchDataset, batchPreviewMigration, { dryRun: true });
assert.equal(batchPreview.summary.readyProfiles, 1);
assert.equal(batchPreview.summary.validImagesDiscovered, 1);
assert.equal(batchPreview.summary.rejectedFiles, 1);
assert.deepEqual(batchPreview.profiles[0].dimensions, [{ width: 1081, height: 1497 }]);
assert.doesNotMatch(JSON.stringify(batchPreview), /PRIVATE_DRIVE_FILE_ID|PRIVATE_UNSUPPORTED_ID|storagePath|resolvedDriveFileId/, 'Admin preview must not expose Drive IDs or Storage paths');

const atomicGalleryCalls = [];
const atomicApply = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [eligibleBatchProfile],
  dryRun: false,
  recheckGallery: async () => false,
  ingestGallery: async () => ({
    sourceKind: 'folder', filesDiscovered: 3, supportedImages: 2, rejected: [], diagnostics: [],
    images: galleryCandidates.slice(0, 2).map((image, index) => ({
      ...image,
      storagePath: image.storagePath.replace('/gallery/', '/hazel-tran/'),
      width: 1000 + index,
      height: 1500 + index,
    })),
  }),
  createGallery: async ({ profile, images }) => {
    atomicGalleryCalls.push({ profile: profile.id, paths: images.map((image) => image.storagePath) });
    return { created: true, imageCount: images.length };
  },
  createImage: async () => assert.fail('Admin apply must use atomic gallery creation, not append rows'),
});
assert.equal(atomicApply.summary.uploaded, 2);
assert.equal(atomicApply.rows[0].status, 'uploaded');
assert.deepEqual(atomicGalleryCalls[0].paths, galleryCandidates.slice(0, 2).map((image) => image.storagePath.replace('/gallery/', '/hazel-tran/')), 'natural ingestion order must reach the atomic gallery write unchanged');

let concurrentIngestions = 0;
const concurrentPrecheck = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [eligibleBatchProfile],
  dryRun: false,
  recheckGallery: async () => true,
  ingestGallery: async () => { concurrentIngestions += 1; },
  createGallery: async () => assert.fail('a gallery found during recheck must not be mutated'),
});
assert.equal(concurrentPrecheck.rows[0].category, 'existing_relational_gallery_after_preview');
assert.equal(concurrentIngestions, 0);

const concurrentCleanup = [];
const concurrentAfterUpload = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [eligibleBatchProfile],
  dryRun: false,
  recheckGallery: async () => false,
  ingestGallery: async () => ({
    sourceKind: 'file', filesDiscovered: 1, supportedImages: 1, rejected: [], diagnostics: [],
    images: [{ ...galleryCandidates[0], storagePath: galleryCandidates[0].storagePath.replace('/gallery/', '/hazel-tran/') }],
  }),
  createGallery: async () => ({ created: false, reason: 'gallery_exists' }),
  removeStorage: async (storagePath) => concurrentCleanup.push(storagePath),
});
assert.equal(concurrentAfterUpload.rows[0].status, 'gallery_preserved');
assert.deepEqual(concurrentCleanup, [galleryCandidates[0].storagePath.replace('/gallery/', '/hazel-tran/')], 'a concurrent winner must cause all staged objects to be cleaned up');

const continuationRun = await migrateDatasetProfileGalleries({
  dataset: batchDataset,
  profiles: [
    { id: 'inaccessible', name: 'Inaccessible', driveFolderId: '1234567890FOLDER', profileImages: [] },
    { id: 'healthy', name: 'Healthy', driveFileId: '1234567890ABCDE', profileImages: [] },
  ],
  dryRun: true,
  ingestGallery: async (profile) => {
    if (profile.id === 'inaccessible') throw new ProfileImageIngestionError('folder_inaccessible', 'Drive denied access.');
    return {
      sourceKind: 'file', filesDiscovered: 1, supportedImages: 1, rejected: [], diagnostics: [],
      images: [{ ...galleryCandidates[0], width: 800, height: 1200 }],
    };
  },
});
const continuationPreview = presentImageImportResult(batchDataset, continuationRun, { dryRun: true });
assert.equal(continuationPreview.summary.failedProfiles, 1);
assert.equal(continuationPreview.summary.inaccessibleSources, 1);
assert.equal(continuationPreview.summary.readyProfiles, 1, 'one inaccessible profile must not stop healthy profiles');

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
const allowLastImageRemovalSql = await readFile(new URL('../supabase/migrations/202609160001_allow_last_profile_image_removal.sql', import.meta.url), 'utf8');
assert.match(allowLastImageRemovalSql, /create or replace function public\.delete_profile_image/);
assert.doesNotMatch(allowLastImageRemovalSql, /only profile image cannot be removed/i, 'the replacement RPC must allow deleting the sole image');
assert.match(allowLastImageRemovalSql, /delete from public\.profile_images where id = requested_image_id/);
assert.match(allowLastImageRemovalSql, /set storage_image_path = null,[\s\S]*public_data = coalesce\(public_data, '\{\}'::jsonb\) - 'storageImagePath'/, 'deleting the last image must clear stale compatibility metadata');
assert.match(allowLastImageRemovalSql, /set storage_image_path = next_primary\.storage_path,[\s\S]*\{storageImagePath\}/, 'deleting a primary from a multi-image gallery must synchronize the replacement primary');
assert.match(allowLastImageRemovalSql, /'remainingCount'/);
assert.match(allowLastImageRemovalSql, /revoke all on function public\.delete_profile_image\(uuid, text, uuid\) from public, anon, authenticated/);
assert.match(allowLastImageRemovalSql, /grant execute on function public\.delete_profile_image\(uuid, text, uuid\) to service_role/);
const intentionalImageClearSql = await readFile(new URL('../supabase/migrations/202609160002_intentional_profile_image_clear.sql', import.meta.url), 'utf8');
assert.match(intentionalImageClearSql, /add column if not exists image_cleared_by_admin boolean not null default false/);
assert.match(intentionalImageClearSql, /if remaining_count = 0 then[\s\S]*image_cleared_by_admin = true/, 'only deletion of the final relational row should persist an intentional clear');
assert.match(intentionalImageClearSql, /elsif target\.is_primary then[\s\S]*image_cleared_by_admin = false/, 'removing one image from a larger gallery must retain a valid primary without clearing the profile');
assert.match(intentionalImageClearSql, /public_data = coalesce\(public_data, '\{\}'::jsonb\) - array\[[\s\S]*'storageImagePath'[\s\S]*'imageCandidates'[\s\S]*'focalX'[\s\S]*'displayMode'/, 'final deletion must remove stale compatibility image and presentation metadata');
assert.match(intentionalImageClearSql, /if new\.image_cleared_by_admin then[\s\S]*new\.storage_image_path := null[\s\S]*- 'storageImagePath'/, 'normal source sync must not resurrect a compatibility image path');
assert.match(intentionalImageClearSql, /after insert on public\.profile_images[\s\S]*clear_intentional_profile_image_state_on_insert/, 'a successful explicit relational insert must clear intentional state transactionally');
assert.match(intentionalImageClearSql, /if intentionally_cleared then[\s\S]*'reason', 'intentionally_cleared'/, 'the atomic automatic batch RPC must refuse intentionally cleared profiles');
assert.match(intentionalImageClearSql, /cardinality\(existing_image_ids\) = 0 and not was_intentionally_cleared/, 'explicit targeted replacement must accept an empty intentionally cleared gallery only');
assert.match(intentionalImageClearSql, /strip_public_profile_image_data[\s\S]*'storageImagePath'[\s\S]*'profileImages'[\s\S]*'image'[\s\S]*'imageCandidates'/, 'public payloads must remove every compatibility fallback when intentionally cleared');
assert.match(intentionalImageClearSql, /if intentionally_cleared then[\s\S]*gallery := '\[\]'::jsonb/, 'ProfileDetail must receive an empty gallery for intentional clears');
assert.match(intentionalImageClearSql, /dp\.image_cleared_by_admin,[\s\S]*false/, 'Discovery must resolve through the intentional-clear guard');
assert.match(intentionalImageClearSql, /dp\.image_cleared_by_admin,[\s\S]*true/, 'ProfileDetail must resolve through the intentional-clear guard');
assert.match(intentionalImageClearSql, /resolve_effective_public_data\(imported_public_data, public_overrides\)[\s\S]*- array\['imageClearedByAdmin', 'image_cleared_by_admin'\]/, 'internal clear metadata must be stripped even if source or override data contains a similarly named key');
assert.doesNotMatch(intentionalImageClearSql, /jsonb_build_object\([^;]*imageClearedByAdmin/s, 'internal moderation state must not be returned in public payloads');
const datasetSyncSql = await readFile(new URL('../supabase/migrations/202609040001_google_sheet_sync.sql', import.meta.url), 'utf8');
const syncConflictUpdate = datasetSyncSql.slice(
  datasetSyncSql.indexOf('on conflict (dataset_id, profile_id) do update set'),
  datasetSyncSql.indexOf('select count(*) into stored_count'),
);
assert.doesNotMatch(syncConflictUpdate, /image_cleared_by_admin/, 'Sheet/Excel sync must preserve the independent intentional-clear state');
const replacementMigrationSql = await readFile(new URL('../supabase/migrations/202609020001_targeted_profile_gallery_replacement.sql', import.meta.url), 'utf8');
assert.match(replacementMigrationSql, /create or replace function public\.replace_profile_image_gallery/);
assert.match(replacementMigrationSql, /for update/);
assert.match(replacementMigrationSql, /existing_image_ids is distinct from expected_existing_image_ids/);
assert.match(replacementMigrationSql, /delete from public\.profile_images[\s\S]*insert into public\.profile_images/);
assert.match(replacementMigrationSql, /grant execute on function public\.replace_profile_image_gallery\(uuid, text, uuid\[\], jsonb\)[\s\S]*to service_role/);
const missingImageBatchSql = await readFile(new URL('../supabase/migrations/202609090001_missing_profile_image_batch.sql', import.meta.url), 'utf8');
assert.match(missingImageBatchSql, /create or replace function public\.create_profile_image_gallery_if_empty/);
assert.match(missingImageBatchSql, /for update of dp/, 'concurrent gallery creation must serialize on the dataset profile');
assert.match(missingImageBatchSql, /existing_storage_path is not null or exists[\s\S]*from public\.profile_images/, 'any existing gallery must make atomic creation a no-op');
assert.match(missingImageBatchSql, /image\.position = 0[\s\S]*update public\.dataset_profiles[\s\S]*set storage_image_path = primary_storage_path/, 'the first ordered image must become relational and compatibility primary');
assert.match(missingImageBatchSql, /revoke all on function public\.create_profile_image_gallery_if_empty[\s\S]*from public, anon, authenticated/);
assert.match(missingImageBatchSql, /grant execute on function public\.create_profile_image_gallery_if_empty\(uuid, text, jsonb\)[\s\S]*to service_role/);
const publicPrimaryMetadataSql = await readFile(new URL('../supabase/migrations/202609100002_public_primary_image_metadata.sql', import.meta.url), 'utf8');
assert.match(publicPrimaryMetadataSql, /resolve_effective_public_data\(dp\.public_data, dp\.public_overrides\)[\s\S]*\{storageImagePath\}[\s\S]*primary_image\.storage_path/);
assert.match(publicPrimaryMetadataSql, /\{focalX\}[\s\S]*primary_image\.focal_x[\s\S]*\{focalY\}[\s\S]*primary_image\.focal_y/);
assert.match(publicPrimaryMetadataSql, /\{displayMode\}[\s\S]*primary_image\.display_mode/);
assert.match(publicPrimaryMetadataSql, /from public\.profile_images pi[\s\S]*and pi\.is_primary/, 'discovery must read presentation metadata only from the primary row');
assert.match(publicPrimaryMetadataSql, /'profileImages'[\s\S]*order by pi\.position, pi\.id/, 'detail payloads retain the ordered relational gallery');

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
const publicDatasetSource = await readFile(new URL('../lib/datasets/public.js', import.meta.url), 'utf8');
assert.match(publicDatasetSource, /resolveProfileImages\(payload\.profiles\.map\(discoveryProfile\)\)/,
  'the bulk RPC profiles must use the shared primary-image resolver');
assert.doesNotMatch(publicDatasetSource, /unstable_cache|force-cache|cacheTag|cacheLife/,
  'Discovery dataset reads must not retain a separate stale data cache');
const discoveryFeedSource = await readFile(new URL('../components/DiscoveryFeed.js', import.meta.url), 'utf8');
assert.match(discoveryFeedSource, /router\.refresh\(\)/,
  'a restored or refocused Discovery client must request the revalidated root payload');
assert.match(discoveryFeedSource, /navigation\?\.at[\s\S]*refreshDiscoveryData\(\)/,
  'returning from ProfileDetail must refresh stale Router Cache props');
assert.match(discoveryFeedSource, /event\.persisted[\s\S]*refreshDiscoveryData\(\)/,
  'BFCache restoration must refresh Discovery metadata');
assert.match(discoveryFeedSource, /visibilitychange[\s\S]*handleVisibilityChange/,
  'a backgrounded Discovery tab must refresh when it becomes visible');
const adminDatasetSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
assert.match(adminDatasetSource, /from\('profile_images'\)/, 'READY/Admin detail preview must load relational image metadata');
assert.match(adminDatasetSource, /focalX: image\.focal_x[\s\S]*focalY: image\.focal_y/);
assert.match(adminDatasetSource, /displayMode: image\.display_mode/);
assert.match(adminDatasetSource, /resolveProfileImage\(\{ \.\.\.effectivePublicData, profileImages \}\)/, 'READY/Admin detail preview must apply overrides before shared image resolution');
assert.match(adminDatasetSource, /image_cleared_by_admin/);
assert.match(adminDatasetSource, /imageClearedByAdmin/);
assert.doesNotMatch(adminDatasetSource, /Object\.assign\(resolvedProfile, effectivePublicData\)/, 'effective-profile overrides must not overwrite resolved image metadata');
assert.match(adminDatasetSource, /updateAdminProfileImageFocal[\s\S]*\.eq\('dataset_id', datasetId\)[\s\S]*\.eq\('profile_id', profileId\)/);
assert.match(adminDatasetSource, /if \(imageError\)[\s\S]*\.select\('id,storage_path,position,is_primary,focal_x,focal_y'\)/, 'Admin preview should remain compatible before display_mode is applied');
assert.match(adminDatasetSource, /if \(fallback\.error\)[\s\S]*\.select\('id,storage_path,position,is_primary'\)/, 'Admin preview must retain image IDs when focal columns are not deployed yet');
const adminProfilePreviewSource = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');
assert.doesNotMatch(adminProfilePreviewSource, /editableImage|imageId:/, 'the top Admin preview must not select an editable image');
const profileDetailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
assert.match(profileDetailSource, /import ProfileGallery from ['"]\.\/ProfileGallery['"]/);
assert.match(profileDetailSource, /<ProfileGallery[\s\S]*images=\{profile\.profileImages\}/);
assert.equal((profileDetailSource.match(/<ProfileGallery/g) || []).length, 1, 'Admin and public detail must share one gallery rendering path');
assert.doesNotMatch(profileDetailSource, /FocalPointEditor|focal-editor|hasEditableImage/, 'the top profile preview must be read-only');
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
assert.doesNotMatch(profileGallerySource, /fetch\(|FocalPointEditor|focal-editor|onPointerDown/, 'gallery navigation must never edit or persist focal metadata');
const profileGalleryStyles = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
assert.match(profileGalleryStyles, /\.profile-gallery-viewport[\s\S]*scroll-snap-type: x mandatory/);
assert.match(profileGalleryStyles, /\.profile-gallery-viewport[\s\S]*touch-action: pan-x pan-y/);
assert.match(profileGalleryStyles, /\.profile-gallery-slide[\s\S]*flex: 0 0 100%[\s\S]*width: 100%[\s\S]*min-width: 100%[\s\S]*scroll-snap-align: start/);
assert.match(profileGalleryStyles, /prefers-reduced-motion: reduce/);
const profileImageSource = browserGraphSources[0];
assert.match(profileImageSource, /profileImagePresentationStyle\(\{ focalX, focalY, displayMode \}\)/, 'all image surfaces must share canonical crop styling');
const focalEditorSource = await readFile(new URL('../components/FocalPointEditor.js', import.meta.url), 'utf8');
assert.match(focalEditorSource, /role="slider"/);
assert.match(focalEditorSource, /api\/admin\/datasets\/focal/);
assert.match(focalEditorSource, /normalizeFocalCoordinate\(focalX, DEFAULT_FOCAL_X\)/, 'editor props must normalize database coordinate strings');
assert.match(focalEditorSource, /router\.refresh\(\)/, 'a successful focal save must refresh the read-only Admin gallery');
const focalRouteSource = await readFile(new URL('../app/api/admin/datasets/focal/route.js', import.meta.url), 'utf8');
assert.match(focalRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(focalRouteSource, /isValidFocalCoordinate\(body\?\.focalX\)/);
assert.match(focalRouteSource, /isValidFocalCoordinate\(body\?\.focalY\)/);
assert.match(focalRouteSource, /return Response\.json\(\{ error: 'Focal coordinates must be numbers from 0 to 100\.' \}, \{ status: 400 \}\)/);
assert.doesNotMatch(focalRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
assert.match(focalRouteSource, /Display mode must be cover or portrait/);
assert.match(
  focalRouteSource,
  /const image = await updateAdminProfileImageFocal\([\s\S]*revalidatePath\('\/'\)/,
  'a successful focal database update must invalidate the public homepage without a redeploy',
);
const uploadRouteSource = await readFile(new URL('../app/api/admin/datasets/images/route.js', import.meta.url), 'utf8');
assert.match(uploadRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(uploadRouteSource, /normalizeProfileImage/, 'Admin uploads must use the canonical oversized-image normalizer');
assert.match(uploadRouteSource, /MAX_PROFILE_IMAGE_INPUT_BYTES/);
assert.match(uploadRouteSource, /image_too_large_after_normalization/);
assert.match(uploadRouteSource, /buildProfileImageStoragePath/);
assert.match(uploadRouteSource, /revalidatePath\('\/'\)/, 'uploads must invalidate Discovery when primary metadata can change');
assert.match(uploadRouteSource, /revalidatePath\(`\/profile\/\$\{dataset\.slug\}/, 'uploads must invalidate the public profile');
assert.doesNotMatch(uploadRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
const nextConfigSource = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8');
assert.match(nextConfigSource, /proxyClientMaxBodySize: '53mb'/, 'multipart input must reach the bounded 50 MiB normalizer');
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
assert.match(imageActionRouteSource, /revalidatePath\('\/'\)/, 'primary, rotation, order, and removal actions must invalidate Discovery');
assert.doesNotMatch(imageActionRouteSource, /SUPABASE_SERVICE_ROLE_KEY/);
const batchImageRouteSources = await Promise.all([
  '../app/api/admin/datasets/images/import/status/route.js',
  '../app/api/admin/datasets/images/import/preview/route.js',
  '../app/api/admin/datasets/images/import/apply/route.js',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
for (const source of batchImageRouteSources) {
  assert.match(source, /authorizeAdminRequest\(request\)/, 'every batch image endpoint must use Admin authorization and trusted-origin protection');
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|GOOGLE_SERVICE_ACCOUNT/, 'routes must not expose or handle credentials directly');
}
assert.match(batchImageRouteSources[2], /body\?\.confirm !== true/, 'apply must require explicit Admin confirmation');
const batchImageServerSource = await readFile(new URL('../lib/profile-image-batch-server.js', import.meta.url), 'utf8');
assert.match(batchImageServerSource, /import 'server-only'/);
assert.match(batchImageServerSource, /\.eq\('id', datasetId\)/, 'dataset lookup must use the selected dataset ID');
assert.match(batchImageServerSource, /\.eq\('dataset_id', dataset\.id\)/, 'profile and gallery reads must remain dataset-scoped');
assert.match(batchImageServerSource, /getDriveAuth\(\{ strict: true, serviceAccountOnly: true \}\)/, 'Admin Drive credentials must stay server-side');
assert.match(batchImageServerSource, /ingestProfileImages/, 'Admin batch must reuse canonical Drive download, validation, EXIF, path, and upload logic');
assert.match(batchImageServerSource, /create_profile_image_gallery_if_empty/, 'Admin batch must use the atomic empty-gallery RPC');
assert.doesNotMatch(batchImageServerSource, /spawn|python3|python\b/, 'Admin batch must not shell out to external executables');
const datasetManagerSource = await readFile(new URL('../components/DatasetManager.js', import.meta.url), 'utf8');
assert.match(datasetManagerSource, /Preview missing images/);
assert.match(datasetManagerSource, /Import missing images/);
assert.match(datasetManagerSource, /confirm: true/);
assert.doesNotMatch(datasetManagerSource, /driveFileId|driveFolderId|storagePath/, 'the image batch UI must not receive sensitive Drive or Storage identifiers');
const imageManagerSource = await readFile(new URL('../components/AdminImageManager.js', import.meta.url), 'utf8');
assert.match(imageManagerSource, /api\/admin\/datasets\/images/);
assert.match(imageManagerSource, /FocalPointEditor/);
assert.match(imageManagerSource, /controlsOutside/);
assert.equal((imageManagerSource.match(/<FocalPointEditor/g) || []).length, 1, 'the lower image manager must be the only focal editor surface');
assert.match(imageManagerSource, /images\.length === 1/);
assert.match(imageManagerSource, /Remove the only profile image\?/);
assert.match(imageManagerSource, /action: 'delete'/, 'the sole-image confirmation must use the existing authorized delete action');
assert.match(imageManagerSource, /Image intentionally removed by Admin/);
assert.match(profileDetailSource, /imageClearedByAdmin=\{profile\.imageClearedByAdmin === true\}/);
assert.match(focalEditorSource, /focal-editor-canvas/);
assert.match(focalEditorSource, /focal-editor-editing-image/);
assert.doesNotMatch(profileGalleryStyles, /\.focal-editor-editing-image[^}]*object-fit:\s*contain\s*!important/, 'cover-mode focal previews must not be forced into contain mode');
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
