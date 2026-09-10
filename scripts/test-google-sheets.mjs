import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseWorksheet,
  fetchSpreadsheetMetadata,
  fetchWorksheetValues,
  GoogleSheetsError,
  parseGoogleSheetUrl,
} from '../lib/google-sheets.js';
import {
  buildDatasetImportTargetFields,
  buildDatasetSyncDiff,
  preserveMissingSourceProfiles,
  validateSyncApplyAcknowledgement,
} from '../lib/datasets/sync.js';
import {
  analyzeSheetValues,
  inferVibes,
  scoreVibeEvidence,
  VIBE_FIELD_WEIGHTS,
  VIBE_ORDER,
} from '../lib/import/profile-normalization.js';

function columnIndex(column) {
  let index = 0;
  for (const character of column) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
}

function setCell(row, column, value) {
  const index = columnIndex(column);
  if (row.length <= index) row.push(...Array(index + 1 - row.length).fill(''));
  row[index] = value;
}

function fall2026SheetFixture() {
  const header = [];
  setCell(header, 'E', 'First name');
  setCell(header, 'F', 'Last name');
  setCell(header, 'K', 'Instagram username');
  setCell(header, 'S', "List your favorite hobbies/activities. (5 minimum) Please don't put eating or sleeping :)");
  setCell(header, 'AH', 'What’s something you’re really passionate about and could talk about for hours? Explain in 1-2 sentences.');
  setCell(header, 'AL', 'Rate your social setting from 1 to 5');
  setCell(header, 'AN', 'Are you an introvert, ambivert, or extrovert?');
  setCell(header, 'BY', "List your favorite hobbies/activities. (5 minimum) Please don't put eating or sleeping :) 2");
  setCell(header, 'CC', 'What’s something you’re really passionate about and could talk about for hours? Explain in 1-2 sentences. 2');
  setCell(header, 'CD', 'Describe your personality in a tagline');

  const hazel = [];
  const hazelPublic = {
    E: 'Hazel',
    F: 'Tran',
    N: 'Second',
    P: 'SJSU',
    Q: 'Computer Science',
    R: 'FAM/ACE LITTLE Program',
    S: 'Baking\nCrocheting\nConcerts\nMovies\nTraveling',
    T: 'Baking: I make treats for friends.\nCrocheting: I make gifts for people.',
    U: 'R&B and pop; SZA, Wave to Earth, and Laufey.',
    V: 'Criminal Minds, One Piece, and Legally Blonde.',
    W: '1. I make handmade gifts\n2. I collect blind boxes\n3. I love creative nails',
    X: 'Creative, caring, and always curious.',
    Y: 'A beach picnic, crafts, and dinner with friends.',
    Z: 'Cake pops are better than cupcakes.',
    AA: 'Trying a new cafe and doing crafts together.',
    AB: 'Visit Japan to explore the food and art.',
    AG: 'PRIVATE NEARBY FRIEND QUALITIES',
    AH: 'I could talk about crafts and concert memories for hours. Contact hazel.private@example.com or (408) 555-1212.',
    AI: 'PRIVATE NEARBY LIFE GOALS',
    AL: '3',
    AN: 'Ambivert',
    AQ: 'https://drive.google.com/file/d/1HazelTranProfileImage2026/view',
    BL: 'I am a creative person who loves making thoughtful gifts.',
    CC: 'PRIVATE BIG BLOCK PASSION',
  };
  for (const [column, value] of Object.entries(hazelPublic)) setCell(hazel, column, value);
  for (const [column, value] of Object.entries({
    AE: 'PRIVATE DISLIKED ACTIVITY',
    AF: 'PRIVATE PET PEEVE',
    AT: 'PRIVATE PAIRING PREFERENCE',
    BI: 'PRIVATE CURFEW',
    BJ: 'PRIVATE CONFIDENTIAL RESPONSE',
  })) setCell(hazel, column, value);

  const big = [];
  for (const [column, value] of Object.entries({
    E: 'Logan',
    F: 'Ho',
    K: '@logan.example',
    N: 'Third',
    P: 'SJSU',
    Q: 'Psychology',
    R: 'ACE BIG ONLY PROGRAM',
    BY: 'Exploring new places, hiking, gaming, and trying new food.',
    BZ: 'Exploring new places: I like finding memorable local spots.',
    CA: 'R&B, indie, and live concerts.',
    CB: 'Comedy movies and TV shows.',
    CC: 'Psychology and helping people grow.',
    CD: 'Be the change you want to see.',
    CE: 'A road trip, good food, and time with friends.',
    CF: '1. I am both a morning and a night person.',
    CG: 'Travel through Japan.',
    CH: 'Putting too many toppings on pizza ruins it.',
    CS: '4',
    CU: 'Extrovert',
    CV: 'I enjoy bringing people together and helping friends feel included.',
    CX: 'https://drive.google.com/drive/folders/1LoganHoProfileFolder2026',
  })) setCell(big, column, value);

  return { title: 'Form Responses 1', values: [header, hazel, big], hazelPublic };
}

