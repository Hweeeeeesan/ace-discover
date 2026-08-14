import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { profiles } from '../lib/profiles.js';
import {
  balancedShuffle,
  canonicalYear,
  filterAndOrderProfiles,
  getDiscoveryOptions,
  normalizeText,
  scoreProfile,
  sanitizeFilters,
  seededShuffle,
} from '../lib/discovery.js';
import { markProfileSeen, readSeenIds, resetSeenIds, SEEN_PROFILES_KEY } from '../lib/seen-profiles.js';

assert.equal(profiles.length, 210, 'Expected all imported profiles');
assert.equal(canonicalYear('2nd Year'), 'Second year');
assert.equal(canonicalYear('freshman'), 'First year');
assert.equal(canonicalYear('5th year'), 'Fourth year+');
assert.equal(canonicalYear('Grad student'), 'Graduate / Other');
assert.equal(normalizeText('Data Science & AI'), 'data science and ai');

const seed = 873421;
const firstOrder = balancedShuffle(profiles, seed);
const repeatedOrder = balancedShuffle(profiles, seed);
const secondOrder = balancedShuffle(profiles, seed + 1);

assert.deepEqual(
  firstOrder.map((profile) => profile.id),
  repeatedOrder.map((profile) => profile.id),
  'A seed must produce a stable order',
);
assert.notDeepEqual(
  firstOrder.slice(0, 20).map((profile) => profile.id),
  secondOrder.slice(0, 20).map((profile) => profile.id),
  'A new seed should change the discovery order',
);
assert.equal(new Set(firstOrder.map((profile) => profile.id)).size, profiles.length);

const allProfiles = filterAndOrderProfiles(profiles, {
  query: '', role: 'All', years: [], seed,
});
assert.equal(allProfiles.length, 210);

let longestRun = 1;
let currentRun = 1;
for (let index = 1; index < firstOrder.length; index += 1) {
  if (firstOrder[index].role === firstOrder[index - 1].role) currentRun += 1;
  else currentRun = 1;
  longestRun = Math.max(longestRun, currentRun);
}
assert.ok(longestRun <= 2, 'Balanced discovery should avoid role streaks longer than two');

const littles = filterAndOrderProfiles(profiles, {
  query: '', role: 'Little', years: [], seed,
});
assert.equal(littles.length, 123);
assert.ok(littles.every((profile) => profile.role === 'Little'));

const bigs = filterAndOrderProfiles(profiles, {
  query: '', role: 'Big', years: [], seed,
});
assert.equal(bigs.length, 65);
assert.ok(bigs.every((profile) => profile.role === 'Big'));

const families = filterAndOrderProfiles(profiles, {
  query: '', role: 'Family', years: [], seed,
});
assert.equal(families.length, 22);
assert.ok(families.every((profile) => profile.role === 'Family'));

const legacyDeckState = filterAndOrderProfiles(profiles, {
  query: '', role: 'All', years: [], hasDeck: true, seed,
});
assert.equal(legacyDeckState.length, 210, 'Obsolete Has Deck state must no longer filter discovery');

const seenIds = profiles.slice(0, 5).map((profile) => profile.id);
const unseen = filterAndOrderProfiles(profiles, { mode: 'Unseen', seenIds, seed });
assert.equal(unseen.length, 205);
assert.ok(unseen.every((profile) => !seenIds.includes(profile.id)));

const vibeFixture = [
  { id: 'one', role: 'Little', vibes: ['Gaming'], major: 'Computer Science', majorGroup: 'Computing & Data', year: 'First', normalizedYear: 'First year', socialLevel: 4, socialStyle: 'Introvert', bio: 'alpha anime' },
  { id: 'two', role: 'Big', vibes: ['Travel', 'Music'], major: 'MIS', majorGroup: 'Business', year: 'Third', normalizedYear: 'Third year', socialLevel: 3, socialStyle: 'Ambivert', bio: 'beta' },
  { id: 'three', role: 'Little', vibes: ['Music'], major: 'Mechanical Engineering', majorGroup: 'Engineering', year: 'First', normalizedYear: 'First year', socialLevel: null, socialStyle: '', bio: 'gamma' },
  { id: 'four', role: 'Big', vibes: ['Music'], major: 'Electrical Engineering', majorGroup: 'Engineering', year: 'Third', normalizedYear: 'Third year', socialLevel: 5, socialStyle: 'Extrovert', bio: 'delta anime' },
];
const multiVibe = filterAndOrderProfiles(vibeFixture, { mode: 'Vibes', selectedVibes: ['Gaming', 'Travel'], seed });
assert.deepEqual(new Set(multiVibe.map((profile) => profile.id)), new Set(['one', 'two']), 'Vibes use OR matching');
const roleAndVibe = filterAndOrderProfiles(vibeFixture, { mode: 'Vibes', selectedVibes: ['Gaming', 'Travel'], role: 'Little', seed });
assert.deepEqual(roleAndVibe.map((profile) => profile.id), ['one']);
const searchAndVibe = filterAndOrderProfiles(vibeFixture, { mode: 'Vibes', selectedVibes: ['Gaming', 'Travel'], query: 'beta', seed });
assert.deepEqual(searchAndVibe.map((profile) => profile.id), ['two']);

