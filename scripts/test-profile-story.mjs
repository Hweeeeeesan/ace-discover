import assert from 'node:assert/strict';
import { normalizeProfileStory } from '../lib/profile-story.js';

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
assert.equal(normalizeProfileStory({ bio: 'Legacy profile' }).isEditorial, false);
assert.equal(normalizeProfileStory({ tagline: 'Only a phrase' }).perfectDay, '');
console.log('Profile story normalization tests passed.');