function mappedSheetFixture(title, headers, cells) {
  const header = [];
  const row = [];
  for (const [column, value] of Object.entries(headers)) setCell(header, column, value);
  for (const [column, value] of Object.entries(cells)) setCell(row, column, value);
  return { title, values: [header, row] };
}

function legacyParityFixtures() {
  return [
    mappedSheetFixture('LITTLES', {
      E: 'First name', F: 'Last name', BD: 'Instagram', AU: 'Social setting', AW: 'Introvert or extrovert',
    }, {
      E: 'Fall', F: 'Little', M: 'First', O: 'SJSU', P: 'MIS', R: 'ACE Little',
      AA: 'Baking, music, and hiking with friends.', AG: 'Pop music', AH: 'Comedy movies',
      AJ: 'A beach day and dinner.', BA: 'I enjoy making new friends through shared hobbies.',
      BD: '@fall.little', BE: 'https://drive.google.com/file/d/1FallLittleProfileImage/view',
      BG: 'https://docs.google.com/presentation/d/1FallLittleSlideDeck/edit', BH: 'Blue Fam',
      AU: '2', AW: 'Introvert',
    }),
    mappedSheetFixture('BIGS', {
      E: 'First name', F: 'Last name', BG: 'Instagram', AY: 'Social setting', BA: 'Introvert or extrovert',
    }, {
      E: 'Fall', F: 'Big', M: 'Fourth', O: 'SJSU', P: 'Mechanical Engineering', R: 'ACE Big',
      AE: 'Gym, basketball, and cooking with friends.', AK: 'Hip hop music', AL: 'Action movies',
      AN: 'A full day exploring the city.', BD: 'I like helping others feel welcome and connected.',
      BG: '@fall.big', BH: 'https://drive.google.com/file/d/1FallBigProfileImage26/view',
      BJ: 'https://docs.google.com/presentation/d/1FallBigSlideDeck26/edit', T: 'Green Fam',
      AY: '5', BA: 'Extrovert',
    }),
    mappedSheetFixture('FAMS', {
      E: 'First name', F: 'Last name', AK: 'Instagram', AH: 'Social setting', BP: 'Introvert or extrovert',
    }, {
      E: 'Fall', F: 'Family', M: 'Graduate', O: 'SJSU', P: 'Public Health', R: 'Family only',
      S: 'Volunteering, cooking, and movies with the family.', U: 'R&B music', V: 'Family movies',
      W: 'A picnic and games with everyone.', AK: '@fall.family',
      AL: 'https://drive.google.com/drive/folders/1FallFamilyFolder2026',
      BZ: 'https://docs.google.com/presentation/d/1FallFamilySlides26/edit', AN: 'Gold Fam',
      AH: '4', BP: 'Ambivert',
    }),
    mappedSheetFixture('Little Applications', {
      E: 'First name', F: 'Last name', BC: 'Instagram', AT: 'Social setting', AV: 'Introvert or extrovert',
    }, {
      E: 'Spring', F: 'Little', M: 'Second', O: 'SJSU', P: 'Data Science', R: 'ACE Little',
      S: 'Purple Fam', Y: 'Gaming, cafes, and photography.', AE: 'Indie music', AF: 'Anime and movies',
      AH: 'Cafe hopping followed by a movie.', AZ: 'I like documenting fun memories with friends.',
      BC: '@spring.little', BD: 'https://drive.google.com/file/d/1SpringLittleImage2026/view',
      AT: '3', AV: 'Ambivert',
    }),
    mappedSheetFixture('Big Applications', {
      E: 'First name', F: 'Last name', DN: 'Instagram', DF: 'Social setting', DH: 'Introvert or extrovert',
    }, {
      E: 'Spring', F: 'Big', M: 'Third', O: 'SJSU', P: 'Finance', R: 'ACE Big', CA: 'Red Fam',
      CL: 'Travel, volleyball, and trying new food.', CR: 'Live music', CS: 'TV shows',
      CU: 'A road trip and a new restaurant.', DK: 'I love planning adventures that bring people together.',
      DN: '@spring.big', DO: 'https://drive.google.com/file/d/1SpringBigImage2026/view',
      DQ: 'https://docs.google.com/presentation/d/1SpringBigSlides26/edit', DF: '4', DH: 'Extrovert',
    }),
  ];
}

