import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { profiles } from '../lib/profiles.js';
import {
  balancedShuffle,
  buildDiscoveryResults,
  buildProfileMatchContext,
  buildPublicSearchDocument,
  canonicalYear,
  createMatchSnippet,
  createSeed,
  filterAndOrderProfiles,
  getDiscoveryOptions,
  getAvailableRoles,
  migrateDiscoveryState,
  normalizePublicText,
  normalizeText,
  PUBLIC_SEARCH_FIELDS,
  scoreProfile,
  sanitizeFilters,
  seededShuffle,
} from '../lib/discovery.js';
import { scoreVibeEvidence } from '../lib/import/vibe-evidence.js';
import { resolveEffectivePublicProfile } from '../lib/profile-overrides.js';
import { markProfileSeen, readSeenIds, resetSeenIds, SEEN_PROFILES_KEY } from '../lib/seen-profiles.js';
import { isProfileSaved, readSavedIds, saveProfile, toggleSavedProfile } from '../lib/saved-profiles.js';
import {
  encounteredProfilesKey,
  markProfileEncountered,
  readEncounteredIds,
  sanitizeEncounteredIds,
} from '../lib/encountered-profiles.js';

assert.equal(profiles.length, 210, 'Expected all imported profiles');
assert.equal(canonicalYear('2nd Year'), 'Second year');
assert.equal(canonicalYear('freshman'), 'First year');
assert.equal(canonicalYear('5th year'), 'Fourth year+');
assert.equal(canonicalYear('Grad student'), 'Graduate / Other');
assert.equal(normalizeText('Data Science & AI'), 'data science and ai');
const seed = 873421;

const wholeProfileFixture = {
  id: 'whole-profile',
  name: 'Hazel Tran',
  pronouns: 'she/her',
  role: 'Little',
  major: 'Nutritional Science',
  majorGroup: 'Health & Life Sciences',
  year: 'Third Year',
  normalizedYear: 'Third year',
  school: 'San Jose State University',
  program: 'ACE Little Program',
  family: 'Blue Family',
  socialLevel: 3,
  socialStyle: 'Ambivert',
  interests: ['Photography', 'Cooking'],
  vibes: ['Photography', 'Travel'],
  hobbies: 'I have my own camera<br>and love photography on weekends.',
  hobbyDetails: 'I develop film in a small home darkroom.',
  passion: 'Community nutrition education is my lifelong cause.',
  perfectDay: 'A sunrise picnic followed by a pottery class.',
  idealHangout: 'Walking through a botanical garden with friends.',
  bucketList: 'Take the train across Japan during cherry blossom season.',
  uniqueThings: 'I can identify many birds by their songs.',
  bio: 'My public story includes mentoring first-generation students.',
  music: 'Japanese city pop and bedroom folk.',
  movies: 'Studio Ghibli films and quiet documentaries.',
  hotTake: 'Breakfast food is best served at dinner.',
  tagline: 'Curious, kind, and always carrying a camera.',
  email: 'private-search-marker@example.com',
  phone: '408-555-0199',
  birthday: 'private-birthday-marker',
  paymentStatus: 'private-payment-marker',
  matchingPreferences: 'private-compatibility-marker',
  sourceRow: 'private-source-marker',
  driveFileId: 'private-drive-marker',
  publicOverrides: { hobbies: 'private-override-metadata-marker' },
  auditHistory: 'private-audit-marker',
  vibeEvidence: 'private-vibe-internal-marker',
};

const publicDocument = buildPublicSearchDocument(wholeProfileFixture);
assert.deepEqual(
  publicDocument.map(({ field }) => field),
  PUBLIC_SEARCH_FIELDS.map(({ field }) => field),
  'the canonical search document should contain only populated allowlisted fields',
);
for (const privateField of [
  'email', 'phone', 'birthday', 'paymentStatus', 'matchingPreferences', 'sourceRow',
  'driveFileId', 'publicOverrides', 'auditHistory', 'vibeEvidence',
]) {
  assert.equal(publicDocument.some(({ field }) => field === privateField), false, `${privateField} must not be searchable`);
  assert.equal(scoreProfile(wholeProfileFixture, wholeProfileFixture[privateField]), -1, `${privateField} content must not match`);
}

