import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyProfileImageHealth,
  IMAGE_SOURCE_HEALTH_STATES,
  inspectProfileImageHealth,
  safeProfileImageHealth,
  summarizeProfileImageHealth,
} from '../lib/profile-image-health.js';
import { resolveProfileImageSources } from '../lib/profile-images.js';

const driveProfile = {
  id: 'source-health-test',
  name: 'Source Health Test',
  driveFileId: 'drive-file-12345',
  imageKind: 'drive-file',
  profileImages: [],
};
const originalInspection = {
  images: [{ width: 1600, height: 1200, downloadSource: 'original_media' }],
  rejected: [],
  diagnostics: [],
};

const ready = classifyProfileImageHealth({
  ...driveProfile,
  profileImages: [{ id: 'relational-image', storagePath: 'dataset/profile/image.jpg' }],
});
assert.equal(ready.state, IMAGE_SOURCE_HEALTH_STATES.READY);
assert.equal(ready.displayedFrom.label, 'Supabase relational gallery');
assert.equal(ready.storageGallery.count, 1);

const needsImport = classifyProfileImageHealth(driveProfile, originalInspection);
assert.equal(needsImport.state, IMAGE_SOURCE_HEALTH_STATES.NEEDS_IMPORT);
assert.equal(needsImport.canPreviewImport, true);
assert.match(needsImport.focalMessage, /Import this image to Storage/);

const mandyProfile = {
  ...driveProfile,
  id: 'mandy-lau',
  name: 'Mandy Lau',
  image: '/legacy/mandy-lau.jpg',
};
const pdfInspection = {
  images: [],
  rejected: [{ category: 'unsupported_file_type', mimeType: 'application/pdf' }],
  diagnostics: [],
};
const mandy = classifyProfileImageHealth(mandyProfile, pdfInspection);
assert.equal(mandy.state, IMAGE_SOURCE_HEALTH_STATES.UNSUPPORTED_SOURCE);
assert.equal(mandy.displayedFrom.label, 'Fallback image');
assert.equal(mandy.storageGallery.label, 'None');
assert.equal(mandy.driveSource.label, 'File · PDF');
assert.match(mandy.summary, /PDF, not an image/);
assert.match(mandy.detail, /JPG, PNG, WebP/);
assert.match(mandy.focalMessage, /cannot be imported/);

const tinyThumbnail = classifyProfileImageHealth(driveProfile, {
  images: [{ width: 220, height: 165, downloadSource: 'thumbnail_fallback' }],
  rejected: [],
  diagnostics: [{ category: 'thumbnail_fallback_used' }],
});
assert.equal(tinyThumbnail.state, IMAGE_SOURCE_HEALTH_STATES.DEGRADED_SOURCE);
assert.equal(tinyThumbnail.acceptableForReplacement, false);
assert.equal(tinyThumbnail.dimensions[0].label, '220×165');
assert.match(tinyThumbnail.focalMessage, /low-resolution thumbnail/);

const accessibleThumbnail = classifyProfileImageHealth(driveProfile, {
  images: [{ width: 1600, height: 1200, downloadSource: 'thumbnail_fallback' }],
  rejected: [],
  diagnostics: [{ category: 'thumbnail_fallback_used' }],
});
assert.equal(accessibleThumbnail.state, IMAGE_SOURCE_HEALTH_STATES.DEGRADED_SOURCE);
assert.equal(accessibleThumbnail.acceptableForReplacement, true);

const inaccessible = classifyProfileImageHealth(driveProfile, {
  images: [],
  rejected: [{ category: 'drive_download_failure' }],
  diagnostics: [],
});
assert.equal(inaccessible.state, IMAGE_SOURCE_HEALTH_STATES.INACCESSIBLE);

const normalizable = classifyProfileImageHealth(driveProfile, {
  images: [{ width: 4032, height: 3024, downloadSource: 'original_media' }],
  rejected: [],
  diagnostics: [{ category: 'oversized_image_normalized' }],
});
assert.equal(normalizable.state, IMAGE_SOURCE_HEALTH_STATES.NORMALIZATION_REQUIRED);
assert.equal(normalizable.canImport, true);

const noSource = classifyProfileImageHealth({
  id: 'no-source',
  name: 'No Source',
  image: '/profile-placeholder.svg',
  profileImages: [],
});
assert.equal(noSource.state, IMAGE_SOURCE_HEALTH_STATES.NO_SOURCE);
assert.match(noSource.focalMessage, /No editable Storage image yet/);