function withoutGeneratedAt(payload) {
  const comparable = structuredClone(payload);
  delete comparable.health.generatedAt;
  return comparable;
}

const vibeRegressionFixtures = [
  { fields: { hobbies: 'I love going to concerts and play guitar.' }, vibes: ['Music'] },
  { fields: { music: 'I listen to music while studying.' }, vibes: [] },
  { fields: { hobbies: "I don't like parties or clubs." }, vibes: [] },
  { fields: { hobbies: 'I hate hiking.' }, vibes: [] },
  { fields: { hobbies: "I don't play video games." }, vibes: [] },
  { fields: { hobbies: 'I love hiking, camping, and going to the beach.' }, vibes: ['Outdoors'] },
  { fields: { hobbies: 'I have a camera and love photography.' }, vibes: ['Photography'] },
  { fields: { movies: 'I watch a movie sometimes.' }, vibes: [] },
  { fields: { movies: 'I have Letterboxd and watch movies every week.' }, vibes: ['Movies & TV'] },
  { fields: { hobbies: 'I love matcha.' }, vibes: [] },
  {
    fields: { hobbies: 'cooking baking hiking camping video games valorant concerts guitar anime manga fashion thrifting photography camera' },
    vibes: ['Foodie', 'Outdoors', 'Gaming', 'Music', 'Anime'],
  },
  { fields: { hobbies: 'hiking gaming' }, vibes: ['Outdoors', 'Gaming'] },
  { fields: { hobbies: 'concert concert concert' }, vibes: ['Music'] },
];
for (const fixture of vibeRegressionFixtures) {
  assert.deepEqual(inferVibes(fixture.fields), fixture.vibes);
}
assert.deepEqual(VIBE_FIELD_WEIGHTS, {
  hobbies: 3,
  hobbyDetails: 3,
  passion: 3,
  perfectDay: 2,
  idealHangout: 2,
  story: 1,
  music: 1,
  movies: 1,
});
assert.deepEqual(VIBE_ORDER, [
  'Foodie', 'Outdoors', 'Gaming', 'Music', 'Creative', 'Fitness', 'Sports',
  'Travel', 'Movies & TV', 'Anime', 'Nightlife', 'Coffee & Cafes', 'Studying',
  'Fashion', 'Photography', 'Volunteering',
]);
assert.equal(
  scoreVibeEvidence(vibeRegressionFixtures.at(-1).fields).find(({ vibe }) => vibe === 'Music').score,
  9,
  'repeating identical evidence must not multiply its score',
);

const pythonVibeResults = JSON.parse(execFileSync('python3', [
  '-c',
  `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ace_importer', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixtures = json.loads(sys.argv[2])
print(json.dumps([{'vibes': module.infer_vibes(item['fields']), 'scores': module.score_vibe_evidence(item['fields'])} for item in fixtures]))`,
  fileURLToPath(new URL('../scripts/import-master-apps.py', import.meta.url)),
  JSON.stringify(vibeRegressionFixtures),
], { encoding: 'utf8' }));
const javascriptVibeResults = vibeRegressionFixtures.map(({ fields }) => ({
  vibes: inferVibes(fields),
  scores: scoreVibeEvidence(fields),
}));
assert.deepEqual(
  javascriptVibeResults,
  pythonVibeResults,
  'JavaScript and Python must return identical vibe scores, evidence, ordering, and selected vibes',
);

const sheetFixture = fall2026SheetFixture();
const originalPath = process.env.PATH;
let nodeOnlyPayload;
try {
  process.env.PATH = '/no-python-executable-is-available';
  nodeOnlyPayload = analyzeSheetValues(sheetFixture.title, sheetFixture.values);
} finally {
  process.env.PATH = originalPath;
}