const wholeProfileSearchCases = [
  ['name', 'Hazel Tran'],
  ['major', 'Nutritional Science'],
  ['vibe', 'Photography'],
  ['hobbies', 'photography on weekends'],
  ['hobby details', 'home darkroom'],
  ['passion', 'lifelong cause'],
  ['perfect day', 'sunrise picnic'],
  ['ideal hangout', 'botanical garden'],
  ['bucket list', 'Japan'],
  ['story', 'first-generation students'],
  ['music', 'bedroom folk'],
  ['movies', 'quiet documentaries'],
  ['unique things', 'identify many birds'],
  ['hot take', 'served at dinner'],
  ['tagline', 'curious kind'],
];
for (const [label, query] of wholeProfileSearchCases) {
  assert.ok(scoreProfile(wholeProfileFixture, query) >= 0, `${label} should be searchable`);
}
assert.ok(scoreProfile(wholeProfileFixture, 'PHOTOGRAPHY') >= 0, 'search should be case-insensitive');
assert.ok(scoreProfile(wholeProfileFixture, '  JAPAN  \n') >= 0, 'query whitespace should normalize');
assert.ok(scoreProfile(wholeProfileFixture, 'camera and love') >= 0, 'legacy br markup should normalize to whitespace');
assert.equal(normalizePublicText('camera<br />  and\n film'), 'camera and film');
assert.equal(scoreProfile(wholeProfileFixture, 'definitely-not-a-public-match'), -1, 'no-match profiles should be excluded');
assert.deepEqual(filterAndOrderProfiles([wholeProfileFixture], { query: 'definitely-not-a-public-match', seed }), []);

const priorityProfile = {
  ...wholeProfileFixture,
  hobbies: 'Photography belongs in the hobbies answer.',
  hobbyDetails: 'Photography belongs in the hobby details answer.',
  passion: 'Photography belongs in the passion answer.',
  bucketList: 'Photography belongs in the bucket list answer.',
};
const priorityContext = buildProfileMatchContext(priorityProfile, { query: 'photography' });
assert.equal(priorityContext?.field, 'hobbies', 'deep search context should use deterministic field priority');
assert.equal(Array.isArray(priorityContext?.snippet?.parts), true, 'search context should contain one structured snippet');
assert.equal('snippets' in priorityContext, false, 'search context should never contain stacked snippets');
assert.equal(priorityContext.snippet.parts.filter(({ highlight }) => highlight).length >= 1, true);
assert.equal(priorityContext.snippet.parts.filter(({ highlight }) => highlight).map(({ text }) => text).join('').toLowerCase(), 'photography');
assert.equal(buildProfileMatchContext(wholeProfileFixture, { query: 'Hazel' }), null, 'visible name matches should not add redundant context');
assert.equal(buildProfileMatchContext(wholeProfileFixture, { query: 'Nutritional Science' }), null, 'visible major matches should not add redundant context');

const unsafeSnippet = createMatchSnippet('<img src=x onerror=alert(1)> photography', 'photography');
assert.match(unsafeSnippet.text, /<img src=x onerror=alert\(1\)>/, 'snippet data may retain public punctuation as plain text');
assert.equal(unsafeSnippet.parts.some(({ highlight, text }) => highlight && text === 'photography'), true);

