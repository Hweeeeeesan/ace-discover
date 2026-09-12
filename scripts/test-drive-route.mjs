#!/usr/bin/env node

import assert from 'node:assert/strict';
import { GET } from '../app/api/drive-image/route.js';
import { proxyImageResponse } from '../lib/google-drive-server.js';
import { MAX_PROFILE_IMAGE_INPUT_BYTES } from '../lib/profile-image-constraints.js';
import {
  allowedDriveFileIds,
  allowedDriveFolderIds,
} from '../lib/drive-image-allowlist.js';

const driveEnvironmentKeys = [
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
for (const key of driveEnvironmentKeys) delete process.env[key];

const fileId = allowedDriveFileIds.values().next().value;
const folderId = allowedDriveFolderIds.values().next().value;
assert.ok(fileId, 'The generated Drive-file allowlist should not be empty.');
assert.ok(folderId, 'The generated Drive-folder allowlist should not be empty.');

async function status(query) {
  const response = await GET(new Request(`http://localhost/api/drive-image${query}`));
  return response.status;
}

assert.equal(await status(''), 400);
assert.equal(await status('?fileId=short'), 400);
assert.equal(await status('?fileId=UNLISTED_VALID_DRIVE_ID_123456789'), 404);
assert.equal(await status(`?fileId=${fileId}&folderId=${folderId}`), 400);
assert.equal(await status(`?folderId=${folderId}`), 503);

const megabyte = 1024 * 1024;
let chunksSent = 0;
const oversizedChunkedImage = new Response(new ReadableStream({
  pull(controller) {
    chunksSent += 1;
    controller.enqueue(new Uint8Array(megabyte));
    if (chunksSent === (MAX_PROFILE_IMAGE_INPUT_BYTES / megabyte) + 1) controller.close();
  },
}), { headers: { 'Content-Type': 'image/jpeg' } });
const limitedResponse = proxyImageResponse(oversizedChunkedImage, 'drive-file');
assert.equal(limitedResponse.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
await assert.rejects(limitedResponse.arrayBuffer(), /exceeded the proxy size limit/);

console.log(
  `Drive route validation passed (${allowedDriveFileIds.size} files, ${allowedDriveFolderIds.size} folders).`,
);