assert.equal(nodeOnlyPayload.profiles.length, 2, 'Sheet analysis must run in-process without a Python executable');
const hazelProfile = nodeOnlyPayload.profiles[0];
assert.equal(hazelProfile.public.name, 'Hazel Tran');
assert.equal(hazelProfile.public.role, 'Little');
assert.equal(hazelProfile.public.interests[0], 'Little', 'Fall 2026 Little interests must keep the role prefix');
assert.equal(hazelProfile.public.hobbies, sheetFixture.hazelPublic.S);
assert.equal(hazelProfile.public.hobbyDetails, sheetFixture.hazelPublic.T);
assert.equal(hazelProfile.public.bio, sheetFixture.hazelPublic.BL);
assert.equal(
  hazelProfile.public.passion,
  'I could talk about crafts and concert memories for hours. Contact [email removed] or [phone removed].',
);
assert.equal(hazelProfile.public.passion.includes('hazel.private@example.com'), false);
assert.equal(hazelProfile.public.passion.includes('(408) 555-1212'), false);
assert.match(hazelProfile.public.passion, /\[email removed\].*\[phone removed\]/);
assert.equal(hazelProfile.driveFileId, '1HazelTranProfileImage2026');

const bigProfile = nodeOnlyPayload.profiles[1];
assert.equal(bigProfile.public.name, 'Logan Ho');
assert.equal(bigProfile.public.role, 'Big');
assert.equal(bigProfile.public.hobbies, 'Exploring new places, hiking, gaming, and trying new food.');
assert.equal(bigProfile.public.passion, 'Psychology and helping people grow.');
assert.equal(bigProfile.public.tagline, 'Be the change you want to see.');
assert.equal(bigProfile.public.socialLevel, 4);
assert.equal(bigProfile.public.socialStyle, 'Extrovert');
assert.equal(bigProfile.imageKind, 'drive-folder');

const publicSheetText = JSON.stringify(nodeOnlyPayload.profiles.map((profile) => profile.public));
for (const privateValue of [
  'PRIVATE DISLIKED ACTIVITY',
  'PRIVATE PET PEEVE',
  'PRIVATE PAIRING PREFERENCE',
  'PRIVATE CURFEW',
  'PRIVATE CONFIDENTIAL RESPONSE',
  'PRIVATE NEARBY FRIEND QUALITIES',
  'PRIVATE NEARBY LIFE GOALS',
  'PRIVATE BIG BLOCK PASSION',
]) assert.doesNotMatch(publicSheetText, new RegExp(privateValue), 'private conditional answers must not enter public profiles');
for (const privateKey of ['imageSourceUrl', 'driveFileId', 'driveFolderId', 'imageIssue', 'imageKind', 'sourceGroup', 'sourceRow', 'vibeScores', 'vibeEvidence', 'evidence']) {
  assert.equal(privateKey in hazelProfile.public, false, `${privateKey} must remain outside public profile data`);
}

const emptyLittlePassionFixture = fall2026SheetFixture();
setCell(emptyLittlePassionFixture.values[1], 'AH', '');
setCell(emptyLittlePassionFixture.values[1], 'CC', 'PRIVATE BIG BLOCK PASSION MUST NOT FALL BACK');
const emptyLittlePassion = analyzeSheetValues(
  emptyLittlePassionFixture.title,
  [emptyLittlePassionFixture.values[0], emptyLittlePassionFixture.values[1]],
).profiles[0].public;
assert.equal(emptyLittlePassion.role, 'Little');
assert.equal(emptyLittlePassion.passion, '', 'an empty Little passion must remain empty instead of falling through to the Big block');
assert.doesNotMatch(JSON.stringify(emptyLittlePassion), /PRIVATE BIG BLOCK PASSION MUST NOT FALL BACK/);

