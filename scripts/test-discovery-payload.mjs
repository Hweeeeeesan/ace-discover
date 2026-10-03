import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDiscoverySearchCorpus,
  discoveryCardProfile,
  DISCOVERY_DEEP_SEARCH_FIELDS,
} from '../lib/datasets/model.js';
import {
  createDiscoverySearchLoader,
  hydrateDiscoverySearchCorpus,
  mergeDiscoverySearchProfiles,
  PUBLIC_DISCOVERY_SEARCH_PATH,
} from '../lib/discovery-search.js';
import { buildDiscoveryResults } from '../lib/discovery.js';
import { filterEligibleDiscoveryProfiles } from '../lib/discovery-eligibility.js';

const imageId = '123e4567-e89b-42d3-a456-426614174000';
const fullProfile = {
  id: 'payload-example',
  name: 'Payload Example',
  pronouns: 'they/them',
  role: 'Little',
  major: 'Computer Science',
  majorGroup: 'Computing & Data',
  year: 'Third Year',
  school: 'San Jose State University',
  program: 'ACE Little Program',
  family: 'Blue Family',
  socialLevel: 4,
  socialStyle: 'Extrovert',
  interests: ['Gaming', 'Photography'],
  vibes: ['Gaming', 'Photography'],
  tagline: 'Always taking photos.',
  slideDeckUrl: 'https://example.com/public-slides',
  hobbies: 'Film photography and games.',
  hobbyDetails: 'I develop film in a home darkroom.',
  passion: 'Community arts.',
  music: 'Bedroom pop.',
  movies: 'Quiet documentaries.',
  perfectDay: 'A photo walk at sunrise.',
  idealHangout: 'A cafe and photo walk.',
  bucketList: 'Photograph the northern lights.',
  uniqueThings: 'I restore old cameras.',
  hotTake: 'Film grain belongs everywhere.',
  instagram: 'https://www.instagram.com/private/',
  bio: 'Private Profile Story text.',
  story: 'Another private story value.',
  sourceRow: 70,
  publicOverrides: { hobbyDetails: 'private override metadata' },
  storageImagePath: `fall-2026/payload-example/derived/${imageId}-discovery.webp`,
  image: `https://example.supabase.co/storage/v1/object/public/profile-images/fall-2026/payload-example/derived/${imageId}-discovery.webp`,
  imageCandidates: [
    `https://example.supabase.co/storage/v1/object/public/profile-images/fall-2026/payload-example/derived/${imageId}-discovery.webp`,
    '/api/drive-image?fileId=legacy-fallback',
  ],
  focalX: 42,
  focalY: 63,
  displayMode: 'cover',
};

const card = discoveryCardProfile(fullProfile);
for (const field of [
  'id', 'name', 'role', 'major', 'majorGroup', 'year', 'interests', 'vibes',
  'tagline', 'image', 'focalX', 'focalY', 'displayMode',
]) {
  assert.deepEqual(card[field], fullProfile[field], `${field} must remain in the initial card projection`);
}
for (const field of [
  ...DISCOVERY_DEEP_SEARCH_FIELDS,
  'instagram', 'bio', 'story', 'sourceRow', 'publicOverrides', 'storageImagePath',
]) {
  assert.equal(field in card, false, `${field} must not be serialized in the initial Discovery projection`);
}
assert.equal('imageCandidates' in card, false, 'healthy Discovery derivatives must omit legacy Drive fallbacks');

const legacyCard = discoveryCardProfile({
  ...fullProfile,
  storageImagePath: '',
  image: '/api/drive-image?fileId=legacy-source',
  imageCandidates: ['/api/drive-image?fileId=legacy-source'],
});
assert.deepEqual(legacyCard.imageCandidates, ['/api/drive-image?fileId=legacy-source'], 'legacy-only profiles retain their fallback');

const corpus = createDiscoverySearchCorpus([fullProfile], 'fall-2026');
assert.deepEqual(corpus.fields, DISCOVERY_DEEP_SEARCH_FIELDS);
assert.equal(corpus.profiles.length, 1);
assert.equal(JSON.stringify(corpus).includes('home darkroom'), true);
for (const privateValue of ['Private Profile Story text.', 'Another private story value.', 'private override metadata', 'instagram.com']) {
  assert.equal(JSON.stringify(corpus).includes(privateValue), false, `${privateValue} must not enter the deep corpus`);
}

