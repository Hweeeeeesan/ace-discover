import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildPublicOverridePatch,
  publicOverrideFields,
  resolveEffectivePublicProfile,
  validatePublicOverrides,
} from '../lib/profile-overrides.js';

const imported = {
  id: 'hazel-tran', name: 'Hazel Tran', role: 'Little', major: 'Nutrition',
  passion: 'Crafts', vibes: ['Photography', 'Creative'], phone: 'private',
};

assert.equal(resolveEffectivePublicProfile(imported, {}).major, 'Nutrition');
assert.equal(resolveEffectivePublicProfile(imported, { major: 'Nutritional Science — Dietetics' }).major, 'Nutritional Science — Dietetics');
assert.equal(resolveEffectivePublicProfile(imported, { passion: '' }).passion, '');
assert.deepEqual(resolveEffectivePublicProfile(imported, { vibes: [] }).vibes, []);
assert.deepEqual(publicOverrideFields({ major: 'Edited', vibes: [] }), ['major', 'vibes']);

const currentOverrides = { major: 'Edited', passion: 'Edited passion', vibes: ['Music'] };
assert.deepEqual(
  buildPublicOverridePatch(imported, currentOverrides, {
    major: 'Nutrition', passion: 'Edited passion', vibes: ['Music'], name: 'Hazel Tran',
  }),
  { passion: 'Edited passion', vibes: ['Music'] },
  'resetting major removes the override instead of copying imported data',
);
assert.deepEqual(
  buildPublicOverridePatch(imported, currentOverrides, {
    major: 'Edited', passion: '', vibes: ['Music'], name: 'Hazel Tran',
  }),
  { major: 'Edited', passion: '', vibes: ['Music'] },
  'explicit empty text remains an override',
);
assert.equal(validatePublicOverrides({ instagram: '@hazel.tran' }).instagram, 'https://www.instagram.com/hazel.tran/');
assert.deepEqual(validatePublicOverrides({ hobbies: 'Line one\nLine two' }).hobbies, 'Line one\nLine two');
assert.throws(() => validatePublicOverrides({ phone: 'private' }), /cannot be overridden/);
assert.throws(() => validatePublicOverrides({ unknown: 'value' }), /cannot be overridden/);
assert.throws(() => validatePublicOverrides(JSON.parse('{"__proto__":"value"}')), /cannot be overridden/);
assert.throws(() => validatePublicOverrides({ vibes: ['Not a vibe'] }), /Invalid vibe/);
assert.throws(() => validatePublicOverrides({ vibes: ['Music', 'Music'] }), /duplicates/);
assert.throws(() => validatePublicOverrides({ vibes: ['Foodie', 'Outdoors', 'Gaming', 'Music', 'Creative', 'Anime'] }), /at most 5/);
assert.throws(() => validatePublicOverrides({ major: 'x'.repeat(241) }), /length limit/);

const migration = await readFile(new URL('../supabase/migrations/202609100001_public_profile_overrides.sql', import.meta.url), 'utf8');
const adminRoute = await readFile(new URL('../app/api/admin/datasets/profile/route.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
const publicSource = await readFile(new URL('../lib/datasets/public.js', import.meta.url), 'utf8');
const syncSource = await readFile(new URL('../supabase/migrations/202609040001_google_sheet_sync.sql', import.meta.url), 'utf8');
const editor = await readFile(new URL('../components/AdminProfileEditor.js', import.meta.url), 'utf8');

assert.match(migration, /add column if not exists public_overrides jsonb not null default '\{\}'::jsonb/);
assert.match(migration, /update_profile_public_overrides/);
assert.match(migration, /target\.public_overrides_updated_at is distinct from expected_updated_at/);
assert.match(migration, /resolve_effective_public_data\(dp\.public_data, dp\.public_overrides\)/);
assert.doesNotMatch(syncSource, /public_overrides\s*=/, 'source sync must not erase overrides');
assert.match(adminRoute, /authorizeAdminRequest\(request\)/);
assert.match(adminRoute, /buildPublicOverridePatch/);
assert.match(adminRoute, /status: conflict \? 409/);
assert.match(adminSource, /resolveEffectivePublicProfile\(importedPublicData, publicOverrides\)/);
assert.match(publicSource, /resolveEffectivePublicProfile/);
assert.match(editor, /Reset to imported/);
assert.match(editor, /Reset to automatic/);
assert.match(editor, /Automatic vibe reasoning/);
assert.doesNotMatch(editor, /profileImages|storagePath|phone|email|birthday/);

console.log('Public profile override resolver, validation, security, sync preservation, and Admin wiring tests passed.');
