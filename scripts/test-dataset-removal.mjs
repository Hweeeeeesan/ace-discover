import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DatasetRemovalError,
  isDatasetStoragePath,
  isValidDatasetId,
  listDatasetStoragePaths,
  removeDatasetWithStorage,
} from '../lib/datasets/removal.js';

const DATASET_ID = '11111111-1111-4111-8111-111111111111';
const READY_DATASET = {
  id: DATASET_ID,
  slug: 'fall-2026',
  name: 'Fall 2026 TEST',
  status: 'ready',
  profileCount: 2,
};

assert.equal(isValidDatasetId(DATASET_ID), true);
assert.equal(isValidDatasetId(DATASET_ID.toUpperCase()), true);
assert.equal(isValidDatasetId('fall-2026'), false);
assert.equal(isDatasetStoragePath('fall-2026/logan-ho/image.jpg', 'fall-2026'), true);
assert.equal(isDatasetStoragePath('spring-2026/logan-ho/image.jpg', 'fall-2026'), false);
assert.equal(isDatasetStoragePath('fall-2026/../spring-2026/image.jpg', 'fall-2026'), false);

function removalClient({ dataset = READY_DATASET, prepareError = null, listError = null, removeError = null, finalizeError = null } = {}) {
  const calls = { rpc: [], listed: [], removed: [], buckets: [] };
  const listings = new Map([
    ['fall-2026', [
      { name: 'logan-ho', id: null, metadata: null },
      { name: 'mia-lee', id: null, metadata: null },
    ]],
    ['fall-2026/logan-ho', [
      { name: '11111111-1111-4111-8111-111111111111.jpg', id: 'storage-a', metadata: { size: 100 } },
      { name: '22222222-2222-4222-8222-222222222222.png', id: 'storage-b', metadata: { size: 100 } },
    ]],
    ['fall-2026/mia-lee', [
      { name: '33333333-3333-4333-8333-333333333333.webp', id: 'storage-c', metadata: { size: 100 } },
    ]],
    ['spring-2026', [
      { name: 'unrelated', id: null, metadata: null },
    ]],
  ]);
  const storage = {
    async list(path, options) {
      calls.listed.push({ path, options });
      return { data: listError ? null : listings.get(path) || [], error: listError };
    },
    async remove(paths) {
      calls.removed.push(...paths);
      return { data: removeError ? null : paths, error: removeError };
    },
  };
  const supabase = {
    storage: {
      from(bucket) {
        calls.buckets.push(bucket);
        return storage;
      },
    },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === 'prepare_dataset_deletion') return { data: prepareError ? null : dataset, error: prepareError };
      if (name === 'cancel_dataset_deletion') return { data: true, error: null };
      if (name === 'delete_prepared_dataset') {
        return {
          data: finalizeError ? null : {
            ...dataset,
            profilesDeleted: 2,
            imageRowsDeleted: 3,
          },
          error: finalizeError,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  return { supabase, storage, calls };
}

const listingClient = removalClient();
assert.deepEqual(await listDatasetStoragePaths(listingClient.storage, 'fall-2026'), [
  'fall-2026/logan-ho/11111111-1111-4111-8111-111111111111.jpg',
  'fall-2026/logan-ho/22222222-2222-4222-8222-222222222222.png',
  'fall-2026/mia-lee/33333333-3333-4333-8333-333333333333.webp',
]);
assert.equal(listingClient.calls.listed.some(({ path }) => path === 'spring-2026'), false, 'unrelated semester prefixes must never be listed');

for (const status of ['ready', 'archived']) {
  const client = removalClient({ dataset: { ...READY_DATASET, status } });
  const result = await removeDatasetWithStorage({ supabase: client.supabase, datasetId: DATASET_ID });
  assert.equal(result.profilesDeleted, 2);
  assert.equal(result.imageRowsDeleted, 3);
  assert.equal(result.storageObjectsDeleted, 3);
  assert.deepEqual(client.calls.rpc.map(({ name }) => name), [
    'prepare_dataset_deletion',
    'delete_prepared_dataset',
  ]);
  assert.equal(client.calls.buckets[0], 'profile-images');
  assert.equal(client.calls.removed.every((path) => path.startsWith('fall-2026/')), true);
  assert.equal(client.calls.removed.some((path) => path.startsWith('spring-2026/')), false);
}

const activeClient = removalClient({ prepareError: { message: 'The active dataset cannot be removed. Activate another dataset first.' } });
await assert.rejects(
  removeDatasetWithStorage({ supabase: activeClient.supabase, datasetId: DATASET_ID }),
  (error) => error instanceof DatasetRemovalError && error.status === 409 && error.category === 'active_dataset',
);
assert.equal(activeClient.calls.listed.length, 0, 'active datasets must be rejected before Storage is listed');

const invalidClient = removalClient();
await assert.rejects(
  removeDatasetWithStorage({ supabase: invalidClient.supabase, datasetId: 'not-a-uuid' }),
  (error) => error.status === 400 && error.category === 'invalid_dataset_id',
);
assert.equal(invalidClient.calls.rpc.length, 0);

const replayClient = removalClient({ prepareError: { message: 'Dataset not found.' } });
await assert.rejects(
  removeDatasetWithStorage({ supabase: replayClient.supabase, datasetId: DATASET_ID }),
  (error) => error.status === 404 && error.category === 'dataset_not_found',
);

const storageFailureClient = removalClient({ removeError: { message: 'simulated Storage outage' } });
await assert.rejects(
  removeDatasetWithStorage({ supabase: storageFailureClient.supabase, datasetId: DATASET_ID }),
  (error) => error.status === 502 && error.category === 'storage_remove_failed',
);
assert.deepEqual(storageFailureClient.calls.rpc.map(({ name }) => name), ['prepare_dataset_deletion']);
assert.equal(storageFailureClient.calls.rpc.some(({ name }) => name === 'delete_prepared_dataset'), false, 'database deletion must not run after Storage failure');

const listingFailureClient = removalClient({ listError: { message: 'simulated listing outage' } });
await assert.rejects(
  removeDatasetWithStorage({ supabase: listingFailureClient.supabase, datasetId: DATASET_ID }),
  (error) => error.status === 502 && error.category === 'storage_list_failed',
);
assert.deepEqual(listingFailureClient.calls.rpc.map(({ name }) => name), [
  'prepare_dataset_deletion',
  'cancel_dataset_deletion',
], 'a listing failure releases the lease because no object deletion started');

const finalizeFailureClient = removalClient({ finalizeError: { message: 'simulated database outage' } });
await assert.rejects(
  removeDatasetWithStorage({ supabase: finalizeFailureClient.supabase, datasetId: DATASET_ID }),
  (error) => error.status === 502 && error.category === 'database_delete_failed' && /Retry Remove Semester/.test(error.message),
);
assert.equal(finalizeFailureClient.calls.rpc.some(({ name }) => name === 'cancel_dataset_deletion'), false, 'a failed final delete keeps the lease so a retry can finish safely');

const migration = await readFile(new URL('../supabase/migrations/202609010001_dataset_removal.sql', import.meta.url), 'utf8');
const datasetSchema = await readFile(new URL('../supabase/migrations/202608150001_ace_discover_v4_datasets.sql', import.meta.url), 'utf8');
const imageSchema = await readFile(new URL('../supabase/migrations/202608200002_profile_images.sql', import.meta.url), 'utf8');
assert.match(migration, /deletion_pending boolean not null default false/);
assert.match(migration, /prepare_dataset_deletion[\s\S]*target\.status = 'active'[\s\S]*active_dataset_id = target\.id/);
assert.match(migration, /delete_prepared_dataset[\s\S]*delete from public\.datasets where id = target\.id/);
assert.match(migration, /grant execute on function public\.prepare_dataset_deletion\(uuid\) to service_role/);
assert.match(migration, /revoke all on function public\.delete_prepared_dataset\(uuid\) from public, anon, authenticated/);
assert.match(datasetSchema, /dataset_id uuid not null references public\.datasets\(id\) on delete cascade/);
assert.match(imageSchema, /references public\.dataset_profiles\(dataset_id, profile_id\)[\s\S]*on delete cascade/);

const route = await readFile(new URL('../app/api/admin/datasets/[datasetId]/route.js', import.meta.url), 'utf8');
assert.match(route, /export async function DELETE/);
assert.match(route, /authorizeAdminRequest\(request\)/, 'dataset deletion must use the existing Admin authorization and trusted-origin guard');
assert.match(route, /removeAdminDataset\(datasetId\)/);

const manager = await readFile(new URL('../components/DatasetManager.js', import.meta.url), 'utf8');
assert.match(manager, /Add Semester/);
assert.match(manager, /Analyze workbook/, 'Add Semester must reuse the existing workbook analysis flow');
assert.match(manager, /Remove Semester/);
assert.match(manager, /removeConfirmation !== removeTarget\.name/, 'destructive removal must require the exact dataset name');
assert.match(manager, /dataset\.status === 'active'/, 'the active dataset remove control must be disabled');
assert.match(manager, /api\/admin\/datasets\/\$\{encodeURIComponent\(removeTarget\.id\)\}/, 'the client must delete by dataset ID, not slug');

const saveMigration = await readFile(new URL('../supabase/migrations/202608150002_ace_discover_v4_hardening.sql', import.meta.url), 'utf8');
assert.match(saveMigration, /A dataset with slug % already exists/, 'duplicate semester imports remain explicit failures');
assert.match(migration, /delete from public\.datasets/, 'after confirmed deletion the unique semester slug can be reused');

console.log('Dataset removal safety, Storage isolation, authorization, cascade, failure, and Add Semester tests passed.');