const importedProfile = {
  id: 'override-profile', name: 'Override Example', role: 'Little',
  year: 'First Year', normalizedYear: 'First year', major: 'History', majorGroup: 'Education & Humanities',
  hobbies: 'Only the hidden imported hiking marker.', vibes: [], interests: [],
};
const effectiveProfile = resolveEffectivePublicProfile(importedProfile, {
  year: 'Third Year',
  major: 'Computer Science',
  hobbies: 'My effective public hobby is photography.',
});
assert.ok(scoreProfile(effectiveProfile, 'photography') >= 0, 'effective Admin override text should be searchable');
assert.equal(scoreProfile(effectiveProfile, 'hiking'), -1, 'overridden imported text should not remain searchable');
assert.deepEqual(filterAndOrderProfiles([effectiveProfile], { years: ['third year'], seed }).map(({ id }) => id), ['override-profile']);
assert.deepEqual(filterAndOrderProfiles([effectiveProfile], { years: ['first year'], seed }), [], 'stale normalized year must not drive filtering');
assert.deepEqual(filterAndOrderProfiles([effectiveProfile], { majorGroups: ['computing and data'], seed }).map(({ id }) => id), ['override-profile']);
assert.deepEqual(filterAndOrderProfiles([effectiveProfile], { majorGroups: ['education and humanities'], seed }), [], 'stale major group must not drive filtering');

const canonicalPhotography = scoreVibeEvidence({ hobbies: wholeProfileFixture.hobbies })
  .find(({ vibe }) => vibe === 'Photography');
const vibeContext = buildProfileMatchContext(wholeProfileFixture, {
  vibes: ['Travel', 'Photography'], socialStyles: ['Ambivert'],
});
assert.equal(vibeContext?.type, 'vibe');
assert.deepEqual(vibeContext?.values, ['Photography', 'Ambivert'], 'strongest selected vibe should be deterministic and combine useful filter context');
assert.equal(vibeContext?.field, canonicalPhotography.evidence[0].field, 'vibe context should reuse canonical evidence fields');
assert.equal(vibeContext?.matchedTerm, canonicalPhotography.evidence[0].phrase, 'vibe context should reuse canonical evidence phrases');
assert.equal(buildProfileMatchContext(wholeProfileFixture, { role: 'Little', years: ['third year'] }), null, 'role/year alone should not add redundant context');
assert.deepEqual(
  buildProfileMatchContext(wholeProfileFixture, { socialStyles: ['Ambivert'] })?.values,
  ['Ambivert'],
  'social style can provide compact context',
);
const combinedContext = buildProfileMatchContext(wholeProfileFixture, {
  query: 'Japan', vibes: ['Photography'], socialStyles: ['Ambivert'],
});
assert.equal(combinedContext?.type, 'search', 'deep search context should beat filter context');
assert.equal(combinedContext?.field, 'bucketList');
assert.deepEqual(combinedContext?.alsoMatches, ['Photography', 'Ambivert']);
assert.equal(buildProfileMatchContext(wholeProfileFixture), null, 'no active context should produce no explanation');
assert.equal(buildProfileMatchContext(wholeProfileFixture, { query: 'private-audit-marker' }), null, 'private fields cannot produce explanations');
assert.doesNotMatch(JSON.stringify(vibeContext), /private-|example\.com|408-555/, 'filter explanations must contain public evidence only');
const structuredResult = buildDiscoveryResults([wholeProfileFixture], { query: 'Japan', seed });
assert.equal(structuredResult.length, 1);
assert.equal(structuredResult[0].profile, wholeProfileFixture);
assert.equal(structuredResult[0].matchContext.field, 'bucketList');

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
const unseen = filterAndOrderProfiles(profiles, { unseen: true, seenIds, seed });
assert.equal(unseen.length, 205);
assert.ok(unseen.every((profile) => !seenIds.includes(profile.id)));
for (const role of ['All', 'Little', 'Big', 'Family']) {
  const roleUnseen = filterAndOrderProfiles(profiles, { role, unseen: true, seenIds, seed });
  const roleAll = filterAndOrderProfiles(profiles, { role, seed });
  assert.equal(roleUnseen.length, roleAll.length - seenIds.filter((id) => profiles.find((profile) => profile.id === id)?.role === (role === 'All' ? profiles.find((profile) => profile.id === id)?.role : role)).length);
  assert.ok(roleUnseen.every((profile) => profile.role === role || role === 'All'));
}

