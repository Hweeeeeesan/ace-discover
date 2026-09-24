import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDiscoveryRefreshCoordinator,
  discoveryNavigationMarkerId,
} from '../lib/discovery-refresh.js';

const feedSource = await readFile(new URL('../components/DiscoveryFeed.js', import.meta.url), 'utf8');
const cardSource = await readFile(new URL('../components/ProfileCard.js', import.meta.url), 'utf8');
const imageSource = await readFile(new URL('../components/ProfileImage.js', import.meta.url), 'utf8');

const tasks = [];
const refreshes = [];
const consumed = [];
const marker = { profileId: 'logan-ho', at: 1720000000000, nonce: 'return-1' };
const coordinator = createDiscoveryRefreshCoordinator({
  refresh: (reason) => refreshes.push(reason),
  consumeReturnMarker: (value) => consumed.push(value),
  queueTask: (task) => tasks.push(task),
});

assert.equal(discoveryNavigationMarkerId(marker), 'return-1');
assert.equal(discoveryNavigationMarkerId({ profileId: 'logan-ho', at: marker.at }), `logan-ho:${marker.at}`);
assert.equal(discoveryNavigationMarkerId(null), '');

assert.equal(coordinator.requestReturnRefresh(marker), true, 'return should queue a refresh');
assert.equal(coordinator.requestReturnRefresh(marker), false, 'same marker should not queue twice');
assert.equal(coordinator.requestResumeRefresh('focus', { persisted: true }), false, 'resume should coalesce while queued');
assert.equal(refreshes.length, 0, 'queued work should not run before the task flush');
assert.equal(tasks.length, 1);
tasks.shift()();
assert.deepEqual(refreshes, ['profile-return']);
assert.deepEqual(consumed, [marker], 'marker is consumed only after refresh scheduling');

assert.equal(coordinator.requestResumeRefresh('focus', { persisted: true }), false, 'same resume cycle must not refresh again');
coordinator.settle();
coordinator.markInactive();
assert.equal(coordinator.requestResumeRefresh('visibilitychange'), true, 'a later inactive/resume cycle can refresh');
assert.equal(coordinator.requestResumeRefresh('focus'), false, 'events while refresh is queued must coalesce');
tasks.shift()();
assert.equal(coordinator.requestResumeRefresh('pageshow', { persisted: true }), false, 'events while refresh is in flight must coalesce');
assert.deepEqual(refreshes, ['profile-return', 'visibilitychange']);
coordinator.settle();
assert.equal(coordinator.requestReturnRefresh(marker), false, 'a consumed marker cannot trigger again');

coordinator.markInactive();
assert.equal(coordinator.requestResumeRefresh('pageshow', { persisted: true }), true);
assert.equal(coordinator.requestResumeRefresh('focus'), false);
assert.equal(coordinator.requestResumeRefresh('visibilitychange'), false);
tasks.shift()();
assert.deepEqual(refreshes, ['profile-return', 'visibilitychange', 'pageshow']);

const legacyTasks = [];
const legacyRefreshes = [];
const legacyCoordinator = createDiscoveryRefreshCoordinator({
  refresh: () => legacyRefreshes.push(true),
  queueTask: (task) => legacyTasks.push(task),
});
const legacyMarker = { profileId: 'ivy-ngo', at: 1720000000001 };
assert.equal(legacyCoordinator.requestReturnRefresh(legacyMarker), true);
legacyTasks.shift()();
assert.equal(legacyRefreshes.length, 1, 'legacy markers remain readable during rollout');

assert.match(feedSource, /createDiscoveryRefreshCoordinator/);
assert.match(feedSource, /requestReturnRefresh\(navigation\)/);
assert.match(feedSource, /requestResumeRefresh\('pageshow', \{ persisted: true \}\)/);
assert.match(feedSource, /window\.sessionStorage\.removeItem\(key\)/);
assert.match(feedSource, /nonce:/);
assert.match(feedSource, /key=\{profile\.id\}/);
assert.match(cardSource, /onOpenProfile\?\.\(profile\.id\)/);
assert.match(imageSource, /src=\{imageSrc\}/);
assert.match(imageSource, /referrerPolicy="no-referrer"/);
assert.doesNotMatch(imageSource, /Date\.now\(\)|Math\.random\(\)/, 'image URLs must not be cache-busted');

console.log('Discovery refresh lifecycle tests passed.');