const parityDirectory = await mkdtemp(join(tmpdir(), 'ace-sheet-parity-'));
try {
  const parityInput = join(parityDirectory, 'sheet.json');
  await writeFile(parityInput, JSON.stringify(sheetFixture), { mode: 0o600 });
  const adapterResult = JSON.parse(execFileSync(process.execPath, [
    '--conditions=react-server',
    '--input-type=module',
    '-e',
    `import { readFile } from 'node:fs/promises';
     import { analyzeGoogleSheetValues } from './lib/import/google-sheet.js';
     const fixture = JSON.parse(await readFile(process.env.ACE_SHEET_PARITY_FIXTURE, 'utf8'));
     process.stdout.write(JSON.stringify(await analyzeGoogleSheetValues(fixture.title, fixture.values)));`,
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PATH: '/no-python-executable-is-available',
      ACE_SHEET_PARITY_FIXTURE: parityInput,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }));
  assert.deepEqual(
    withoutGeneratedAt(adapterResult.payload),
    withoutGeneratedAt(nodeOnlyPayload),
    'the production Sheet adapter must run without Python and preserve the normalized payload',
  );
  assert.match(adapterResult.sourceHash, /^[a-f0-9]{64}$/);

  const parityFixtures = [sheetFixture, ...legacyParityFixtures()];
  for (const [index, fixture] of parityFixtures.entries()) {
    const inputPath = join(parityDirectory, `sheet-${index}.json`);
    const outputPath = join(parityDirectory, `normalized-${index}.json`);
    await writeFile(inputPath, JSON.stringify(fixture), { mode: 0o600 });
    execFileSync('python3', ['scripts/analyze-sheet-values.py', inputPath, outputPath], {
      cwd: new URL('..', import.meta.url),
      stdio: 'pipe',
    });
    const excelImporterPayload = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(
      withoutGeneratedAt(analyzeSheetValues(fixture.title, fixture.values)),
      withoutGeneratedAt(excelImporterPayload),
      `Node Sheet normalization must match the canonical Python/Excel importer for ${fixture.title}`,
    );
  }
} finally {
  await rm(parityDirectory, { recursive: true, force: true });
}

assert.deepEqual(
  buildDatasetImportTargetFields(),
  { target_dataset_id: null, target_imported_at: null },
  'a new Sheet import must leave both target-version fields null',
);
const currentDatasetId = '123e4567-e89b-12d3-a456-426614174000';
const currentImportedAt = '2026-09-04T22:21:00.000Z';
assert.deepEqual(
  buildDatasetImportTargetFields({ datasetId: currentDatasetId, importedAt: currentImportedAt }),
  { target_dataset_id: currentDatasetId, target_imported_at: currentImportedAt },
  'an existing-dataset Sheet sync must store both target-version fields',
);
assert.throws(
  () => buildDatasetImportTargetFields({ datasetId: currentDatasetId }),
  /require both/,
  'a target dataset cannot be inserted without its imported-at version',
);
assert.throws(
  () => buildDatasetImportTargetFields({ importedAt: currentImportedAt }),
  /require both/,
  'an imported-at version cannot be inserted without its target dataset',
);

const sheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
assert.equal(parseGoogleSheetUrl(`https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`), sheetId);
for (const invalid of [
  '',
  'not a url',
  `http://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  `https://evil.example/spreadsheets/d/${sheetId}/edit`,
  'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
  'https://docs.google.com/spreadsheets/d/short/edit',
]) assert.throws(() => parseGoogleSheetUrl(invalid), GoogleSheetsError);

let requestedUrl = '';
let requestedOptions = null;
const metadata = await fetchSpreadsheetMetadata(sheetId, {
  accessToken: 'mock-service-account-token',
  fetchImpl: async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return Response.json({
      spreadsheetId: sheetId,
      properties: { title: 'Master Program Application Fall 2026' },
      sheets: [
        { properties: { sheetId: 2, title: 'Notes', index: 1, gridProperties: { rowCount: 20, columnCount: 4 } } },
        { properties: { sheetId: 1, title: 'Form Responses 1', index: 0, gridProperties: { rowCount: 50, columnCount: 102 } } },
      ],
    });
  },
});
assert.match(requestedUrl, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//);
assert.equal(requestedOptions.headers.Authorization, 'Bearer mock-service-account-token');
assert.equal(requestedOptions.cache, 'no-store');
assert.equal(metadata.title, 'Master Program Application Fall 2026');
assert.equal(metadata.tabs[0].title, 'Form Responses 1');
assert.equal(chooseWorksheet(metadata.tabs), 'Form Responses 1');
assert.equal(chooseWorksheet([{ id: 1, title: 'Only Tab' }]), 'Only Tab');
assert.equal(chooseWorksheet([{ id: 1, title: 'Responses A' }, { id: 2, title: 'Responses B' }]), '');

const values = await fetchWorksheetValues(sheetId, "Form Responses 1", {
  accessToken: 'mock-token',
  fetchImpl: async () => Response.json({ values: [['Timestamp', 'First'], ['now', 'Sarah']] }),
});
assert.deepEqual(values[1], ['now', 'Sarah']);
await assert.rejects(
  fetchWorksheetValues(sheetId, 'Empty', {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ values: [['Timestamp', 'First']] }),
  }),
  (error) => error.code === 'EMPTY_SHEET',
);