const vibeFixture = [
  { id: 'one', role: 'Little', vibes: ['Gaming'], major: 'Computer Science', majorGroup: 'Computing & Data', year: 'First', normalizedYear: 'First year', socialLevel: 4, socialStyle: 'Introvert', bio: 'alpha anime' },
  { id: 'two', role: 'Big', vibes: ['Travel', 'Music'], major: 'MIS', majorGroup: 'Business', year: 'Third', normalizedYear: 'Third year', socialLevel: 3, socialStyle: 'Ambivert', bio: 'beta' },
  { id: 'three', role: 'Little', vibes: ['Music'], major: 'Mechanical Engineering', majorGroup: 'Engineering', year: 'First', normalizedYear: 'First year', socialLevel: null, socialStyle: '', bio: 'gamma' },
  { id: 'four', role: 'Big', vibes: ['Music'], major: 'Electrical Engineering', majorGroup: 'Engineering', year: 'Third', normalizedYear: 'Third year', socialLevel: 5, socialStyle: 'Extrovert', bio: 'delta anime' },
];
const savedStorage = {
  values: new Map([['ace-discover:saved:fall-2025', JSON.stringify(['one', 'one', 7])]]),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, value); },
  removeItem(key) { this.values.delete(key); },
};
assert.deepEqual(readSavedIds('fall-2025', savedStorage), ['one'], 'saved IDs should sanitize malformed entries');
assert.deepEqual(readSavedIds('spring-2026', savedStorage), [], 'saved IDs must be dataset-specific');
savedStorage.values.set('ace-discover:saved:broken', '{not-json');
assert.deepEqual(readSavedIds('broken', savedStorage), [], 'malformed saved storage should recover empty');
assert.equal(isProfileSaved('one', 'fall-2025', savedStorage), true);
assert.deepEqual(toggleSavedProfile('one', 'fall-2025', savedStorage), []);
assert.deepEqual(saveProfile('one', 'spring-2026', savedStorage), ['one']);
assert.deepEqual(readSavedIds('fall-2025', savedStorage), []);
assert.deepEqual(readSavedIds('spring-2026', savedStorage), ['one']);
assert.deepEqual(filterAndOrderProfiles(vibeFixture, { saved: true, savedIds: ['one'], seed }).map((profile) => profile.id), ['one']);
assert.deepEqual(filterAndOrderProfiles(vibeFixture, { saved: true, savedIds: ['one', 'two'], role: 'Big', seed }).map((profile) => profile.id), ['two']);
assert.deepEqual(filterAndOrderProfiles(vibeFixture, { saved: true, savedIds: ['one', 'two'], vibes: ['Gaming'], unseen: true, seenIds: ['one'], seed }), []);
const encounteredFixtureOrder = filterAndOrderProfiles(vibeFixture, {
  encounteredIds: ['one', 'two', 'four'],
  seenIds: ['two'],
  seed,
}).map((profile) => profile.id);
assert.deepEqual(encounteredFixtureOrder, ['three', 'one', 'four', 'two'], 'encountered tiers must precede seen profiles');
assert.deepEqual(
  filterAndOrderProfiles(vibeFixture, {
    encounteredIds: ['one', 'two'], seenIds: ['two'], unseen: true, seed,
  }).map((profile) => profile.id),
  ['three', 'four', 'one'],
  'encountered-but-not-seen profiles remain eligible under Unseen',
);
assert.deepEqual(
  filterAndOrderProfiles(vibeFixture, {
    encounteredIds: ['one', 'two'], seenIds: ['two'], saved: true, savedIds: ['one', 'two'], seed,
  }).map((profile) => profile.id),
  ['one', 'two'],
  'Saved remains an eligibility filter before Encountered ordering',
);
assert.deepEqual(
  filterAndOrderProfiles(vibeFixture, {
    encounteredIds: ['one'], seenIds: [], query: 'beta', seed,
  }).map((profile) => profile.id),
  ['two'],
  'search relevance remains stronger than Encountered preference',
);
assert.deepEqual(
  filterAndOrderProfiles(vibeFixture, {
    encounteredIds: ['one'], seenIds: ['one'], orderingSeenIds: [], seed,
  }).map((profile) => profile.id).slice(-1),
  ['one'],
  'live Seen updates do not change the ordering basis until an intentional reorder',
);
const multiVibe = filterAndOrderProfiles(vibeFixture, { vibes: ['Gaming', 'Travel'], seed });
assert.deepEqual(new Set(multiVibe.map((profile) => profile.id)), new Set(['one', 'two']), 'Vibes use OR matching');
const roleAndVibe = filterAndOrderProfiles(vibeFixture, { vibes: ['Gaming', 'Travel'], role: 'Little', seed });
assert.deepEqual(roleAndVibe.map((profile) => profile.id), ['one']);
const searchAndVibe = filterAndOrderProfiles(vibeFixture, { vibes: ['Gaming', 'Travel'], query: 'beta', seed });
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
  vibes: ['Music'],
  role: 'Big', years: ['third year'], majorGroups: ['engineering'],
  socialLevelMin: 3, socialLevelMax: 5, socialStyles: ['Extrovert'], query: 'anime', seed,
});
assert.deepEqual(combinedAdvanced.map((profile) => profile.id), ['four']);
const unseenVibeBusiness = filterAndOrderProfiles(vibeFixture, {
  unseen: true, seenIds: ['one'], vibes: ['Music'],
  majorGroups: ['business'], socialStyles: ['Ambivert'], seed,
});
assert.deepEqual(unseenVibeBusiness.map((profile) => profile.id), ['two']);