const majorFiltered = filterAndOrderProfiles(vibeFixture, { majorGroups: ['engineering'], seed });
assert.deepEqual(new Set(majorFiltered.map((profile) => profile.id)), new Set(['three', 'four']));
const multipleMajors = filterAndOrderProfiles(vibeFixture, { majorGroups: ['business', 'computing and data'], seed });
assert.deepEqual(new Set(multipleMajors.map((profile) => profile.id)), new Set(['one', 'two']));
const narrowedSocial = filterAndOrderProfiles(vibeFixture, { socialLevelMin: 3, socialLevelMax: 4, seed });
assert.deepEqual(new Set(narrowedSocial.map((profile) => profile.id)), new Set(['one', 'two']));
const defaultSocial = filterAndOrderProfiles(vibeFixture, { socialLevelMin: 1, socialLevelMax: 5, seed });
assert.equal(defaultSocial.length, vibeFixture.length, 'Missing levels remain eligible at the default range');
const styleOr = filterAndOrderProfiles(vibeFixture, { socialStyles: ['Introvert', 'Ambivert'], seed });
assert.deepEqual(new Set(styleOr.map((profile) => profile.id)), new Set(['one', 'two']));
const combinedAdvanced = filterAndOrderProfiles(vibeFixture, {
  mode: 'Vibes', selectedVibes: ['Music'],
  role: 'Big', years: ['third year'], majorGroups: ['engineering'],
  socialLevelMin: 3, socialLevelMax: 5, socialStyles: ['Extrovert'], query: 'anime', seed,
});
assert.deepEqual(combinedAdvanced.map((profile) => profile.id), ['four']);
const unseenVibeBusiness = filterAndOrderProfiles(vibeFixture, {
  mode: 'Unseen', seenIds: ['one'], selectedVibes: ['Music'],
  majorGroups: ['business'], socialStyles: ['Ambivert'], seed,
});
assert.deepEqual(unseenVibeBusiness.map((profile) => profile.id), ['two']);

const memoryStorage = {
  value: new Map(),
  getItem(key) { return this.value.get(key) ?? null; },
  setItem(key, value) { this.value.set(key, value); },
  removeItem(key) { this.value.delete(key); },
};
markProfileSeen('one', memoryStorage);
markProfileSeen('one', memoryStorage);
markProfileSeen('two', memoryStorage);
assert.deepEqual(readSeenIds(memoryStorage), ['one', 'two']);
resetSeenIds(memoryStorage);
assert.deepEqual(readSeenIds(memoryStorage), []);
assert.equal(memoryStorage.getItem(SEEN_PROFILES_KEY), null);

const ashleyResults = filterAndOrderProfiles(profiles, {
  query: 'Ashley Kiang', role: 'All', years: [], seed,
});
assert.equal(ashleyResults[0]?.id, 'ashley-kiang', 'Exact name search should rank first');
const ashley = profiles.find((profile) => profile.id === 'ashley-kiang');
assert.ok(scoreProfile(ashley, 'piano') > 0, 'Search should include hobbies and interests');

const requestedSearchFields = [
  ['name', (profile) => profile.name],
  ['major', (profile) => profile.major],
  ['year', (profile) => profile.year],
  ['interests', (profile) => profile.interests?.join(' ')],
  ['hobbies', (profile) => profile.hobbies],
  ['music', (profile) => profile.music],
  ['movies/shows', (profile) => profile.movies],
  ['bio', (profile) => profile.bio],
];

for (const [label, getValue] of requestedSearchFields) {
  const profile = profiles.find((candidate) => normalizeText(getValue(candidate)).length >= 3);
  assert.ok(profile, `Expected a profile with a searchable ${label} value`);
  assert.ok(scoreProfile(profile, getValue(profile)) >= 0, `Search should include ${label}`);
}

const secondYears = filterAndOrderProfiles(profiles, {
  query: '', role: 'All', years: ['second year'], seed,
});
assert.ok(secondYears.length > 0);
assert.ok(secondYears.every((profile) => profile.normalizedYear === 'Second year'));

const options = getDiscoveryOptions(profiles);
assert.ok(options.years.some((option) => option.label === 'Second year'));
assert.deepEqual(options.majorGroups.map((option) => option.label), [
  'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
  'Social Sciences', 'Arts, Media & Design', 'Education & Humanities', 'Other / Undeclared',
]);
const legacyFilters = sanitizeFilters({ school: 'sjsu', program: 'big', hasDeck: true, hasPhoto: true });
assert.deepEqual(legacyFilters, {
  years: [], majorGroups: [], socialLevelMin: 1, socialLevelMax: 5, socialStyles: [],
}, 'Obsolete stored filter values must be ignored');
assert.deepEqual(
  sanitizeFilters({ years: ['second', 'Fifth+'] }).years,
  ['second year', 'fourth year+'],
  'Legacy year values should migrate to the normalized categories',
);

const filterSheetSource = await readFile(new URL('../components/FilterSheet.js', import.meta.url), 'utf8');
for (const removedLabel of ['>School<', '>Program<', '>Profile<', 'Has Deck', 'Has Instagram', 'Has Photo']) {
  assert.ok(!filterSheetSource.includes(removedLabel), `${removedLabel} must remain absent from advanced filters`);
}
assert.deepEqual(seededShuffle([1, 2, 3, 4], 12), seededShuffle([1, 2, 3, 4], 12));

console.log('Discovery search, filters, stable shuffle, and options tests passed.');
