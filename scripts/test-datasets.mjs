import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateAdminWriteAccess } from '../lib/admin/guard.js';
import { safeAdminRedirect } from '../lib/admin/redirects.js';
import { roleForEmail } from '../lib/admin/roles.js';
import { datasetDiscoveryKey, datasetSeenKey, discoveryProfile, profilePath } from '../lib/datasets/model.js';
import {
  MAX_UPLOAD_REQUEST_BYTES,
  MAX_WORKBOOK_BYTES,
  uploadRequestTooLarge,
  validateWorkbookFile,
} from '../lib/import/limits.js';
import { profiles } from '../lib/profiles.js';
import { markProfileSeen, readSeenIds } from '../lib/seen-profiles.js';

const env = {
  ACE_OWNER_EMAIL: 'hieusondang@gmail.com',
  ACE_ADMIN_EMAILS: 'hieuson.dang@sjsu.edu,acecommittee.sjsuvsa@gmail.com',
};
assert.equal(roleForEmail('HIEUSONDANG@gmail.com', env), 'owner');
assert.equal(roleForEmail('hieuson.dang@sjsu.edu', env), 'admin');
assert.equal(roleForEmail('acecommittee.sjsuvsa@gmail.com', env), 'admin');
assert.equal(roleForEmail('someone@example.com', env), null);

const requestUrl = 'https://discover.example/api/admin/datasets/save';
const trustedOriginEnv = { NODE_ENV: 'production', ACE_APP_ORIGIN: 'https://discover.example' };
assert.equal(evaluateAdminWriteAccess({ state: 'unauthenticated' }, requestUrl).status, 401);
assert.equal(evaluateAdminWriteAccess({ state: 'denied' }, requestUrl).status, 403);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized', role: 'admin' }, requestUrl, '', trustedOriginEnv).status, 403);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized', role: 'admin' }, requestUrl, 'not an origin', trustedOriginEnv).status, 403);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized' }, requestUrl, 'https://evil.example', trustedOriginEnv).status, 403);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized', role: 'admin' }, requestUrl, 'https://discover.example', trustedOriginEnv).ok, true);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized', role: 'owner' }, requestUrl, 'https://discover.example', trustedOriginEnv).ok, true);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized' }, requestUrl, 'https://discover.example', { NODE_ENV: 'production' }).status, 403);
assert.equal(evaluateAdminWriteAccess({ state: 'authorized' }, requestUrl, 'https://discover.example', { NODE_ENV: 'development' }).ok, true);

assert.equal(safeAdminRedirect('/admin'), '/admin');
assert.equal(safeAdminRedirect('/admin?dataset=abc'), '/admin?dataset=abc');
assert.equal(safeAdminRedirect('/admin/preview/dataset/profile'), '/admin/preview/dataset/profile');
for (const attack of [
  '//evil.example',
  '/\\evil.example',
  '/admin\\@evil.example',
  'https://evil.example/admin',
  'javascript:alert(1)',
  '/administrator',
  'http://[',
  '\u0000/admin',
]) assert.equal(safeAdminRedirect(attack), '/admin', `unsafe redirect must be rejected: ${JSON.stringify(attack)}`);