let ingestCalls = 0;
let receivedOptions = null;
const mutableProfile = structuredClone(driveProfile);
const beforeProfile = structuredClone(mutableProfile);
const inspected = await inspectProfileImageHealth({
  profile: mutableProfile,
  datasetSlug: 'fall-2025',
  driveAuth: { authenticated: true },
  ingest: async (options) => {
    ingestCalls += 1;
    receivedOptions = options;
    return originalInspection;
  },
});
assert.equal(inspected.state, IMAGE_SOURCE_HEALTH_STATES.NEEDS_IMPORT);
assert.equal(ingestCalls, 1);
assert.equal(receivedOptions.dryRun, true, 'source health must always run ingestion in dry-run mode');
assert.equal(receivedOptions.upload, undefined, 'source health must never receive a Storage upload function');
assert.deepEqual(mutableProfile, beforeProfile, 'source health must not mutate profile data');

let readyIngestCalls = 0;
await inspectProfileImageHealth({
  profile: { ...driveProfile, profileImages: [{}] },
  datasetSlug: 'fall-2025',
  driveAuth: {},
  ingest: async () => { readyIngestCalls += 1; },
});
assert.equal(readyIngestCalls, 0, 'an authoritative relational gallery must not re-check or encourage Drive replacement');

const publicProfile = { ...driveProfile, image: '/fallback.jpg', focalX: 20, focalY: 70 };
const publicBefore = resolveProfileImageSources(publicProfile);
await inspectProfileImageHealth({
  profile: publicProfile,
  datasetSlug: 'fall-2025',
  driveAuth: {},
  ingest: async () => originalInspection,
});
assert.deepEqual(resolveProfileImageSources(publicProfile), publicBefore, 'health inspection must not alter public image resolution');

const profileStates = [ready, needsImport, mandy, tinyThumbnail, inaccessible, normalizable, noSource]
  .map((health, index) => safeProfileImageHealth({ id: `profile-${index}`, name: `Profile ${index}` }, health));
const summary = summarizeProfileImageHealth(profileStates);
assert.equal(summary.total, 7);
assert.equal(summary.counts.ready, 1);
assert.equal(summary.counts.needs_import, 1);
assert.equal(summary.counts.unsupported_source, 1);
assert.equal(summary.counts.degraded_source, 1);
assert.equal(summary.counts.inaccessible, 1);
assert.equal(summary.counts.normalization_required, 1);
assert.equal(summary.counts.no_source, 1);
assert.equal(summary.issueCount, 6);

const imageManagerSource = await readFile(new URL('../components/AdminImageManager.js', import.meta.url), 'utf8');
assert.match(imageManagerSource, /No editable Storage image yet/);
assert.match(imageManagerSource, /sourceHealth\?\.focalMessage/);
assert.match(imageManagerSource, /Re-check source/);
assert.match(imageManagerSource, /Preview image import/);
assert.match(imageManagerSource, /Manage existing gallery/);

const datasetManagerSource = await readFile(new URL('../components/DatasetManager.js', import.meta.url), 'utf8');
assert.match(datasetManagerSource, /Image source health/);
assert.match(datasetManagerSource, /Review issues/);
assert.match(datasetManagerSource, /profile\.health\.summary/);
assert.doesNotMatch(datasetManagerSource, /driveFileId|driveFolderId|signedUrl|storagePath/);

const healthRouteSource = await readFile(new URL('../app/api/admin/datasets/images/health/route.js', import.meta.url), 'utf8');
assert.match(healthRouteSource, /authorizeAdminRequest\(request\)/);
assert.match(healthRouteSource, /getDatasetImageSourceHealth/);
assert.match(healthRouteSource, /getProfileImageSourceHealth/);
assert.doesNotMatch(healthRouteSource, /SUPABASE_SERVICE_ROLE_KEY|GOOGLE_SERVICE_ACCOUNT|driveFileId|driveFolderId/);

const batchServerSource = await readFile(new URL('../lib/profile-image-batch-server.js', import.meta.url), 'utf8');
assert.match(batchServerSource, /readOnly: true/);
assert.match(batchServerSource, /inspectProfileImageHealth/);
const healthSource = await readFile(new URL('../lib/profile-image-health.js', import.meta.url), 'utf8');
assert.match(healthSource, /dryRun: true/);
assert.doesNotMatch(healthSource, /\.upload\(|\.insert\(|\.update\(|\.delete\(/);

const adminDatasetSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
const previewReader = adminDatasetSource.slice(
  adminDatasetSource.indexOf('export async function getAdminDatasetProfile('),
  adminDatasetSource.indexOf('export async function updateAdminPublicProfile('),
);
assert.doesNotMatch(previewReader, /\.insert\(/, 'opening Admin preview must not materialize image metadata');

console.log('Admin profile image source health, zero-mutation, summary, and Mandy PDF tests passed.');