await assert.rejects(
  fetchSpreadsheetMetadata(sheetId, {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ error: { message: 'The caller does not have permission' } }, { status: 403 }),
  }),
  (error) => error.code === 'SHEET_UNAVAILABLE' && /as Viewer/.test(error.message),
);
await assert.rejects(
  fetchSpreadsheetMetadata(sheetId, {
    accessToken: 'mock-token',
    fetchImpl: async () => Response.json({ error: { message: 'Google Sheets API has not been used or is disabled' } }, { status: 403 }),
  }),
  (error) => error.code === 'API_DISABLED' && /Enable it/.test(error.message),
);

const currentRows = [
  {
    profile_id: 'logan-ho', ordinal: 0,
    public_data: { id: 'logan-ho', name: 'Logan Ho', role: 'Big', music: 'Old', hobbies: 'Same', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    drive_file_id: 'old-drive-file-id-12345', drive_folder_id: '', image_kind: 'drive-file', image_issue: '',
    storage_image_path: 'fall-2026/logan-ho/primary.jpg',
  },
  {
    profile_id: 'jamie-nguyen', ordinal: 1,
    public_data: { id: 'jamie-nguyen', name: 'Jamie Nguyen', role: 'Big', music: 'Same', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    drive_file_id: '', drive_folder_id: '', image_kind: 'missing', image_issue: 'missing', storage_image_path: null,
  },
];
const incoming = [
  {
    public: { ...currentRows[0].public_data, music: 'New' },
    driveFileId: 'new-drive-file-id-12345', driveFolderId: '', imageKind: 'drive-file', imageIssue: '',
  },
  {
    public: { id: 'sarah-nguyen', name: 'Sarah Nguyen', role: 'Big', music: '', instagram: '', vibes: [], majorGroup: 'Business', socialLevel: 3, socialStyle: 'Ambivert' },
    driveFileId: '', driveFolderId: '', imageKind: 'missing', imageIssue: 'missing',
  },
];
const diff = buildDatasetSyncDiff(currentRows, incoming);
assert.deepEqual(diff.counts, { added: 1, updated: 1, removed: 1 });
assert.equal(diff.added[0].name, 'Sarah Nguyen');
assert.deepEqual(diff.removed.map((profile) => profile.name), ['Jamie Nguyen']);
assert.ok(diff.updated[0].fields.includes('Music'));
assert.ok(diff.updated[0].fields.includes('Drive photo source (gallery preserved)'));
assert.equal('public_data' in diff.updated[0], false, 'diff summaries must not expose raw profile values');

const payload = {
  profiles: incoming,
  health: {
    totalProfiles: 2,
    roleCounts: { Little: 0, Big: 2, Family: 0 },
    instagramCount: 0,
    slideDeckCount: 0,
    imageStatus: { usable: 1, missingOrInvalid: 1, byKind: { 'drive-file': 1, missing: 1 } },
    missingFieldCounts: { missingInstagram: 2 },
    vibeDistribution: {},
    majorGroupDistribution: { Business: 2 },
    socialLevelDistribution: { 3: 2 },
    socialStyleDistribution: { Ambivert: 2 },
  },
  safeIssues: { missingInstagram: [{ id: 'logan-ho', name: 'Logan Ho', role: 'Big' }, { id: 'sarah-nguyen', name: 'Sarah Nguyen', role: 'Big' }] },
};
const merged = preserveMissingSourceProfiles(payload, currentRows, diff, {
  missingInstagram: [{ id: 'jamie-nguyen', name: 'Jamie Nguyen', role: 'Big' }],
});
assert.equal(merged.profiles.length, 3);
assert.equal(merged.profiles[2].public.id, 'jamie-nguyen');
assert.equal(merged.health.preservedMissingSourceCount, 1);
assert.equal(merged.profiles[2].public.storageImagePath, undefined);
assert.throws(() => validateSyncApplyAcknowledgement(diff, false), /Acknowledge/);
assert.doesNotThrow(() => validateSyncApplyAcknowledgement(diff, true));

const migration = await readFile(new URL('../supabase/migrations/202609040001_google_sheet_sync.sql', import.meta.url), 'utf8');
const applyFunction = migration.slice(migration.indexOf('create or replace function public.apply_dataset_sync'));
assert.match(applyFunction, /for update/);
assert.match(applyFunction, /on conflict \(dataset_id, profile_id\) do update/);
assert.match(applyFunction, /stored_count <> draft\.profile_count/);
assert.match(applyFunction, /target\.imported_at is distinct from draft\.target_imported_at/);
assert.doesNotMatch(applyFunction, /delete from public\.dataset_profiles/);
assert.doesNotMatch(applyFunction, /(?:delete|update|insert) (?:from |into )?public\.profile_images/);
assert.match(applyFunction, /acknowledge_removed is not true/);

const routePaths = [
  '../app/api/admin/datasets/sheets/connect/route.js',
  '../app/api/admin/datasets/sheets/analyze/route.js',
  '../app/api/admin/datasets/sync/apply/route.js',
];
for (const path of routePaths) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  assert.match(source, /authorizeAdminRequest\(request\)/, `${path} must require Admin authorization and trusted origin`);
}
const checkRoute = await readFile(new URL('../app/api/admin/datasets/sheets/analyze/route.js', import.meta.url), 'utf8');
assert.doesNotMatch(checkRoute, /applyDatasetSyncImport/, 'checking for updates must not apply dataset mutations');
assert.doesNotMatch(checkRoute, /createDatasetSyncImport|createDatasetImport\(\{[\s\S]*targetDatasetId/, 'checking for updates must not write a staging row');
assert.match(checkRoute, /prepareDatasetSync/, 'checking for updates should compute a read-only preview');
assert.match(checkRoute, /analyzeGoogleSheetValues/, 'Sheets must use the canonical importer adapter');
const sheetAnalyzer = await readFile(new URL('../lib/import/google-sheet.js', import.meta.url), 'utf8');
assert.doesNotMatch(sheetAnalyzer, /node:child_process|spawn\(|python3|analyze-sheet-values\.py/, 'deployed Sheet analysis must not invoke Python');
assert.match(sheetAnalyzer, /analyzeSheetValues/, 'deployed Sheet analysis must normalize values in-process');
const excelRoute = await readFile(new URL('../app/api/admin/datasets/analyze/route.js', import.meta.url), 'utf8');
assert.match(excelRoute, /analyzeWorkbookUpload/, 'manual Excel analysis must remain first-class');
assert.match(excelRoute, /if \(datasetId\) {[\s\S]*createDatasetSyncImport\(/, 'existing-dataset Excel previews must keep using shared sync targeting');
assert.match(excelRoute, /const draft = await createDatasetImport\(\{ metadata, payload, userId:/, 'new-dataset Excel previews must remain untargeted');
const datasetAdmin = await readFile(new URL('../lib/datasets/admin.js', import.meta.url), 'utf8');
assert.match(datasetAdmin, /\.select\('[^']*imported_at[^']*'\)[\s\S]*\.eq\('id', datasetId\)/, 'sync target reads must include the current imported_at version');
assert.match(datasetAdmin, /\.\.\.targetFields/, 'all preview inserts must use the paired target-field builder');
assert.doesNotMatch(datasetAdmin, /target_dataset_id:\s*targetDatasetId|target_imported_at:\s*targetImportedAt/, 'preview inserts must not assign target fields independently');
const driveAuth = await readFile(new URL('../lib/google-drive-server.js', import.meta.url), 'utf8');
assert.match(driveAuth, /spreadsheets\.readonly/);
const sheetsServer = await readFile(new URL('../lib/google-sheets-server.js', import.meta.url), 'utf8');
assert.match(sheetsServer, /import 'server-only'/);
assert.match(sheetsServer, /getDriveAuth\(\{ strict: true, serviceAccountOnly: true \}\)/);

console.log('Google Sheets URL, auth fetch, errors, selection, diff, safety, and authorization tests passed.');
