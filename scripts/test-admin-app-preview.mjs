import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ADMIN_PREVIEW_DEVICES,
  DEFAULT_ADMIN_PREVIEW_DEVICE,
  DEFAULT_ADMIN_PREVIEW_PATH,
  safePublicPreviewPath,
} from '../lib/admin/app-preview.js';

const origin = 'http://localhost:3000';
assert.equal(DEFAULT_ADMIN_PREVIEW_DEVICE, 'desktop');
assert.deepEqual(ADMIN_PREVIEW_DEVICES.desktop, { width: 1440, height: 900, label: '1440 × 900' });
assert.deepEqual(ADMIN_PREVIEW_DEVICES.mobile, { width: 390, height: 844, label: '390 × 844' });
assert.equal(DEFAULT_ADMIN_PREVIEW_PATH, '/');

assert.equal(safePublicPreviewPath('/', origin), '/');
assert.equal(safePublicPreviewPath('/?role=Little#results', origin), '/?role=Little#results');
assert.equal(safePublicPreviewPath('/profile/hazel-tran?from=discovery', origin), '/profile/hazel-tran?from=discovery');
assert.equal(safePublicPreviewPath('/profile/fall-2025/hazel-tran', origin), '/profile/fall-2025/hazel-tran');
for (const unsafeUrl of [
  'https://evil.example/',
  '//evil.example/profile/hazel-tran',
  'javascript:alert(1)',
  '/admin',
  '/admin/preview/dataset',
  'http://[',
]) assert.equal(safePublicPreviewPath(unsafeUrl, origin), '/', `unsafe preview URL accepted: ${unsafeUrl}`);

const componentSource = await readFile(new URL('../components/AdminAppPreview.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../app/admin/page.js', import.meta.url), 'utf8');
const publicHomeSource = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
const publicDetailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const nextConfigSource = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8');

assert.match(adminSource, /identity\.state === 'unconfigured' \|\| identity\.state === 'unauthenticated'[\s\S]*identity\.state === 'denied'[\s\S]*<AdminAppPreview \/>/, 'preview must render only after Admin authorization checks');
assert.doesNotMatch(publicHomeSource, /AdminAppPreview|admin-preview-device-toggle/);
assert.doesNotMatch(publicDetailSource, /AdminAppPreview|admin-preview-device-toggle/);

assert.match(componentSource, /<iframe/);
assert.match(componentSource, /src=\{DEFAULT_ADMIN_PREVIEW_PATH\}/, 'iframe source must be the current-origin public root');
assert.doesNotMatch(componentSource, /https?:\/\//, 'preview component must not contain a hard-coded origin');
assert.match(componentSource, /width=\{viewport\.width\}/);
assert.match(componentSource, /height=\{viewport\.height\}/);
assert.match(componentSource, /onClick=\{\(\) => setDevice\('desktop'\)\}/);
assert.match(componentSource, /onClick=\{\(\) => setDevice\('mobile'\)\}/);
assert.doesNotMatch(componentSource, /key=\{device\}/, 'device switches must preserve the iframe document and route');
assert.match(componentSource, /contentWindow\?\.location\.reload\(\)/);
assert.match(componentSource, /window\.setInterval\(rememberCurrentRoute, 400\)/, 'client-side iframe navigation must update the current route');
assert.doesNotMatch(componentSource, /fetch\(|localStorage|sessionStorage/, 'preview controls must not mutate app or dataset state');
assert.match(componentSource, /sandbox="(?=[^"]*allow-same-origin)(?=[^"]*allow-scripts)(?=[^"]*allow-forms)(?![^"]*allow-top-navigation)[^"]*"/, 'iframe must be interactive without gaining top-level navigation');
assert.doesNotMatch(componentSource, /scrolling="no"/);
assert.match(cssSource, /\.admin-app-preview-stage \{[^}]*overflow: auto;/);
assert.match(cssSource, /\.admin-app-preview-frame \{[^}]*transform-origin: top left;/);

assert.match(nextConfigSource, /Content-Security-Policy', value: "frame-ancestors 'self'"/);
assert.match(nextConfigSource, /X-Frame-Options', value: 'SAMEORIGIN'/);
assert.doesNotMatch(nextConfigSource, /frame-ancestors \*/);

console.log('Admin interactive app preview viewport, navigation, isolation, and frame-policy tests passed.');
