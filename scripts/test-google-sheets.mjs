import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  chooseWorksheet,
  fetchSpreadsheetMetadata,
  fetchWorksheetValues,
  GoogleSheetsError,
  parseGoogleSheetUrl,
} from '../lib/google-sheets.js';
import {
  buildDatasetImportTargetFields,
  buildDatasetSyncDiff,
  preserveMissingSourceProfiles,
  validateSyncApplyAcknowledgement,
} from '../lib/datasets/sync.js';

assert.deepEqual(
  buildDatasetImportTargetFields(),
  { target_dataset_id: null, target_imported_at: null },
  'a new Sheet import must leave both target-version fields null',
);
const currentDatasetId = '123e4567-e89b-12d3-a456-426614174000';
const currentImportedAt = '2026-09-04T22:21:00.000Z';
assert.deepEqual(
  buildDatasetImportTargetFields({ datasetId: currentDatasetId, importedAt: currentImportedAt }),
  { target_dataset_id: currentDatasetId, target_imported_at: currentImportedAt },
  'an existing-dataset Sheet sync must store both target-version fields',
);
assert.throws(
  () => buildDatasetImportTargetFields({ datasetId: currentDatasetId }),
  /require both/,
  'a target dataset cannot be inserted without its imported-at version',
);
assert.throws(
  () => buildDatasetImportTargetFields({ importedAt: currentImportedAt }),
  /require both/,
  'an imported-at version cannot be inserted without its target dataset',
);

const sheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
assert.equal(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`), sheetId);
for (const invalid of [
  '',
  'not a url',
  `http://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  `https://evil.example/spreadsheets/d/${sheetId}/edit`,
  'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
  'https://docs.google.com/spreadsheets/d/short/edit',
]) assert.throws(() => parseGoogleSheetUrl(invalid), GoogleSheetsError);

let requestedUrl = '';
let requestedOptions = null;
const metadata = await fetchSpreadsheetMetadata(sheetId, {
  accessToken: 'mock-service-account-token',
  fetchImpl: async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return Response.json({
      spreadsheetId: sheetId,
      properties: { title: 'Master Program Application Fall 2026' },
      sheets: [
        { properties: { sheetId: 2, title: 'Notes', index: 1, gridProperties: { rowCount: 20, columnCount: 4 } } },
        { properties: { sheetId: 1, title: 'Form Responses 1', index: 0, gridProperties: { rowCount: 50, columnCount: 102 } } },
      ],
    });
  },
});
assert.match(requestedUrl, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//);
assert.equal(requestedOptions.headers.Authorization, 'Bearer mock-service-account-token');
assert.equal(requestedOptions.cache, 'no-store');
assert.equal(metadata.title, 'Master Program Application Fall 2026');
assert.equal(metadata.tabs[0].title, 'Form Responses 1');
assert.equal(chooseWorksheet(metadata.tabs), 'Form Responses 1');
assert.equal(chooseWorksheet([{ id: 1, title: 'Only Tab' }]), 'Only Tab');
assert.equal(chooseWorksheet([{ id: 1, title: 'Responses A' }, { id: 2, title: 'Responses B' }]), '');

const values = await fetchWorksheetValues(sheetId, "Form Responses 1", {
  accessToken: 'mock-token',
  fetchImpl: async () => Response.json({ values: [['Timestamp', 'First'], ['now', 'Sarah']] }),
});
assert.deepEqual(values[1], ['now', 'Sarah']);
await assert.rejects(
  fetchWorksheetValues(sheetId, 'Empty', {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ values: [['Timestamp', 'First']] }),
  }),
  (error) => error.code === 'EMPTY_SHEET',
);

await assert.rejects(
  fetchSpreadsheetMetadata(sheetId, {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ error: { message: 'The caller does not have permission' } }, { status: 403 }),
  }),
  (error) => error.code === 'SHEET_UNAVAILABLE' && /as Viewer/.test(error.message),
);
await assert.rejects(
  fetchSpreadsheetMetadata(sheetId, {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ error: { message: 'Google Sheets API has not been used or is disabled' } }, { status: 403 }),
  }),
  (error) => error.code === 'API_DISABLED' && /Enable it/.test(error.message),
);

