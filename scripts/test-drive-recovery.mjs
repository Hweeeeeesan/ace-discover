#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  DriveAuthConfigurationError,
  getDriveAuth,
} from '../lib/google-drive-server.js';
import {
  MAX_PROFILE_IMAGE_BYTES,
  ProfileImageIngestionError,
  ingestProfileImage,
} from '../lib/profile-image-ingestion.js';

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
const authenticated = { accessToken: 'mock-access-token', apiKey: null, authenticated: true, mode: 'service-account' };
const publicOnly = { accessToken: null, apiKey: null, authenticated: false, mode: 'public-only' };

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
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(MAX_PROFILE_IMAGE_BYTES + 1) },
      }),
      listImageFilesInFolder: async () => [],
    },
  }),
  (error) => error instanceof ProfileImageIngestionError && error.code === 'unsupported_content',
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
