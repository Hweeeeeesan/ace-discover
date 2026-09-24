import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202609240001_profile_public_visibility.sql', import.meta.url), 'utf8');
const publicSource = await readFile(new URL('../lib/datasets/public.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
const adminRoute = await readFile(new URL('../app/api/admin/datasets/profile-visibility/route.js', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../components/AdminProfileEditor.js', import.meta.url), 'utf8');
const profileRoute = await readFile(new URL('../app/profile/[id]/[profileId]/page.js', import.meta.url), 'utf8');
const adminPreview = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');

assert.match(migration, /add column if not exists public_hidden boolean not null default false/);
assert.match(migration, /dataset_profiles_public_visibility_idx/);
assert.match(migration, /set_profile_public_visibility\([\s\S]*requested_dataset_id uuid[\s\S]*requested_profile_id text[\s\S]*requested_hidden boolean/);
assert.match(migration, /where dataset_id = requested_dataset_id[\s\S]*and profile_id = requested_profile_id/);
assert.match(migration, /grant execute on function public\.set_profile_public_visibility\(uuid, text, boolean\) to service_role/);
assert.doesNotMatch(migration, /delete from public\.(dataset_profiles|profile_images)/);
assert.doesNotMatch(migration, /storage\.(objects|from)|\.remove\(/);

const publicRpcSections = [
  migration.match(/create or replace function public\.get_active_dataset\(\)[\s\S]*?\$\$;/)?.[0],
  migration.match(/create or replace function public\.get_published_profile\([\s\S]*?\$\$;/)?.[0],
];
for (const section of publicRpcSections) {
  assert.ok(section, 'visibility migration must redefine each public profile RPC');
  assert.match(section, /not dp\.public_hidden/);
}
assert.match(migration, /visible_dp\.dataset_id = d\.id[\s\S]*not visible_dp\.public_hidden/);
assert.match(migration, /create or replace function public\.is_allowed_drive_source[\s\S]*not dp\.public_hidden/);

assert.match(publicSource, /rpc\('get_active_dataset'\)/);
assert.match(publicSource, /rpc\('get_published_profile'/);
assert.match(profileRoute, /if \(!result\) notFound\(\)/);
assert.match(adminPreview, /getAdminDatasetProfile/);
assert.match(adminPreview, /publicHidden: result\.publicHidden/);

assert.match(adminRoute, /authorizeAdminRequest\(request\)/);
assert.match(adminRoute, /typeof hidden !== 'boolean'/);
assert.match(adminRoute, /setAdminProfilePublicVisibility/);
assert.match(adminRoute, /revalidatePath\('\/', 'layout'\)/);
assert.match(adminRoute, /revalidatePath\(`\/profile/);
assert.match(adminRoute, /revalidatePath\(`\/admin`\)/);
assert.match(adminRoute, /revalidatePath\(`\/admin\/preview/);
assert.match(adminSource, /setAdminProfilePublicVisibility/);
assert.match(adminSource, /public_hidden/);
assert.match(editorSource, /window\.confirm/);
assert.match(editorSource, /Hide from public/);
assert.match(editorSource, /Restore to public/);
assert.match(editorSource, /publicHidden/);

for (const protectedId of ['mandy-lau', 'mandy-lau-2', 'khoa-nguyen', 'khoa-nguyen-2']) {
  assert.doesNotMatch(migration, new RegExp(`profile_id\\s*=\\s*'${protectedId}'`), 'visibility must remain generic and never target names');
  assert.doesNotMatch(adminRoute, new RegExp(protectedId), 'Admin mutation must remain generic and never target names');
}

console.log('Profile visibility schema, public filtering, Admin authorization, preservation, and cache invalidation tests passed.');