const currentRows = [
  {
    profile_id: 'logan-ho', ordinal: 0,
    public_data: { id: 'logan-ho', name: 'Logan Ho', role: 'Big', music: 'Old', hobbies: 'Same', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    drive_file_id: 'old-drive-file-id-12345', drive_folder_id: '', image_kind: 'drive-file', image_issue: '',
    storage_image_path: 'fall-2026/logan-ho/primary.jpg',
  },
  {
    profile_id: 'jamie-nguyen', ordinal: 1,
    public_data: { id: 'jamie-nguyen', name: 'Jamie Nguyen', role: 'Big', music: 'Same', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    drive_file_id: '', drive_folder_id: '', image_kind: 'missing', image_issue: 'missing', storage_image_path: null,
  },
];
const incoming = [
  {
    public: { ...currentRows[0].public_data, music: 'New' },
    driveFileId: 'new-drive-file-id-12345', driveFolderId: '', imageKind: 'drive-file', imageIssue: '',
  },
  {
    public: { id: 'sarah-nguyen', name: 'Sarah Nguyen', role: 'Big', music: '', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    driveFileId: '', driveFolderId: '', imageKind: 'missing', imageIssue: 'missing',
  },
];
const diff = buildDatasetSyncDiff(currentRows, incoming);
assert.deepEqual(diff.counts, { added: 1, updated: 1, removed: 1 });
assert.equal(diff.added[0].name, 'Sarah Nguyen');
assert.deepEqual(diff.removed.map((profile) => profile.name), ['Jamie Nguyen']);
assert.ok(diff.updated[0].fields.includes('Music'));
assert.ok(diff.updated[0].fields.includes('Drive photo source (gallery preserved)'));
assert.equal('public_data' in diff.updated[0], false, 'diff summaries must not expose raw profile values');

const payload = {
  profiles: incoming,
  health: {
    totalProfiles: 2,
    roleCounts: { Little: 0, Big: 2, Family: 0 },
    instagramCount: 0,
    slideDeckCount: 0,
    imageStatus: { usable: 1, missingOrInvalid: 1, byKind: { 'drive-file': 1, missing: 1 } },
    missingFieldCounts: { missingInstagram: 2 },
    vibeDistribution: {},
    majorGroupDistribution: { Business: 2 },
    socialLevelDistribution: { 3: 2 },
    socialStyleDistribution: { Ambivert: 2 },
  },
  safeIssues: { missingInstagram: [{ id: 'logan-ho', name: 'Logan Ho', role: 'Big' }, { id: 'sarah-nguyen', name: 'Sarah Nguyen', role: 'Big' }] },
};
const merged = preserveMissingSourceProfiles(payload, currentRows, diff, {
  missingInstagram: [{ id: 'jamie-nguyen', name: 'Jamie Nguyen', role: 'Big' }],
});
assert.equal(merged.profiles.length, 3);
assert.equal(merged.profiles[2].public.id, 'jamie-nguyen');
assert.equal(merged.health.preservedMissingSourceCount, 1);
assert.equal(merged.profiles[2].public.storageImagePath, undefined);
assert.throws(() => validateSyncApplyAcknowledgement(diff, false), /Acknowledge/);
assert.doesNotThrow(() => validateSyncApplyAcknowledgement(diff, true));

const migration = await readFile(new URL('../supabase/migrations/202609040001_google_sheet_sync.sql', import.meta.url), 'utf8');
const applyFunction = migration.slice(migration.indexOf('create or replace function public.apply_dataset_sync'));
assert.match(applyFunction, /for update/);
assert.match(applyFunction, /on conflict \(dataset_id, profile_id\) do update/);
assert.match(applyFunction, /stored_count <> draft\.profile_count/);
assert.match(applyFunction, /target\.imported_at is distinct from draft\.target_imported_at/);
assert.doesNotMatch(applyFunction, /delete from public\.dataset_profiles/);
assert.doesNotMatch(applyFunction, /(?:delete|update|insert) (?:from |into )?public\.profile_images/);
assert.match(applyFunction, /acknowledge_removed is not true/);

const routePaths = [
  '../app/api/admin/datasets/sheets/connect/route.js',
  '../app/api/admin/datasets/sheets/analyze/route.js',
  '../app/api/admin/datasets/sync/apply/route.js',
];
for (const path of routePaths) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.match(source, /authorizeAdminRequest\(request\)/, `${path} must require Admin authorization and trusted origin`);
}
const checkRoute = await readFile(new URL('../app/api/admin/datasets/sheets/analyze/route.js', import.meta.url), 'utf8');
assert.doesNotMatch(checkRoute, /applyDatasetSyncImport/, 'checking for updates must not apply dataset mutations');
assert.doesNotMatch(checkRoute, /createDatasetSyncImport|createDatasetImport\(\{[\s\S]*targetDatasetId/, 'checking for updates must not write a staging row');
assert.match(checkRoute, /prepareDatasetSync/, 'checking for updates should compute a read-only preview');
assert.match(checkRoute, /analyzeGoogleSheetValues/, 'Sheets must use the canonical importer adapter');
const excelRoute = await readFile(new URL('../app/api/admin/datasets/analyze/route.js', import.meta.url), 'utf8');
assert.match(excelRoute, /analyzeWorkbookUpload/, 'manual Excel analysis must remain first-class');
assert.match(excelRoute, /if \(datasetId\) {[\s\S]*createDatasetSyncImport\(/, 'existing-dataset Excel previews must keep using shared sync targeting');
assert.match(excelRoute, /const draft = await createDatasetImport\(\{ metadata, payload, userId:/, 'new-dataset Excel previews must remain untargeted');
const datasetAdmin = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
assert.match(datasetAdmin, /\.select\('[^']*imported_at[^']*'\)[\s\S]*\.eq\('id', datasetId\)/, 'sync target reads must include the current imported_at version');
assert.match(datasetAdmin, /\.\.\.targetFields/, 'all preview inserts must use the paired target-field builder');
assert.doesNotMatch(datasetAdmin, /target_dataset_id:\s*targetDatasetId|target_imported_at:\s*targetImportedAt/, 'preview inserts must not assign target fields independently');
const driveAuth = await readFile(new URL('../lib/google-drive-server.js', import.meta.url), 'utf8');
assert.match(driveAuth, /spreadsheets\.readonly/);
const sheetsServer = await readFile(new URL('../lib/google-sheets-server.js', import.meta.url), 'utf8');
assert.match(sheetsServer, /import 'server-only'/);
assert.match(sheetsServer, /getDriveAuth\(\{ strict: true, serviceAccountOnly: true \}\)/);

console.log('Google Sheets URL, auth fetch, errors, selection, diff, safety, and authorization tests passed.');