const hydrated = hydrateDiscoverySearchCorpus(corpus, {
  datasetSlug: 'fall-2026',
  version: corpus.version,
});
const merged = mergeDiscoverySearchProfiles([card], hydrated);
for (const field of DISCOVERY_DEEP_SEARCH_FIELDS) {
  assert.deepEqual(merged[0][field], fullProfile[field], `${field} must hydrate for deep search`);
}
assert.deepEqual(
  buildDiscoveryResults(merged, { query: 'home darkroom', seed: 7 }).map(({ profile, matchContext }) => ({
    id: profile.id,
    field: matchContext?.field,
    snippet: matchContext?.snippet?.text,
  })),
  buildDiscoveryResults([fullProfile], { query: 'home darkroom', seed: 7 }).map(({ profile, matchContext }) => ({
    id: profile.id,
    field: matchContext?.field,
    snippet: matchContext?.snippet?.text,
  })),
  'hydrated deep search must preserve ranking, match field, and snippet semantics',
);
assert.equal(buildDiscoveryResults(merged, { query: 'Private Profile Story', seed: 7 }).length, 0);

const familyProfile = { ...fullProfile, id: 'family-jane-doe', name: 'Jane Doe', role: 'Family', major: 'Engineering', year: 'Third Year', majorGroup: 'Engineering', vibes: ['Gaming'], interests: ['Gaming'], hobbies: 'Gaming' };
const familyExcluded = filterEligibleDiscoveryProfiles([fullProfile, familyProfile], false);
assert.deepEqual(familyExcluded.map((profile) => profile.id), ['payload-example'], 'Family profiles must be removed before the lightweight projection');
assert.equal(buildDiscoveryResults(familyExcluded, { query: 'Jane Doe', seed: 7 }).length, 0, 'excluded Family names must not be searchable');
assert.equal(createDiscoverySearchCorpus(familyExcluded, 'fall-2026', false).profiles.some(([id]) => id === familyProfile.id), false, 'excluded Family profiles must not enter the deep corpus');
assert.notEqual(createDiscoverySearchCorpus([familyProfile], 'fall-2026', true).version, createDiscoverySearchCorpus([familyProfile], 'fall-2026', false).version, 'Family visibility must participate in corpus versioning');

let fetchCount = 0;
let releaseFetch;
const loader = createDiscoverySearchLoader(() => {
  fetchCount += 1;
  return new Promise((resolve) => { releaseFetch = () => resolve(corpus); });
});
assert.equal(fetchCount, 0, 'constructing the loader must not fetch without a search');
const firstLoad = loader.load({ datasetSlug: 'fall-2026', version: corpus.version });
const overlappingLoad = loader.load({ datasetSlug: 'fall-2026', version: corpus.version });
assert.equal(fetchCount, 1, 'overlapping search requests must share one corpus fetch');
releaseFetch();
assert.equal(await firstLoad, await overlappingLoad);
await loader.load({ datasetSlug: 'fall-2026', version: corpus.version });
assert.equal(fetchCount, 1, 'subsequent searches must reuse the in-memory corpus');

const failingLoader = createDiscoverySearchLoader(async () => { throw new Error('offline'); });
await assert.rejects(failingLoader.load({ datasetSlug: 'fall-2026', version: corpus.version }), /offline/);
assert.equal(buildDiscoveryResults([card], { query: 'Payload Example', seed: 7 }).length, 1,
  'basic Discovery search remains usable when deep search fails');

const feedSource = await readFile(new URL('../components/DiscoveryFeed.js', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../app/api/discovery/search/route.js', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
const revalidationSource = await readFile(new URL('../lib/datasets/revalidation.js', import.meta.url), 'utf8');
assert.match(feedSource, /if \(!ready \|\| !discovery\.query\.trim\(\) \|\| !searchCorpusVersion\) return undefined;/,
  'the client must not request deep search data until search is non-empty');
assert.match(feedSource, /createDiscoverySearchLoader\(fetchDiscoverySearchCorpus\)/);
assert.match(feedSource, /mergeDiscoverySearchProfiles\(profiles, deepSearchCorpus\)/);
assert.match(routeSource, /export const dynamic = ['"]force-static['"]/);
assert.match(routeSource, /export const revalidate = 300/);
assert.match(homeSource, /searchCorpusVersion=\{dataset\.searchCorpusVersion\}/);
assert.match(revalidationSource, /revalidatePath\(PUBLIC_DISCOVERY_PATH\)/);
assert.match(revalidationSource, /revalidatePath\(PUBLIC_DISCOVERY_SEARCH_PATH\)/);
assert.equal(PUBLIC_DISCOVERY_SEARCH_PATH, '/api/discovery/search');

console.log('Lightweight Discovery payload and lazy deep-search corpus tests passed.');
