#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  compareDriveFilesNaturally,
  DriveAuthConfigurationError,
  fetchDriveImage,
  getDriveAuth,
} from '../lib/google-drive-server.js';
import {
  ingestProfileImages,
  MAX_PROFILE_IMAGE_INPUT_BYTES,
  MIN_REPLACEMENT_FALLBACK_LONG_EDGE,
  MIN_REPLACEMENT_FALLBACK_SHORT_EDGE,
  ProfileImageIngestionError,
  ingestProfileImage,
} from '../lib/profile-image-ingestion.js';
import { migrateDatasetProfileGalleries } from '../lib/profile-image-migration.js';

const credentialKeys = [
  'GOOGLE_DRIVE_ACCESS_TOKEN',
  'GOOGLE_DRIVE_API_KEY',
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REFRESH_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_IMPERSONATED_USER',
];
const savedEnvironment = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
credentialKeys.forEach((key) => delete process.env[key]);

const unauthenticated = await getDriveAuth({ strict: true });
assert.equal(unauthenticated.mode, 'public-only', 'missing credentials must preserve public-only behavior');
assert.equal(unauthenticated.authenticated, false);

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'service-account@example.invalid';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = 'not-a-private-key';
await assert.rejects(
  getDriveAuth({ strict: true }),
  (error) => error instanceof DriveAuthConfigurationError,
  'malformed configured credentials must fail clearly instead of silently falling back',
);
credentialKeys.forEach((key) => {
  if (savedEnvironment[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnvironment[key];
});

const jpegBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 80, g: 120, b: 160 } } }).jpeg().toBuffer();
const imageResponse = () => new Response(jpegBytes, { headers: { 'Content-Type': 'image/jpeg' } });
const acceptableFallbackPng = await sharp({
  create: {
    width: 1200,
    height: 900,
    channels: 4,
    background: { r: 70, g: 120, b: 180, alpha: 0.7 },
  },
}).png().toBuffer();
const tinyFallbackPng = await sharp({
  create: {
    width: 220,
    height: 165,
    channels: 4,
    background: { r: 70, g: 120, b: 180, alpha: 1 },
  },
}).png().toBuffer();
const acceptableFallbackResponse = () => new Response(acceptableFallbackPng, {
  headers: {
    'Content-Type': 'image/png',
    'X-Drive-Download-Source': 'thumbnail_fallback',
  },
});
const previouslyRejectedOriginalLength = (25 * 1024 * 1024) + 1;
const authenticated = { accessToken: 'mock-access-token', apiKey: null, authenticated: true, mode: 'service-account' };
const publicOnly = { accessToken: null, apiKey: null, authenticated: false, mode: 'public-only' };

