import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeProfileFormatting, applyDescriptionMatches, UNMATCHED_HOBBY } from '../lib/profile-format-recommendations.js';
import { resolveEffectivePublicProfile } from '../lib/profile-overrides.js';

const jonpaul = analyzeProfileFormatting({
  hobbies: 'Scrapbooking\nDancing\nSmiling\nGaming\nLaughing',
  hobbyDetails: 'Scrapbooking: has been a fun process for me | Dancing - I just like it | Smiling - I smile alot | Gaming - I play roblox alot | Laughing - I love to laugh, its natures medicine',
});
assert.equal(jonpaul.status, 'recommendation');
assert.equal(jonpaul.confidence, 'EXACT');
assert.equal(jonpaul.descriptions.length, 5);
assert.deepEqual(jonpaul.descriptions.map((item) => item.hobby), ['Scrapbooking', 'Dancing', 'Smiling', 'Gaming', 'Laughing']);
assert.equal(jonpaul.descriptions[2].text, 'I smile alot', 'matching must preserve applicant wording');
assert.equal(jonpaul.descriptions[3].text, 'I play roblox alot', 'matching must not rewrite prose');
assert.equal(applyDescriptionMatches(jonpaul.hobbies, jonpaul.descriptions).hobbyDetails, 'has been a fun process for me\nI just like it\nI smile alot\nI play roblox alot\nI love to laugh, its natures medicine');

const preston = analyzeProfileFormatting({
  hobbies: 'playing league of legends\nstaying up till 4am\nlarping hiking and physical activities\nworking the big J\'s\nyearning\nraving too or wtv',
  hobbyDetails: '1) detail one\n2) detail two\n3) detail three\n4) detail four\n5) detail five\n6) detail six',
});
assert.equal(preston.status, 'recommendation');
assert.equal(preston.confidence, 'POSITIONAL');
assert.equal(preston.descriptions.length, 6);
assert.deepEqual(preston.descriptions.map((item) => item.hobby), preston.hobbies);
assert.match(preston.descriptions[5].text, /raving|detail six/);

const mismatch = analyzeProfileFormatting({ hobbies: 'A\nB\nC\nD\nE\nF', hobbyDetails: '1) one\n2) two\n3) three\n4) four\n5) five' });
assert.equal(mismatch.status, 'manual-review');
assert.equal(mismatch.canApply, false);
assert.ok(mismatch.descriptions.every((item) => item.hobby === UNMATCHED_HOBBY));

const ambiguous = analyzeProfileFormatting({ hobbies: 'Music\nGaming\nHiking', hobbyDetails: 'I like doing stuff with friends' });
assert.equal(ambiguous.status, 'manual-review');
assert.equal(ambiguous.descriptions[0].hobby, UNMATCHED_HOBBY);

const clean = analyzeProfileFormatting({ hobbies: 'Photography\nHiking', hobbyDetails: 'I shoot film\nI enjoy trails' });
assert.equal(clean.status, 'clean');
assert.equal(clean.confidence, 'POSITIONAL');
assert.equal(analyzeProfileFormatting({ hobbies: 'Gaming\nHiking', hobbyDetails: '' }).status, 'no-descriptions');

const manuallyMatched = [...ambiguous.descriptions];
manuallyMatched[0] = { ...manuallyMatched[0], hobby: 'Gaming', matchType: 'MANUAL' };
assert.equal(applyDescriptionMatches(ambiguous.hobbies, manuallyMatched).ok, true, 'Admin can manually match an otherwise ambiguous description');
assert.equal(applyDescriptionMatches(ambiguous.hobbies, ambiguous.descriptions).ok, false, 'unmatched descriptions cannot be silently discarded');
const duplicate = jonpaul.descriptions.map((item) => ({ ...item, hobby: 'Gaming' }));
assert.equal(applyDescriptionMatches(jonpaul.hobbies, duplicate).ok, false, 'duplicate hobby matches are rejected');

const approved = resolveEffectivePublicProfile({
  hobbies: jonpaul.current.hobbies, hobbyDetails: jonpaul.current.hobbyDetails,
  music: '', movies: '', perfectDay: '', vibes: ['Music'], interests: ['Old'],
}, { vibes: ['Creative'], hobbyDetails: applyDescriptionMatches(jonpaul.hobbies, jonpaul.descriptions).hobbyDetails });
assert.deepEqual(approved.vibes, ['Creative'], 'explicit vibes override survives matching apply');
assert.ok(approved.interests.length > 0, 'existing resolver remains responsible for derived interests');

const route = await readFile(new URL('../app/api/admin/datasets/profile/format/route.js', import.meta.url), 'utf8');
assert.match(route, /authorizeAdminReadRequest/);
assert.match(route, /analyzeProfileFormatting/);
assert.match(route, /applyDescriptionMatches/);
assert.doesNotMatch(route, /updateAdminPublicProfile|\.update\(/, 'matching preview must not mutate');
const editor = await readFile(new URL('../components/AdminProfileEditor.js', import.meta.url), 'utf8');
assert.match(editor, /Match hobby descriptions/);
assert.match(editor, /Apply matches/);
assert.match(editor, /Reset suggestions/);
assert.match(editor, /api\/admin\/datasets\/profile/);

console.log('Hobby description matching, preservation, override integration, and Admin preview tests passed.');
