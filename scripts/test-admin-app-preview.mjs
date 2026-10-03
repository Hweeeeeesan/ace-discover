import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ADMIN_PREVIEW_DEVICES,
  DEFAULT_ADMIN_PREVIEW_DEVICE,
  DEFAULT_ADMIN_PREVIEW_PATH,
  safePublicPreviewPath,
} from '../lib/admin/app-preview.js';
import {
  adminProfileListPath,
  adminProfileListScrollKey,
  adminProfilePreviewPath,
  createAdminProfileReturnMarker,
  isValidAdminProfileReturnMarker,
  safeAdminProfileListReturn,
} from '../lib/admin/profile-navigation.js';

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

const datasetId = '124ea5be-f203-4667-8102-caeb3f1f65b0';
const otherDatasetId = 'df2eb098-df96-4139-a09e-661deeeb0a50';
const adminList = `/admin/preview/${datasetId}`;
const filteredAdminList = `${adminList}?search=Nguyen&major=Engineering`;
assert.equal(adminProfileListPath(datasetId), adminList);
assert.equal(safeAdminProfileListReturn(filteredAdminList, datasetId), filteredAdminList, 'Admin filter state must survive in the return URL');
const maintenanceReturn = `/admin?dataset=${datasetId}&imageIssue=count&imageSearch=Stan`;
assert.equal(safeAdminProfileListReturn(maintenanceReturn, datasetId), maintenanceReturn, 'Maintenance image issue state must survive profile review return');
for (const unsafeReturn of [
  'https://evil.example/admin/preview/' + datasetId,
  '//evil.example/admin/preview/' + datasetId,
  `/admin/preview/${otherDatasetId}?search=Nguyen`,
  `${adminList}/person-a`,
  '/admin',
  'javascript:alert(1)',
]) assert.equal(safeAdminProfileListReturn(unsafeReturn, datasetId), adminList, `unsafe Admin return accepted: ${unsafeReturn}`);
const profileHref = adminProfilePreviewPath({ datasetId, profileId: 'person-a', returnTo: filteredAdminList });
assert.equal(profileHref, `${adminList}/person-a?returnTo=${encodeURIComponent(filteredAdminList)}`);
assert.equal(adminProfilePreviewPath({ datasetId, profileId: 'person-a', returnTo: 'https://evil.example/' }), `${adminList}/person-a?returnTo=${encodeURIComponent(adminList)}`);
assert.equal(adminProfileListScrollKey(filteredAdminList, datasetId), `ace-admin-profile-scroll:${filteredAdminList}`);
const now = 2_000_000;
const markerA = createAdminProfileReturnMarker({ datasetId, profilePath: `${adminList}/person-a`, returnTo: filteredAdminList, createdAt: now });
assert.equal(isValidAdminProfileReturnMarker(markerA, { datasetId, profilePath: `${adminList}/person-a`, returnTo: filteredAdminList, now }), true);
assert.equal(isValidAdminProfileReturnMarker(markerA, { datasetId, profilePath: `${adminList}/person-b`, returnTo: filteredAdminList, now }), false);
assert.equal(isValidAdminProfileReturnMarker(markerA, { datasetId: otherDatasetId, profilePath: `${adminList}/person-a`, returnTo: filteredAdminList, now }), false);
assert.equal(isValidAdminProfileReturnMarker(markerA, { datasetId, profilePath: `${adminList}/person-a`, returnTo: filteredAdminList, now: now + (4 * 60 * 60 * 1000) + 1 }), false);
const markerB = createAdminProfileReturnMarker({ datasetId, profilePath: `${adminList}/person-b`, returnTo: filteredAdminList, createdAt: now + 1 });
assert.equal(isValidAdminProfileReturnMarker(markerB, { datasetId, profilePath: `${adminList}/person-b`, returnTo: filteredAdminList, now: now + 1 }), true, 'a later sequential profile review must get its own valid marker');
assert.equal(isValidAdminProfileReturnMarker(markerB, { datasetId, profilePath: `${adminList}/person-a`, returnTo: filteredAdminList, now: now + 1 }), false, 'a later review marker must not send Person A through Person B history');

const componentSource = await readFile(new URL('../components/AdminAppPreview.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../app/admin/page.js', import.meta.url), 'utf8');
const publicHomeSource = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
const publicDetailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
const adminListPageSource = await readFile(new URL('../app/admin/preview/[datasetId]/page.js', import.meta.url), 'utf8');
const adminProfilePageSource = await readFile(new URL('../app/admin/preview/[datasetId]/[profileId]/page.js', import.meta.url), 'utf8');
const adminSearchSource = await readFile(new URL('../components/AdminProfileSearch.js', import.meta.url), 'utf8');
const adminProfileLinkSource = await readFile(new URL('../components/AdminProfileLink.js', import.meta.url), 'utf8');
const adminBackSource = await readFile(new URL('../components/AdminPreviewBackButton.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const nextConfigSource = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8');

assert.match(adminSource, /identity\.state === 'unconfigured' \|\| identity\.state === 'unauthenticated'[\s\S]*identity\.state === 'denied'[\s\S]*<AdminAppPreview \/>/, 'preview must render only after Admin authorization checks');
assert.doesNotMatch(publicHomeSource, /AdminAppPreview|admin-preview-device-toggle/);
assert.doesNotMatch(publicDetailSource, /AdminAppPreview|admin-preview-device-toggle/);
assert.match(adminListPageSource, /AdminProfileListScrollRestoration/);
assert.match(adminListPageSource, /<AdminProfileLink datasetId=\{result\.dataset\.id\} profileId=\{profile\.id\}/);
assert.match(adminSource, /AdminImageDifferenceFilter[\s\S]*maintenance/);
assert.match(adminProfilePageSource, /safeAdminProfileListReturn\(query\?\.returnTo, result\.dataset\.id\)/);
assert.match(adminSearchSource, /searchParams\.get\('search'\)/);
assert.match(adminSearchSource, /searchParams\.get\('major'\)/);
assert.match(adminSearchSource, /window\.history\.replaceState\(null, '',/);
assert.match(adminSearchSource, /<AdminProfileLink datasetId=\{datasetId\} profileId=\{profile\.id\}/);
assert.match(adminProfileLinkSource, /window\.sessionStorage\.setItem/);
assert.match(adminProfileLinkSource, /window\.scrollY/);
assert.match(adminProfileLinkSource, /event\.metaKey[\s\S]*event\.ctrlKey[\s\S]*event\.shiftKey/, 'new-tab navigation must not create a false same-tab return marker');
assert.match(adminBackSource, /router\.back\(\)/, 'a proven list-to-profile navigation should pop back to the existing list entry');
assert.match(adminBackSource, /removeItem\(ADMIN_PROFILE_RETURN_MARKER_KEY\)[\s\S]*router\.back\(\)/, 'the return marker must be consumed before history navigation');
assert.match(adminBackSource, /router\.replace\(returnTo\)/, 'direct profile URLs must replace to the safe dataset list fallback');
assert.doesNotMatch(adminBackSource, /router\.push\(/, 'Admin Back must not create a profile/list history loop');
assert.match(publicDetailSource, /adminPreview[\s\S]*AdminPreviewBackButton/);
assert.match(publicDetailSource, /: <DiscoveryBackButton className="back-button"/, 'public ProfileDetail back behavior must remain unchanged');

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