const memoryStorage = {
  value: new Map(),
  getItem(key) { return this.value.get(key) ?? null; },
  setItem(key, value) { this.value.set(key, value); },
  removeItem(key) { this.value.delete(key); },
};
const sessionStorage = {
  values: new Map([
    [encounteredProfilesKey('spring-2026'), JSON.stringify(['one', 'one', '', 7, 'two'])],
    ['ace-discover:seen:spring-2026', JSON.stringify(['seen'])],
    ['ace-discover:saved:spring-2026', JSON.stringify(['saved'])],
  ]),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, value); },
  removeItem(key) { this.values.delete(key); },
};
assert.deepEqual(sanitizeEncounteredIds(['one', 'one', '', 7, 'two']), ['one', 'two']);
assert.deepEqual(readEncounteredIds('spring-2026', sessionStorage), ['one', 'two']);
assert.deepEqual(readEncounteredIds('fall-2025', sessionStorage), []);
assert.deepEqual(markProfileEncountered('three', 'spring-2026', sessionStorage), ['one', 'two', 'three']);
assert.equal(sessionStorage.getItem('ace-discover:seen:spring-2026'), JSON.stringify(['seen']));
assert.equal(sessionStorage.getItem('ace-discover:saved:spring-2026'), JSON.stringify(['saved']));
sessionStorage.values.set(encounteredProfilesKey('broken'), '{not-json');
assert.deepEqual(readEncounteredIds('broken', sessionStorage), []);
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
assert.deepEqual(getAvailableRoles([
  { role: 'Little' }, { role: 'Big' }, { role: 'Family' }, { role: 'Little' },
]), ['Little', 'Big', 'Family']);
assert.deepEqual(getAvailableRoles([
  { role: 'Little' }, { role: 'Big' }, { role: 'Little' },
]), ['Little', 'Big'], 'zero-count Family must be hidden');
assert.deepEqual(getAvailableRoles([
  { role: 'Family' },
]), ['Family'], 'role availability must be derived from normalized roles');
assert.equal(options.roleCounts.Family > 0, true);
assert.ok(options.years.some((option) => option.label === 'Second year'));
assert.deepEqual(options.majorGroups.map((option) => option.label), [
  'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
  'Social Sciences', 'Arts, Media & Design', 'Education & Humanities', 'Other / Undeclared',
]);
const legacyFilters = sanitizeFilters({ school: 'sjsu', program: 'big', hasDeck: true, hasPhoto: true });
assert.deepEqual(legacyFilters, {
  vibes: [], years: [], majorGroups: [], socialLevelMin: 1, socialLevelMax: 5, socialStyles: [],
}, 'Obsolete stored filter values must be ignored');
const migratedUnseen = migrateDiscoveryState({
  mode: 'Unseen', role: 'Big', selectedVibes: ['Music'], seed: 44,
  activeProfileId: 'two', scrollTop: 120,
});
assert.equal(migratedUnseen.unseen, true);
assert.equal(migratedUnseen.role, 'Big');
assert.deepEqual(migratedUnseen.filters.vibes, ['Music']);
assert.equal(migratedUnseen.seed, 44);
const migratedVibes = migrateDiscoveryState({ mode: 'Vibes', selectedVibes: ['Gaming'] });
assert.equal(migratedVibes.unseen, false);
assert.deepEqual(migratedVibes.filters.vibes, ['Gaming']);
const resetAdvanced = sanitizeFilters({ vibes: ['Music'], years: ['third year'], majorGroups: ['business'], socialLevelMin: 3, socialLevelMax: 4, socialStyles: ['Ambivert'] });
assert.notDeepEqual(resetAdvanced, sanitizeFilters({}), 'Advanced filters can be active before reset');
assert.deepEqual(sanitizeFilters({}), {
  vibes: [], years: [], majorGroups: [], socialLevelMin: 1, socialLevelMax: 5, socialStyles: [],
}, 'Advanced reset defaults are isolated from role/unseen state');
assert.deepEqual(
  sanitizeFilters({ years: ['second', 'Fifth+'] }).years,
  ['second year', 'fourth year+'],
  'Legacy year values should migrate to the normalized categories',
);

