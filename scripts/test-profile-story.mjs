import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeProfileIntro, normalizeProfileStory } from '../lib/profile-story.js';
import { normalizePublicHttpUrl } from '../lib/public-url.js';

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
assert.equal(
  normalizeProfileStory({
    hobbies: 'Information maxxing',
    hobbyDetails: '3) information: maxxing...?: I am addicted to lists, maps, Wikipedia articles, encyclopedias...',
  }).hobbyFormat,
  'structured',
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

const ivyHobbies = 'Going out and trying new things, making a creating nail art/press on nails, PC gaming (R6, overwatch, fortnite), Dancing for fun, Video Filming';
const ivyHobbyDetails = `1. Going out and trying new things is one of my tops because, I'm very picky and can feel uncomfy wanting to try new things.
2.Creating nail art and nails is one of my long time hobby. I find that doing nails are an expensive maintenance.
3. Pc gaming. Classic hobby for others and i just simply enjoy escaping reality when i dont want to leave my house.
4. I like to dance whenever i can, i feel very cool. I really enjoy dancing with friends. Ik its in me :D
5. I use to film quite a bit but whenever i can i would film my life and edit it.`;
const ivyStory = normalizeProfileStory({ hobbies: ivyHobbies, hobbyDetails: ivyHobbyDetails });
assert.equal(ivyStory.hobbyFormat, 'paired', 'a separate five-item hobby list may pair with five clearly ordered explanations');
assert.deepEqual(ivyStory.hobbyItems.map(({ name }) => name), [
  'Going out and trying new things',
  'making a creating nail art/press on nails',
  'PC gaming (R6, overwatch, fortnite)',
  'Dancing for fun',
  'Video Filming',
]);
assert.equal(ivyStory.hobbyItems.some(({ name }) => name.startsWith('I like to dance whenever')), false, 'numbered prose must never supply an invented heading');
assert.equal(ivyStory.hobbyItems[3].detail.endsWith('Ik its in me :D'), true, 'the emoticon must stay attached to the dancing explanation');
assert.equal(ivyStory.hobbyItems.filter(({ detail }) => detail.includes('I like to dance whenever')).length, 1, 'the dancing explanation must appear exactly once');

const unpairedNumbered = normalizeProfileStory({
  hobbies: 'Painting\nHiking',
  hobbyDetails: '1. I spend weekends making ceramic bowls.\n2. Games help me relax after class.',
});
assert.equal(unpairedNumbered.hobbyFormat, 'numbered');
assert.deepEqual(unpairedNumbered.hobbyItems, [], 'numbered prose without an unambiguous label match must remain raw numbered prose');
assert.equal(unpairedNumbered.hobbyDetails, '1. I spend weekends making ceramic bowls.\n2. Games help me relax after class.');

const mismatchedNumbered = normalizeProfileStory({
  hobbies: 'Painting\nHiking\nCooking',
  hobbyDetails: '1. Painting helps me relax.\n2. Hiking gets me outdoors.',
});
assert.equal(mismatchedNumbered.hobbyFormat, 'numbered');
assert.deepEqual(mismatchedNumbered.hobbyItems, [], 'count mismatches must preserve the numbered source instead of manufacturing headings');

const partialExplicit = normalizeProfileStory({
  hobbies: 'Dance\nGaming',
  hobbyDetails: 'Dance: I practice with friends.\n2. Gaming helps me unwind :D',
});
assert.equal(partialExplicit.hobbyFormat, 'raw');
assert.deepEqual(partialExplicit.hobbyItems, [], 'partial explicit parsing must not drop or duplicate the remaining raw response');

assert.deepEqual(
  normalizeProfileStory({
    hobbies: 'Painting\nHiking',
    hobbyDetails: '1. Painting: Watercolors are relaxing.\n2. Hiking - I enjoy local trails.',
  }).hobbyItems,
  [
    { name: 'Painting', detail: 'Watercolors are relaxing.' },
    { name: 'Hiking', detail: 'I enjoy local trails.' },
  ],
  'fully explicit numbered labels remain structured',
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
const storySource = await readFile(new URL('../lib/profile-story.js', import.meta.url), 'utf8');
const stylesheet = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
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
assert.match(
  editorialSource,
  /title="IDEAL HANGOUT"[\s\S]*?when=\{story\.idealHangout\}/,
  'ProfileDetail must hide the Ideal Hangout section when its canonical value is empty',
);
assert.match(detailSource, /className="detail-role-pill">\{profile\.role\}/, 'the image role badge remains');
assert.match(detailSource, /interests\.filter\(\(interest\) => !\['Big', 'Little', 'Family'\]\.includes\(interest\)\)/, 'the standalone role chip is excluded from the detail chip row');
assert.match(detailSource, /interests\.length > 0[\s\S]*className="tag light"/, 'the detail chip row is omitted when no non-role chips remain');
assert.match(detailSource, /profile\.program && <span>\{profile\.program\}<\/span>/, 'the program context pill remains');
assert.match(detailSource, /const aceTraitSlideUrl = normalizePublicHttpUrl\(profile\.aceTraitSlideUrl\)/);
assert.match(
  detailSource,
  /className="story-section ace-trait-slide-section"[\s\S]*PERSONAL ACE TRAIT SLIDE[\s\S]*ExternalProfileLink[\s\S]*href=\{aceTraitSlideUrl\}/,
  'ProfileDetail must render the canonical Big/Little slide field only when its safe URL is present',
);
assert.match(detailSource, /function ExternalProfileLink[\s\S]*target="_blank" rel="noopener noreferrer"/);
assert.match(detailSource, /profile-external-link/);
assert.match(detailSource, /className="instagram-button"/);
assert.match(detailSource, /profile-external-link-icon ace-trait-slide-icon/);
assert.match(detailSource, /profile-external-link-icon instagram-icon/);
assert.doesNotMatch(detailSource, /className="deck-button ace-trait-slide-button"/, 'ACE Trait Slide must use the shared external CTA instead of the heavier deck CTA');
assert.doesNotMatch(stylesheet, /\.hot-take\s*\{[^}]*border-bottom/, 'Hot Take must not add a second bottom divider');
assert.doesNotMatch(stylesheet, /\.ace-trait-slide-section\s*\{[^}]*border-top/, 'ACE Trait Slide must inherit the editorial section divider');
assert.match(stylesheet, /\.story-section\s*\{[^}]*border-top: 1px solid #ebe8e1/);
assert.match(stylesheet, /\.profile-external-link\s*\{[^}]*background: #f7f5f0/);
assert.match(stylesheet, /\.profile-external-link:hover\s*\{[^}]*background: #f1eee7/);
assert.match(stylesheet, /\.profile-external-link-icon\s*\{[^}]*color: white/);
assert.match(stylesheet, /\.detail-discovery-link\s*\{[^}]*border: 0/);
assert.doesNotMatch(
  detailSource.slice(detailSource.indexOf('function AceTraitSlideSection'), detailSource.indexOf('function EditorialStory')),
  /profile\.role/,
  'ProfileDetail slide rendering must not repeat importer role logic',
);
assert.doesNotMatch(storySource, /\b(?:ivy|ngo)\b/i, 'hobby parsing must remain applicant-independent');
assert.match(
  editorialSource,
  /story\.hobbyItems\.length[\s\S]*hobby-list[\s\S]*<StoryText>\{story\.hobbies\}<\/StoryText>[\s\S]*<StoryText>\{story\.hobbyDetails\}<\/StoryText>/,
  'ProfileDetail must render either structured items or the original hobby blocks, never both',
);
assert.equal(normalizePublicHttpUrl(' https://www.canva.com/design/example/view '), 'https://www.canva.com/design/example/view');
for (const unsafeUrl of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/slide']) {
  assert.equal(normalizePublicHttpUrl(unsafeUrl), '', `unsafe public URL must not render: ${unsafeUrl}`);
}
console.log('Profile story normalization tests passed.');
