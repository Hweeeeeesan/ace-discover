#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adminOAuthRedirect } from '../lib/admin/oauth.js';
import { safeAdminRedirect } from '../lib/admin/redirects.js';

assert.equal(
  adminOAuthRedirect('http://localhost:3000'),
  'http://localhost:3000/auth/callback?next=/admin',
);
assert.equal(
  adminOAuthRedirect('https://ace-discover.vercel.app'),
  'https://ace-discover.vercel.app/auth/callback?next=/admin',
);
for (const invalidOrigin of [
  '',
  'javascript:alert(1)',
  '//evil.example',
  'https://evil.example/path',
  'https://evil.example\\admin',
]) assert.throws(() => adminOAuthRedirect(invalidOrigin));

assert.equal(safeAdminRedirect('/admin'), '/admin');
assert.equal(safeAdminRedirect('/admin?auth=1'), '/admin?auth=1');
for (const invalidNext of [
  'https://evil.example/admin',
  '//evil.example/admin',
  '/\\evil.example',
  '/profile/not-admin',
  'javascript:alert(1)',
]) assert.equal(safeAdminRedirect(invalidNext), '/admin');

const adminAuthSource = await readFile(new URL('../components/AdminAuth.js', import.meta.url), 'utf8');
assert.match(adminAuthSource, /adminOAuthRedirect\(window\.location\.origin\)/);
assert.doesNotMatch(adminAuthSource, /ACE_APP_ORIGIN|SUPABASE_SITE_URL/);
const callbackSource = await readFile(new URL('../app/auth/callback/route.js', import.meta.url), 'utf8');
assert.match(callbackSource, /safeAdminRedirect\(url\.searchParams\.get\('next'\)\)/);
assert.match(callbackSource, /new URL\(next, url\.origin\)/);

console.log('Admin OAuth origin construction and callback redirect security tests passed.');
