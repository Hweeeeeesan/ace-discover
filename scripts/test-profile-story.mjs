import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeProfileIntro, normalizeProfileStory } from '../lib/profile-story.js';

const story = normalizeProfileStory({
  tagline: 'Be the change.',
  uniqueThings: '1. Morning and night person\n2. Loves friends',
  passion: 'Psychology',
  perfectDay: 'A long, comfortable answer.',
  hobbies: 'Exploring new places\nLion Dance',
  hobbyDetails: 'Exploring new places: Discovering culture\nLion Dance: Since childhood',
  music: 'Kpop: Artists and songs',
  movies: 'Movies: Everything Everywhere',
  bucketList: 'Japan for the food',
  hotTake: 'Too many pizza toppings ruin it.',
});

assert.equal(story.isEditorial, true);
assert.deepEqual(story.uniqueThings, ['Morning and night person', 'Loves friends']);
assert.deepEqual(story.hobbyItems, [
  { name: 'Exploring new places', detail: 'Discovering culture' },
  { name: 'Lion Dance', detail: 'Since childhood' },
]);
assert.deepEqual(
  normalizeProfileStory({
    hobbies: 'Information maxxing',
    hobbyDetails: '3) information: maxxing...?: I am addicted to lists, maps, Wikipedia articles, encyclopedias...',
  }).hobbyItems,
  [{ name: 'information maxxing...?', detail: 'I am addicted to lists, maps, Wikipedia articles, encyclopedias...' }],
  'punctuation inside a hobby heading must not be treated as the explanation boundary',
);
assert.deepEqual(
  normalizeProfileStory({
    hobbies: 'Fashion\nLion Dance',
    hobbyDetails: 'Fashion: I particularly love styling outfits\nLion Dance: I have been doing this for years',
  }).hobbyItems,
  [
    { name: 'Fashion', detail: 'I particularly love styling outfits' },
    { name: 'Lion Dance', detail: 'I have been doing this for years' },
  ],
);
assert.deepEqual(
  normalizeProfileStory({
    hobbies: 'Travel/Photography\n3) Volleyball',
    hobbyDetails: 'Travel/Photography: I document every trip\n3) Volleyball - I play every weekend',
  }).hobbyItems,
  [
    { name: 'Travel/Photography', detail: 'I document every trip' },
    { name: 'Volleyball', detail: 'I play every weekend' },
  ],
);
assert.deepEqual(
  normalizeProfileStory({
    hobbies: 'Exploring new places\nLion Dance\nVolleyball',
    hobbyDetails: 'Exploring new places: Discovering culture\nLion Dance: Since childhood\nVolleyball: Weekend games',
  }).hobbyItems,
  [
    { name: 'Exploring new places', detail: 'Discovering culture' },
    { name: 'Lion Dance', detail: 'Since childhood' },
    { name: 'Volleyball', detail: 'Weekend games' },
  ],
);
assert.deepEqual(
  normalizeProfileStory({ hobbies: 'I love photography and hiking', hobbyDetails: 'I love photography and hiking' }).hobbyItems,
  [],
  'unlabeled prose should not become a structured hobby item',
);
assert.equal(normalizeProfileStory({ bio: 'Legacy profile' }).isEditorial, false);
assert.equal(normalizeProfileStory({ tagline: 'Only a phrase' }).perfectDay, '');
const sharedFields = {
  tagline: 'Creative, caring, and curious.',
  uniqueThings: '1. Handmade gifts\n2. Loves concerts',
  passion: 'Crafts and concert memories',
  perfectDay: 'A beach picnic with friends.',
  hobbies: 'Baking\nCrocheting',
  hobbyDetails: 'Baking: Treats for friends\nCrocheting: Handmade gifts',
  music: 'R&B and pop',
  movies: 'Criminal Minds and One Piece',
  idealHangout: 'A cafe and crafts',
  bucketList: 'Visit Japan',
  hotTake: 'Cake pops beat cupcakes',
};
assert.deepEqual(
  normalizeProfileStory({ role: 'Little', ...sharedFields }),
  normalizeProfileStory({ role: 'Big', ...sharedFields }),
  'Big and Little profiles must use the same general story normalization',
);
const emptyStory = normalizeProfileStory({ role: 'Little' });
assert.equal(emptyStory.isEditorial, false);
for (const field of ['tagline', 'uniqueThingsText', 'passion', 'perfectDay', 'hobbies', 'hobbyDetails', 'music', 'moviesTv', 'idealHangout', 'bucketList', 'hotTake']) {
  assert.equal(emptyStory[field], '', `${field} must remain hidden when unanswered`);
}
assert.deepEqual(normalizeProfileIntro({ role: 'Little', bio: 'Little applicant' }), { tagline: '', bio: '' });
assert.deepEqual(normalizeProfileIntro({ role: 'Big', bio: 'Big applicant' }), { tagline: '', bio: '' });
assert.deepEqual(normalizeProfileIntro({ role: 'Little', bio: 'A real public story.' }), { tagline: '', bio: 'A real public story.' });
assert.deepEqual(
  normalizeProfileIntro({ role: 'Big', bio: 'A real story.', ...sharedFields }),
  { tagline: sharedFields.tagline, bio: 'A real story.' },
  'Big editorial intro rendering remains unchanged',
);

const detailSource = await readFile(new URL('../components/ProfileDetail.js', import.meta.url), 'utf8');
for (const title of [
  'THINGS THAT MAKE ME, ME',
  'I COULD TALK ABOUT THIS FOR HOURS',
  'MY PERFECT DAY',
  'HOBBIES & ACTIVITIES',
  'CURRENT SOUNDTRACK',
  'MOVIES & SHOWS',
  'IDEAL HANGOUT',
  'ON MY BUCKET LIST',
  'MY HARMLESS HOT TAKE',
]) assert.match(detailSource, new RegExp(`title="${title}"`));
const editorialSource = detailSource.slice(detailSource.indexOf('function EditorialStory'), detailSource.indexOf('export default function ProfileDetail'));
assert.doesNotMatch(editorialSource, /profile\.role/, 'general story sections must not branch on role');
assert.match(detailSource, /className="detail-role-pill">\{profile\.role\}/, 'the image role badge remains');
assert.match(detailSource, /interests\.filter\(\(interest\) => !\['Big', 'Little', 'Family'\]\.includes\(interest\)\)/, 'the standalone role chip is excluded from the detail chip row');
assert.match(detailSource, /interests\.length > 0[\s\S]*className="tag light"/, 'the detail chip row is omitted when no non-role chips remain');
assert.match(detailSource, /profile\.program && <span>\{profile\.program\}<\/span>/, 'the program context pill remains');
console.log('Profile story normalization tests passed.');