assert.equal(profiles.length, 210, 'Fall 2025 must remain available as the 210-profile fallback');
assert.equal(profilePath('fall-2025', 'same-person'), '/profile/fall-2025/same-person');
assert.notEqual(profilePath('fall-2025', 'same-person'), profilePath('spring-2026', 'same-person'));
assert.notEqual(datasetSeenKey('fall-2025'), datasetSeenKey('spring-2026'));
assert.notEqual(datasetDiscoveryKey('fall-2025'), datasetDiscoveryKey('spring-2026'));
const bulkProfile = discoveryProfile({ id: 'example', name: 'Example', instagram: 'https://instagram.com/private-handle/' });
assert.equal('instagram' in bulkProfile, false, 'bulk discovery records must not contain Instagram');
const detailProfile = profiles.find((profile) => profile.instagram);
assert.match(detailProfile.instagram, /^https:\/\/www\.instagram\.com\//, 'single-profile detail data retains canonical Instagram');

const validFile = {
  name: 'semester.xlsx',
  size: MAX_WORKBOOK_BYTES,
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  async arrayBuffer() { return new ArrayBuffer(0); },
};
assert.equal(validateWorkbookFile(validFile), '');
assert.match(validateWorkbookFile({ ...validFile, size: MAX_WORKBOOK_BYTES + 1 }), /15 MiB/);
assert.equal(uploadRequestTooLarge(String(MAX_UPLOAD_REQUEST_BYTES)), false);
assert.equal(uploadRequestTooLarge(String(MAX_UPLOAD_REQUEST_BYTES + 1)), true);

const memoryStorage = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, value); },
  removeItem(key) { this.values.delete(key); },
};
markProfileSeen('shared-id', 'fall-2025', memoryStorage);
assert.deepEqual(readSeenIds('fall-2025', memoryStorage), ['shared-id']);
assert.deepEqual(readSeenIds('spring-2026', memoryStorage), []);