const filterSheetSource = await readFile(new URL('../components/FilterSheet.js', import.meta.url), 'utf8');
for (const removedLabel of ['>School<', '>Program<', '>Profile<', 'Has Deck', 'Has Instagram', 'Has Photo']) {
  assert.ok(!filterSheetSource.includes(removedLabel), `${removedLabel} must remain absent from advanced filters`);
}
assert.ok(filterSheetSource.indexOf('<legend>Vibes</legend>') < filterSheetSource.indexOf('<legend>Year</legend>'));
assert.ok(filterSheetSource.indexOf('<legend>Year</legend>') < filterSheetSource.indexOf('<legend>Major Area</legend>'));
for (const section of ['vibes', 'year', 'majorArea', 'socialLevel', 'socialStyle']) {
  assert.ok(filterSheetSource.includes(`id="filter-section-${section}"`), `FilterSheet should expose the ${section} section target`);
}
assert.ok(filterSheetSource.includes('initialSection = null'), 'FilterSheet should accept an optional section target');
assert.ok(filterSheetSource.includes('scrollIntoView'), 'FilterSheet should scroll a requested section into view');
assert.ok(filterSheetSource.includes('section.focus'), 'FilterSheet should move focus to a requested section');
const discoveryFeedSource = await readFile(new URL('../components/DiscoveryFeed.js', import.meta.url), 'utf8');
assert.ok(!discoveryFeedSource.includes('onModeChange'));
assert.ok(!discoveryFeedSource.includes('discovery.mode'));
assert.ok(!discoveryFeedSource.includes('discovery.selectedVibes'));
assert.ok(discoveryFeedSource.includes('filterSheetSection'), 'Discovery should keep section targeting separate from filter values');
assert.ok(discoveryFeedSource.includes('initialSection={filterSheetSection}'));
assert.ok(discoveryFeedSource.includes('onOpenFilters={openFilters}'));
const discoveryRailSource = await readFile(new URL('../components/DiscoveryRail.js', import.meta.url), 'utf8');
for (const section of ['vibes', 'year', 'majorArea', 'socialLevel', 'socialStyle']) {
  assert.ok(discoveryRailSource.includes(`id: '${section}'`), `Discovery rail should use a stable ${section} target`);
}
assert.ok(discoveryRailSource.includes('onOpenFilters(section.id)'), 'Rail sections should request their own FilterSheet target');
assert.deepEqual(seededShuffle([1, 2, 3, 4], 12), seededShuffle([1, 2, 3, 4], 12));
const originalCrypto = globalThis.crypto;
try {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues(values) { values[0] = 0; return values; } },
  });
  assert.notEqual(createSeed(1), 1, 'createSeed must not repeat the previous seed on the zero-value edge case');
} finally {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
}

console.log('Discovery search, filters, stable shuffle, and options tests passed.');
