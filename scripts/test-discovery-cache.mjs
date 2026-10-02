import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoveryProfile } from '../lib/datasets/model.js';
import { resolveEffectivePublicProfile } from '../lib/profile-overrides.js';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const homeSource = await readSource('../app/page.js');
const publicDatasetSource = await readSource('../lib/datasets/public.js');
const feedSource = await readSource('../components/DiscoveryFeed.js');
const revalidationSource = await readSource('../lib/datasets/revalidation.js');

assert.match(homeSource, /export const dynamic = ['"]force-static['"]/);
assert.match(homeSource, /export const revalidate = 300/);
assert.doesNotMatch(homeSource, /force-dynamic|cookies\(|headers\(|connection\(/,
  'Discovery must not opt into request-specific rendering');
assert.match(homeSource, /getActiveDataset\(\{ requireAvailable: true \}\)/,
  'ISR failures must preserve the last successful page');
assert.match(publicDatasetSource, /createSupabasePublicClient\(\)/);
assert.doesNotMatch(publicDatasetSource, /cookies\(|headers\(|getAdminIdentity|SUPABASE_SERVICE_ROLE_KEY/,
  'the cached dataset resolver must not depend on request or Admin identity');

for (const clientOnlyState of [
  /sessionStorage/,
  /readSeenIds/,
  /readSavedIds/,
  /createSeed/,
  /useState/,
]) {
  assert.match(feedSource, clientOnlyState, 'personal Discovery state must remain client-side');
}
assert.match(feedSource, /router\.refresh\(\)/,
  'the existing coalesced refresh lifecycle must remain available');
assert.match(feedSource, /createDiscoveryRefreshCoordinator/,
  'caching must not bypass the refresh coordinator');

assert.match(revalidationSource, /revalidatePath\(PUBLIC_DISCOVERY_PATH\)/);
assert.match(revalidationSource, /PUBLIC_DISCOVERY_PATH = ['"]\/['"]/);

const mutationRoutes = [
  '../app/api/admin/datasets/activate/route.js',
  '../app/api/admin/datasets/name/route.js',
  '../app/api/admin/datasets/profile/route.js',
  '../app/api/admin/datasets/profile-visibility/route.js',
  '../app/api/admin/datasets/profile-qa/route.js',
  '../app/api/admin/datasets/focal/route.js',
  '../app/api/admin/datasets/sync/apply/route.js',
  '../app/api/admin/datasets/images/route.js',
  '../app/api/admin/datasets/images/action/route.js',
  '../app/api/admin/datasets/images/import/apply/route.js',
  '../app/api/admin/datasets/images/reconcile/apply/route.js',
];
for (const route of mutationRoutes) {
  const source = await readSource(route);
  assert.match(source, /authorizeAdminRequest\(request\)/, `${route} must remain Admin-only`);
  assert.match(source, /revalidatePublicDiscovery\(\)/, `${route} must invalidate Discovery`);
}

for (const adminPage of [
  '../app/admin/page.js',
  '../app/admin/preview/[datasetId]/page.js',
  '../app/admin/preview/[datasetId]/[profileId]/page.js',
]) {
  const source = await readSource(adminPage);
  assert.match(source, /export const dynamic = ['"]force-dynamic['"]/,
    `${adminPage} must remain uncached`);
  assert.match(source, /getAdminIdentity\(\)/,
    `${adminPage} must remain authenticated`);
}

const fixture = {
  id: 'cache-fixture',
  name: 'Cache Fixture',
  major: 'Computer Science',
  hobbies: 'Photography',
  instagram: 'https://www.instagram.com/private/',
  bio: 'private profile story',
  story: 'private source story',
};
const first = discoveryProfile(resolveEffectivePublicProfile(fixture));
const second = discoveryProfile(resolveEffectivePublicProfile(fixture));
assert.deepEqual(second, first, 'repeated public resolution must be deterministic');
for (const privateField of ['instagram', 'bio', 'story']) {
  assert.equal(privateField in first, false, `${privateField} must stay out of cached Discovery output`);
}
assert.equal(JSON.stringify(first).includes('private profile story'), false);
assert.equal(JSON.stringify(first).includes('private source story'), false);

const profileImageResolverSql = await readSource('../supabase/migrations/202609220001_profile_detail_image_derivatives.sql');
assert.doesNotMatch(
  profileImageResolverSql.match(/jsonb_build_object\(\s*'id', pi\.id,[\s\S]*?'displayMode', pi\.display_mode\s*\)/)?.[0] || '',
  /source_drive|source_type|source_filename/,
  'public image JSON must not expose Drive provenance',
);

console.log('Discovery ISR, invalidation, privacy, and Admin cache-boundary tests passed.');