const migration = await readFile(new URL('../supabase/migrations/202608150001_ace_discover_v4_datasets.sql', import.meta.url), 'utf8');
const hardeningMigration = await readFile(new URL('../supabase/migrations/202608150002_ace_discover_v4_hardening.sql', import.meta.url), 'utf8');
const serviceRoleGrantsMigration = await readFile(new URL('../supabase/migrations/202608160001_ace_discover_v4_service_role_grants.sql', import.meta.url), 'utf8');
assert.match(migration, /datasets_one_active_idx[\s\S]*where status = 'active'/);
assert.match(migration, /draft\.slug, draft\.name, draft\.term, draft\.year, 'ready',[\s\S]*draft\.profile_count, draft\.health, draft\.safe_issues/);
assert.match(migration, /update public\.datasets[\s\S]*status = 'archived'[\s\S]*update public\.datasets[\s\S]*status = 'active'/);
assert.match(migration, /d\.activated_at is not null/);
assert.match(migration, /enable row level security/);
assert.match(migration, /grant execute on function public\.get_active_dataset\(\) to anon, authenticated/);
assert.match(migration, /grant execute on function public\.save_dataset_import\(uuid, uuid\) to service_role/);
assert.equal((hardeningMigration.match(/jsonb_agg\(dp\.public_data - 'instagram'/g) || []).length, 2, 'both anonymous bulk RPCs must remove Instagram');
assert.match(hardeningMigration, /get_published_profile[\s\S]*'profile', dp\.public_data/);
assert.match(hardeningMigration, /get_published_profile[\s\S]*from public\.app_settings[\s\S]*d\.status = 'active'/);
assert.match(hardeningMigration, /get_published_dataset[\s\S]*d\.status = 'active'[\s\S]*d\.slug = requested_slug/);
assert.doesNotMatch(hardeningMigration, /d\.activated_at is not null/);
assert.match(hardeningMigration, /cleanup_expired_dataset_imports[\s\S]*delete from public\.dataset_imports where expires_at <= now\(\)/);
assert.match(hardeningMigration, /save_dataset_import[\s\S]*delete from public\.dataset_imports where expires_at <= now\(\)/);
assert.match(hardeningMigration, /activate_dataset[\s\S]*public\.app_settings where singleton for update[\s\S]*profile count does not match/i);
assert.match(hardeningMigration, /set_dataset_status[\s\S]*public\.app_settings where singleton for update[\s\S]*live dataset cannot change status/i);
assert.match(hardeningMigration, /seed_fall_2025_dataset[\s\S]*jsonb_array_length\(seed_profiles\) <> 210[\s\S]*stored_count <> 210[\s\S]*status = 'active'/);
assert.match(hardeningMigration, /grant execute on function public\.get_published_profile\(text, text\) to anon, authenticated/);
assert.match(hardeningMigration, /grant execute on function public\.seed_fall_2025_dataset\(jsonb, jsonb, jsonb\) to service_role/);
assert.match(serviceRoleGrantsMigration, /begin;[\s\S]*commit;\s*$/);
assert.match(serviceRoleGrantsMigration, /grant select on table public\.datasets to service_role/);
assert.match(serviceRoleGrantsMigration, /grant select on table public\.dataset_profiles to service_role/);
assert.match(serviceRoleGrantsMigration, /grant select, insert on table public\.dataset_imports to service_role/);
assert.doesNotMatch(serviceRoleGrantsMigration, /grant (?:all|insert|update|delete|select,\s*insert,\s*update,\s*delete) on table public\.app_settings to service_role/i);
assert.doesNotMatch(serviceRoleGrantsMigration, /public\.profiles/);
for (const table of ['datasets', 'dataset_profiles', 'app_settings', 'dataset_imports']) {
  assert.match(serviceRoleGrantsMigration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`));
}
for (const signature of [
  'cleanup_expired_dataset_imports\\(\\)',
  'save_dataset_import\\(uuid, uuid\\)',
  'activate_dataset\\(uuid\\)',
  'set_dataset_status\\(uuid, text\\)',
  'seed_fall_2025_dataset\\(jsonb, jsonb, jsonb\\)',
]) {
  assert.match(serviceRoleGrantsMigration, new RegExp(`grant execute on function public\\.${signature} to service_role`));
}
assert.doesNotMatch(serviceRoleGrantsMigration, /ALL ON ALL TABLES/i);

for (const route of ['analyze', 'save', 'activate', 'status']) {
  const source = await readFile(new URL(`../app/api/admin/datasets/${route}/route.js`, import.meta.url), 'utf8');
  assert.match(source, /authorizeAdminRequest\(request\)/, `${route} must verify the server-side session`);
}

const homeSource = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(homeSource, /getActiveDataset/);

const publicDatasetSource = await readFile(new URL('../lib/datasets/public.js', import.meta.url), 'utf8');
assert.match(publicDatasetSource, /profiles: resolveProfileImages\(payload\.profiles\.map\(discoveryProfile\)\)/);
assert.match(publicDatasetSource, /rpc\('get_published_profile'/);
assert.match(publicDatasetSource, /active\.slug !== datasetSlug/);
assert.match(publicDatasetSource, /return unavailableDataset\(\)/, 'configured database failures must not expose fallback profiles');

const analyzeRouteSource = await readFile(new URL('../app/api/admin/datasets/analyze/route.js', import.meta.url), 'utf8');
assert.match(analyzeRouteSource, /uploadRequestTooLarge\(request\.headers\.get\('content-length'\)\)/);
assert.match(analyzeRouteSource, /workbook\?\.size > MAX_WORKBOOK_BYTES/);

const seedSource = await readFile(new URL('../scripts/seed-fall-2025.mjs', import.meta.url), 'utf8');
assert.match(seedSource, /rpc\('seed_fall_2025_dataset'/);
assert.match(seedSource, /storedRows\?\.length !== 210/);
assert.match(seedSource, /expectedIds[\s\S]*storedIds/);

const previewSource = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');
assert.match(previewSource, /getAdminIdentity\(\)/);
assert.match(previewSource, /identity\.state !== 'authorized'/);
assert.match(previewSource, /getAdminDatasetProfile/);
const previewListSource = await readFile(new URL('../app/admin/preview/[datasetId]/page.js', import.meta.url), 'utf8');
assert.match(previewListSource, /getAdminIdentity\(\)/);
assert.match(previewListSource, /identity\.state !== 'authorized'/);
assert.match(previewListSource, /getAdminDatasetProfileList/);

const nextConfigSource = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8');
assert.match(nextConfigSource, /proxyClientMaxBodySize: '16mb'/);

console.log('Admin authorization, privacy boundaries, dataset integrity, upload limits, and routing tests passed.');