const nativeFetch = globalThis.fetch;
try {
  const originalCalls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    originalCalls.push({ url, authorization: new Headers(options.headers).get('authorization') });
    if (!url.includes('alt=media')) {
      return Response.json({
        id: '1234567890ORIGINAL',
        name: 'original.jpg',
        mimeType: 'image/jpeg',
        size: String(jpegBytes.length),
        thumbnailLink: 'https://thumbnail.example/should-not-run',
      });
    }
    return new Response(jpegBytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(previouslyRejectedOriginalLength),
      },
    });
  };
  const originalResponse = await fetchDriveImage('1234567890ORIGINAL', authenticated);
  assert.equal(originalResponse.headers.get('x-drive-download-source'), 'original_media');
  assert.equal(
    Number(originalResponse.headers.get('content-length')),
    previouslyRejectedOriginalLength,
    'original media between the obsolete 25 MiB gate and the 50 MiB normalization input limit must remain eligible',
  );
  assert.equal(originalCalls.length, 2, 'metadata should be followed directly by original media');
  assert.match(originalCalls[1].url, /\/drive\/v3\/files\/1234567890ORIGINAL\?alt=media/);
  assert.equal(originalCalls[1].authorization, 'Bearer mock-access-token');
  assert.equal(
    originalCalls.some((call) => call.url.includes('thumbnail.example')),
    false,
    'thumbnailLink must not be fetched when original media succeeds',
  );

  const publicFullCalls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    publicFullCalls.push(url);
    if (!url.includes('alt=media') && url.includes('googleapis.com/drive/v3/files/')) {
      return Response.json({
        id: '1234567890PUBLICFULL',
        name: 'public-full.jpg',
        mimeType: 'image/jpeg',
        thumbnailLink: 'https://thumbnail.example/not-needed',
      });
    }
    if (url.includes('drive.usercontent.google.com/download')) return imageResponse();
    return new Response('unavailable', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  const publicFullResponse = await fetchDriveImage('1234567890PUBLICFULL', authenticated);
  assert.equal(publicFullResponse.headers.get('x-drive-download-source'), 'public_full_file');
  assert.equal(
    publicFullCalls.some((url) => url.includes('thumbnail.example')),
    false,
    'a safe public full-file response must be used before thumbnailLink',
  );

  const fallbackCalls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    fallbackCalls.push(url);
    if (!url.includes('alt=media') && url.includes('googleapis.com/drive/v3/files/')) {
      return Response.json({
        id: '1234567890FALLBACK',
        name: 'fallback.jpg',
        mimeType: 'image/jpeg',
        thumbnailLink: 'https://thumbnail.example/last-resort',
      });
    }
    if (url.includes('thumbnail.example')) return imageResponse();
    return new Response('unavailable', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  const fallbackResponse = await fetchDriveImage('1234567890FALLBACK', authenticated);
  assert.equal(fallbackResponse.headers.get('x-drive-download-source'), 'thumbnail_fallback');
  assert.ok(fallbackCalls.findIndex((url) => url.includes('alt=media')) >= 0);
  assert.ok(fallbackCalls.findIndex((url) => url.includes('drive.usercontent.google.com/download')) >= 0);
  assert.ok(
    fallbackCalls.findIndex((url) => url.includes('thumbnail.example'))
      > fallbackCalls.findIndex((url) => url.includes('drive.google.com/uc?')),
    'metadata thumbnail must run only after original media and public full-file fallbacks',
  );

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (!url.includes('alt=media') && url.includes('googleapis.com/drive/v3/files/')) {
      return Response.json({
        id: '1234567890ACCEPTABLE',
        name: 'acceptable.png',
        mimeType: 'image/png',
        thumbnailLink: 'https://thumbnail.example/acceptable',
      });
    }
    if (url.includes('thumbnail.example/acceptable')) {
      return new Response(acceptableFallbackPng, { headers: { 'Content-Type': 'image/png' } });
    }
    return new Response('unavailable', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  const acceptableFallback = await fetchDriveImage('1234567890ACCEPTABLE', authenticated);
  assert.equal(acceptableFallback.headers.get('x-drive-download-source'), 'thumbnail_fallback');
  assert.equal(acceptableFallback.headers.get('content-type'), 'image/png', 'PNG fallback support must remain unchanged');
} finally {
  globalThis.fetch = nativeFetch;
}

const authenticatedFile = await ingestProfileImage({
  profile: { id: 'private-file', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
  datasetSlug: 'spring-2026',
  driveAuth: authenticated,
  dryRun: true,
  driveClient: {
    fetchDriveImage: async () => imageResponse(),
    listImageFilesInFolder: async () => [],
  },
});
assert.equal(authenticatedFile.recoveryCategory, 'authenticated_file');
assert.equal(authenticatedFile.storagePath, 'spring-2026/private-file/primary.jpg');

const publicFile = await ingestProfileImage({
  profile: { id: 'public-file', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
  datasetSlug: 'spring-2026',
  driveAuth: publicOnly,
  dryRun: true,
  driveClient: {
    fetchDriveImage: async () => imageResponse(),
    listImageFilesInFolder: async () => [],
  },
});
assert.equal(publicFile.recoveryCategory, 'public_file', 'unauthenticated public access remains supported');

await assert.rejects(
  ingestProfileImage({
    profile: { id: 'denied', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
    datasetSlug: 'spring-2026',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: { fetchDriveImage: async () => null, listImageFilesInFolder: async () => [] },
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'permission_denied_after_auth',
);

await assert.rejects(
  ingestProfileImage({
    profile: { id: 'denied-no-creds', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
    datasetSlug: 'spring-2026',
    driveAuth: publicOnly,
    dryRun: true,
    driveClient: { fetchDriveImage: async () => null, listImageFilesInFolder: async () => [] },
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'credentials_missing',
);

const folderClient = (files, responseById) => ({
  listImageFilesInFolder: async () => files,
  fetchDriveImage: async (fileId) => responseById[fileId]?.() || null,
});
const folderProfile = { id: 'folder-one', driveFolderId: '1234567890FOLDER', imageKind: 'drive-folder' };

const folderSingle = await ingestProfileImage({
  profile: folderProfile,
  datasetSlug: 'fall-2025',
  driveAuth: authenticated,
  dryRun: true,
  driveClient: folderClient(
    [{ id: '1234567890IMAGE1', name: 'portrait.jpg', mimeType: 'image/jpeg' }],
    { '1234567890IMAGE1': imageResponse },
  ),
});
assert.equal(folderSingle.recoveryCategory, 'folder_single_image');
assert.equal(folderSingle.resolvedDriveFileId, '1234567890IMAGE1');

const naturallyOrdered = [
  { id: '3', name: 'photo10.jpg' },
  { id: '1', name: 'photo1.jpg' },
  { id: '2', name: 'photo2.jpg' },
].sort(compareDriveFilesNaturally);
assert.deepEqual(naturallyOrdered.map((file) => file.name), ['photo1.jpg', 'photo2.jpg', 'photo10.jpg']);

const galleryUploads = [];
const galleryIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];
const folderGallery = await ingestProfileImages({
  profile: { ...folderProfile, id: 'folder-gallery' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  createImageId: () => galleryIds.shift(),
  upload: async (upload) => galleryUploads.push(upload),
  driveClient: {
    listFilesInFolder: async () => [
      { id: '1234567890IMAGE10', name: 'photo10.jpg', mimeType: 'image/jpeg' },
      { id: '1234567890PDF000', name: 'notes.pdf', mimeType: 'application/pdf' },
      { id: '1234567890IMAGE2', name: 'photo2.jpg', mimeType: 'image/jpeg' },
      { id: '1234567890IMAGE1', name: 'photo1.jpg', mimeType: 'image/jpeg' },
    ],
    fetchDriveImage: async (fileId) => (
      fileId === '1234567890IMAGE2'
        ? new Response('corrupt', { headers: { 'Content-Type': 'image/jpeg' } })
        : imageResponse()
    ),
  },
});
assert.equal(folderGallery.sourceKind, 'folder');
assert.equal(folderGallery.filesDiscovered, 4);
assert.equal(folderGallery.supportedImages, 3);
assert.deepEqual(folderGallery.images.map((image) => image.name), ['photo1.jpg', 'photo10.jpg']);
assert.deepEqual(folderGallery.images.map((image) => image.storagePath), [
  'fall-2026/folder-gallery/11111111-1111-4111-8111-111111111111.jpg',
  'fall-2026/folder-gallery/22222222-2222-4222-8222-222222222222.jpg',
]);
assert.equal(galleryUploads.length, 6, 'each valid sibling must stage canonical, ProfileDetail, and Discovery objects');
assert.deepEqual(folderGallery.rejected.map((item) => item.category).sort(), ['corrupt_image', 'unsupported_file_type']);

const thumbnailDiagnostic = await ingestProfileImages({
  profile: { id: 'thumbnail-diagnostic', driveFileId: '1234567890THUMB', imageKind: 'drive-file' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: true,
  driveClient: {
    fetchDriveImage: async () => new Response(jpegBytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Drive-Download-Source': 'thumbnail_fallback',
      },
    }),
  },
});
assert.equal(thumbnailDiagnostic.diagnostics[0]?.category, 'thumbnail_fallback_used');
assert.equal(thumbnailDiagnostic.images[0]?.downloadSource, 'thumbnail_fallback');
assert.equal(thumbnailDiagnostic.allSupportedValidated, true, 'normal ingestion may retain a tiny thumbnail fallback for resilience');

const acceptableReplacementUploads = [];
const acceptableThumbnailReplacement = await ingestProfileImages({
  profile: { id: 'acceptable-thumbnail', driveFileId: '1234567890THUMB', imageKind: 'drive-file' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  requireAllSupported: true,
  upload: async (upload) => acceptableReplacementUploads.push(upload),
  driveClient: { fetchDriveImage: async () => acceptableFallbackResponse() },
});
assert.equal(acceptableThumbnailReplacement.allSupportedValidated, true);
assert.equal(acceptableThumbnailReplacement.rejected.length, 0);
assert.equal(acceptableThumbnailReplacement.images[0]?.contentType, 'image/png');
assert.equal(acceptableReplacementUploads.length, 3, 'an adequately sized fallback produces the canonical and both public derivatives');
assert.ok(acceptableThumbnailReplacement.images[0].width >= MIN_REPLACEMENT_FALLBACK_LONG_EDGE);
assert.ok(acceptableThumbnailReplacement.images[0].height >= MIN_REPLACEMENT_FALLBACK_SHORT_EDGE);

let degradedReplacementUploads = 0;
const degradedReplacement = await ingestProfileImages({
  profile: { ...folderProfile, id: 'degraded-replacement' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  requireAllSupported: true,
  upload: async () => { degradedReplacementUploads += 1; },
  driveClient: {
    listFilesInFolder: async () => [
      { id: '1234567890ORIGINAL', name: 'one.jpg', mimeType: 'image/jpeg' },
      { id: '1234567890TINYPNG', name: 'two.png', mimeType: 'image/png' },
    ],
    fetchDriveImage: async (fileId) => (
      fileId.endsWith('TINYPNG')
        ? new Response(tinyFallbackPng, {
          headers: { 'Content-Type': 'image/png', 'X-Drive-Download-Source': 'thumbnail_fallback' },
        })
        : imageResponse()
    ),
  },
});
assert.equal(degradedReplacement.allSupportedValidated, false);
assert.equal(degradedReplacementUploads, 0, 'a tiny fallback must prevent every transactional replacement upload');
assert.equal(degradedReplacement.images.length, 0);
assert.equal(degradedReplacement.rejected[0]?.category, 'thumbnail_too_small_for_replacement');
assert.ok(degradedReplacement.diagnostics.some(
  (diagnostic) => diagnostic.category === 'thumbnail_fallback_rejected_for_replacement',
));

const existingGalleryPath = 'fall-2026/degraded-replacement/11111111-1111-4111-8111-111111111111.jpg';
let degradedReplacementMetadataCalls = 0;
const preservedDegradedGallery = await migrateDatasetProfileGalleries({
  dataset: { slug: 'fall-2026' },
  profiles: [{
    id: 'degraded-replacement',
    driveFolderId: '1234567890FOLDER',
    profileImages: [{
      id: '11111111-1111-4111-8111-111111111111',
      storagePath: existingGalleryPath,
      position: 0,
      isPrimary: true,
    }],
  }],
  dryRun: false,
  replaceExisting: true,
  ingestGallery: async () => degradedReplacement,
  replaceGallery: async () => { degradedReplacementMetadataCalls += 1; },
  removeStorage: async () => assert.fail('no degraded replacement objects should have been staged'),
});
assert.equal(preservedDegradedGallery.rows[0].status, 'replacement_failed_preserved');
assert.equal(preservedDegradedGallery.rows[0].primaryStoragePath, existingGalleryPath);
assert.equal(degradedReplacementMetadataCalls, 0, 'degraded replacement metadata must never replace the existing gallery');

const stagedEvents = [];
const stagedRepair = await ingestProfileImages({
  profile: { ...folderProfile, id: 'staged-repair' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  requireAllSupported: true,
  createImageId: (() => {
    const ids = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    return () => ids.shift();
  })(),
  upload: async ({ storagePath }) => stagedEvents.push(`upload:${storagePath}`),
  driveClient: {
    listFilesInFolder: async () => [
      { id: '1234567890STAGE1', name: 'one.jpg', mimeType: 'image/jpeg' },
      { id: '1234567890STAGE2', name: 'two.jpg', mimeType: 'image/jpeg' },
    ],
    fetchDriveImage: async (fileId) => {
      stagedEvents.push(`fetch:${fileId}`);
      return imageResponse();
    },
  },
});
assert.equal(stagedRepair.images.length, 2);
assert.deepEqual(
  stagedEvents.map((event) => event.split(':', 1)[0]),
  ['fetch', 'fetch', 'upload', 'upload', 'upload', 'upload', 'upload', 'upload'],
  'replacement ingestion must download and validate every supported file before uploading any',
);

let invalidRepairUploads = 0;
const invalidStagedRepair = await ingestProfileImages({
  profile: { ...folderProfile, id: 'invalid-staged-repair' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  requireAllSupported: true,
  upload: async () => { invalidRepairUploads += 1; },
  driveClient: {
    listFilesInFolder: async () => [
      { id: '1234567890VALID1', name: 'one.jpg', mimeType: 'image/jpeg' },
      { id: '1234567890BROKEN', name: 'two.jpg', mimeType: 'image/jpeg' },
    ],
    fetchDriveImage: async (fileId) => (
      fileId.endsWith('BROKEN') ? new Response('corrupt') : imageResponse()
    ),
  },
});
assert.equal(invalidStagedRepair.allSupportedValidated, false);
assert.equal(invalidStagedRepair.images.length, 0);
assert.equal(invalidRepairUploads, 0, 'a validation failure must prevent every replacement upload');

const oneImageGallery = await ingestProfileImages({
  profile: { ...folderProfile, id: 'folder-gallery-one' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: true,
  createImageId: () => '33333333-3333-4333-8333-333333333333',
  driveClient: {
    listFilesInFolder: async () => [{ id: '1234567890IMAGE1', name: 'only.png', mimeType: 'image/png' }],
    fetchDriveImage: async () => imageResponse(),
  },
});
assert.equal(oneImageGallery.images.length, 1);

await assert.rejects(
  ingestProfileImages({
    profile: { ...folderProfile, id: 'folder-private' },
    datasetSlug: 'fall-2026',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: {
      listFilesInFolder: async () => { throw new Error('Drive returned 403'); },
      fetchDriveImage: async () => imageResponse(),
    },
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'folder_inaccessible',
);

const orientedGallerySource = await sharp({
  create: { width: 3, height: 1, channels: 3, background: { r: 200, g: 80, b: 50 } },
}).withMetadata({ orientation: 6 }).jpeg().toBuffer();
let orientedUpload;
await ingestProfileImages({
  profile: { id: 'oriented-file', driveFileId: '1234567890ORIENT', imageKind: 'drive-file' },
  datasetSlug: 'fall-2026',
  driveAuth: authenticated,
  dryRun: false,
  createImageId: () => '44444444-4444-4444-8444-444444444444',
  upload: async (upload) => { orientedUpload = upload; },
  driveClient: { fetchDriveImage: async () => new Response(orientedGallerySource) },
});
const orientedMetadata = await sharp(orientedUpload.bytes).metadata();
assert.deepEqual(
  { width: orientedMetadata.width, height: orientedMetadata.height, orientation: orientedMetadata.orientation },
  { width: 1, height: 3, orientation: undefined },
  'folder/file migration must retain canonical Sharp EXIF normalization',
);

await assert.rejects(
  ingestProfileImage({
    profile: { ...folderProfile, id: 'folder-empty' },
    datasetSlug: 'fall-2025',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: folderClient([], {}),
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'folder_no_image',
);

const multipleFiles = [
  { id: '1234567890IMAGE1', name: 'one.jpg', mimeType: 'image/jpeg' },
  { id: '1234567890IMAGE2', name: 'two.jpg', mimeType: 'image/jpeg' },
];
let folderFetches = 0;
await assert.rejects(
  ingestProfileImage({
    profile: { ...folderProfile, id: 'folder-many' },
    datasetSlug: 'fall-2025',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: {
      listImageFilesInFolder: async () => multipleFiles,
      fetchDriveImage: async () => { folderFetches += 1; return imageResponse(); },
    },
  }),
  (error) => error instanceof ProfileImageIngestionError
    && error.code === 'folder_multiple_images'
    && error.candidateCount === 2
    && /one\.jpg, two\.jpg/.test(error.message),
);
assert.equal(folderFetches, 2, 'multiple valid candidates must be inspected, then rejected without guessing');

await assert.rejects(
  ingestProfileImage({
    profile: { ...folderProfile, id: 'folder-corrupt' },
    datasetSlug: 'fall-2025',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: folderClient(
      [{ id: '1234567890BADIMAGE', name: 'photo.jpg', mimeType: 'image/jpeg' }],
      { '1234567890BADIMAGE': () => new Response('not an image', { headers: { 'Content-Type': 'image/jpeg' } }) },
    ),
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'folder_no_image',
);

await assert.rejects(
  ingestProfileImage({
    profile: { id: 'oversized', driveFileId: '1234567890ABCDE', imageKind: 'drive-file' },
    datasetSlug: 'spring-2026',
    driveAuth: authenticated,
    dryRun: true,
    driveClient: {
      fetchDriveImage: async () => new Response(jpegBytes, {
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(MAX_PROFILE_IMAGE_INPUT_BYTES + 1) },
      }),
      listImageFilesInFolder: async () => [],
    },
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'image_input_too_large',
);

const browserSources = await Promise.all([
  '../components/AdminAuth.js',
  '../lib/supabase/browser.js',
  '../lib/supabase/config.js',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
for (const source of browserSources) {
  assert.doesNotMatch(source, /GOOGLE_SERVICE_ACCOUNT|GOOGLE_PRIVATE_KEY|GOOGLE_DRIVE_ACCESS_TOKEN/);
}

console.log('Authenticated Drive file/folder recovery tests passed.');
