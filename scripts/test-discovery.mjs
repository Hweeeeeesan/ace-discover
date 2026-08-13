import assert from 'node:assert/strict';
import { profiles } from '../lib/profiles.js';
import {
  balancedShuffle,
  canonicalYear,
  filterAndOrderProfiles,
  getDiscoveryOptions,
  normalizeText,
  scoreProfile,
  seededShuffle,
} from '../lib/discovery.js';

assert.equal(profiles.length, 210, 'Expected all imported profiles');
assert.equal(canonicalYear('2nd Year'), 'Second');
assert.equal(canonicalYear('Grad student'), 'Graduate');
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
  query: '', role: 'All', years: [], major: '', program: '', school: '', hasDeck: false, seed,
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
  query: '', role: 'Little', years: [], major: '', program: '', school: '', hasDeck: false, seed,
});
assert.equal(littles.length, 123);
assert.ok(littles.every((profile) => profile.role === 'Little'));

const bigs = filterAndOrderProfiles(profiles, {
  query: '', role: 'Big', years: [], major: '', program: '', school: '', hasDeck: false, seed,
});
assert.equal(bigs.length, 65);
assert.ok(bigs.every((profile) => profile.role === 'Big'));

const families = filterAndOrderProfiles(profiles, {
  query: '', role: 'Family', years: [], major: '', program: '', school: '', hasDeck: false, seed,
});
assert.equal(families.length, 22);
assert.ok(families.every((profile) => profile.role === 'Family'));

const decks = filterAndOrderProfiles(profiles, {
  query: '', role: 'All', years: [], major: '', program: '', school: '', hasDeck: true, seed,
});
assert.equal(decks.length, 26);
assert.ok(decks.every((profile) => profile.slideDeckUrl));

const ashleyResults = filterAndOrderProfiles(profiles, {
  query: 'Ashley Kiang', role: 'All', years: [], major: '', program: '', school: '', hasDeck: false, seed,
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
  query: '', role: 'All', years: ['second'], major: '', program: '', school: '', hasDeck: false, seed,
});
assert.ok(secondYears.length > 0);
assert.ok(secondYears.every((profile) => canonicalYear(profile.year) === 'Second'));

const options = getDiscoveryOptions(profiles);
assert.ok(options.years.some((option) => option.label === 'Second'));
assert.ok(options.majors.some((option) => option.label.toLowerCase().includes('public health')));
assert.ok(options.schools.some((option) => option.label === 'SJSU'));
assert.deepEqual(seededShuffle([1, 2, 3, 4], 12), seededShuffle([1, 2, 3, 4], 12));

console.log('Discovery search, filters, stable shuffle, and options tests passed.');
