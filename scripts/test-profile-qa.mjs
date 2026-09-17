import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  auditPublicProfileContent,
  buildContentQaPreview,
  buildProfileContentQaReport,
  PROFILE_QA_CATEGORIES,
  PROFILE_QA_SEVERITIES,
} from '../lib/profile-qa.js';
import {
  buildSinglePublicOverridePatch,
  resolveEffectivePublicProfile,
} from '../lib/profile-overrides.js';
import { detectPublicAppropriateness } from '../lib/profile-qa-language.js';

function issues(profile, options = { datasetYear: 2026 }) {
  return auditPublicProfileContent({ id: 'qa-person', name: 'QA Person', ...profile }, options);
}

assert.deepEqual(issues({
  passion: 'I could talk about community photography because I love documenting meaningful moments with friends.',
  perfectDay: 'A calm morning hike, lunch with friends, and an evening spent making music.',
  hotTake: 'Breakfast food is best at night.',
}), [], 'substantive responses and a legitimate short hot take should pass');

const lowInformation = issues({ passion: 'idk' });
assert.equal(lowInformation.length, 1);
assert.equal(lowInformation[0].category, PROFILE_QA_CATEGORIES.INCOMPLETE);
assert.equal(lowInformation[0].severity, PROFILE_QA_SEVERITIES.REVIEW);
assert.equal(lowInformation[0].rule, 'low_information_response');
assert.deepEqual(issues({ hotTake: 'N/A' }), [], 'N/A should not be penalized in the optional short hot-take field');

const partialUniqueThings = issues({ uniqueThings: '1. I make handmade gifts' });
assert.equal(partialUniqueThings.some((item) => item.rule === 'partial_unique_things'), true);
assert.match(partialUniqueThings.find((item) => item.rule === 'partial_unique_things').reason, /fewer than 3/);
assert.equal(issues({ uniqueThings: '1. I make gifts\n2. I collect records\n3. I love creative nails' }).length, 0);

const hobbyMismatch = issues({
  hobbies: 'Baking\nCrocheting\nConcerts\nMovies\nTraveling',
  hobbyDetails: 'Baking: I make treats for friends.\nCrocheting: I make gifts for people.',
});
const mismatch = hobbyMismatch.find((item) => item.rule === 'hobby_explanation_count_mismatch');
assert.ok(mismatch);
assert.match(mismatch.reason, /5 hobbies.*only 2/i);
assert.equal(issues({
  hobbies: 'Baking, Crocheting, Concerts, Movies, Traveling',
  hobbyDetails: '1. Baking: I make treats for friends. 2. Crocheting: I make gifts for people. 3. Concerts: I enjoy live music. 4. Movies: I like sharing stories. 5. Traveling: I enjoy seeing new places.',
}).some((item) => item.rule === 'hobby_explanation_count_mismatch'), false, 'inline numbered explanations should count as complete');
assert.equal(issues({
  hobbies: 'Baking, Crocheting, Concerts, Movies, Traveling',
  hobbyDetails: 'Baking lets me share treats with friends. Crocheting helps me relax after class. Concerts make live music feel communal. Movies let me experience new stories. Traveling helps me understand new places.',
}).some((item) => item.rule === 'hobby_explanation_count_mismatch'), false, 'substantive prose explanations should not require list formatting');
assert.equal(issues({
  uniqueThings: 'I am a curious community builder who makes people feel welcome through cooking, photography, and planning thoughtful events for friends.',
}).some((item) => item.rule === 'partial_unique_things'), false, 'substantive unstructured answers should not be penalized for list formatting');

const inappropriate = issues({ hotTake: 'I will fucking kill anyone who disagrees.' });
assert.equal(inappropriate.filter((item) => item.category === PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS).length, 1);
assert.equal(inappropriate.find((item) => item.category === PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS).severity, PROFILE_QA_SEVERITIES.REVIEW);
assert.deepEqual(issues({ hotTake: 'That movie was hella funny, but the ending was not my thing.' }), [], 'mild slang must not automatically trigger appropriateness review');

for (const response of [
  'fuck it',
  'f*ck it',
  'fu*k it',
  'f**k it',
  'f_ck it',
  'f-ck it',
  'f—ck it',
  'f u c k it',
  'shit happens',
  'sh*t happens',
  's**t happens',
  'b*tch please',
  'b**ch please',
  'a**hole behavior',
]) {
  const result = issues({ hotTake: response });
  assert.equal(result.filter((item) => item.category === PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS).length, 1, `curated inappropriate-language variant should be reviewed: ${response}`);
  assert.equal(result.find((item) => item.category === PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS).severity, PROFILE_QA_SEVERITIES.REVIEW);
}

const obfuscatedRegressionText = 'Fu*k It (we ball) sometimes i include the text in the parenthesis and You Do You!';
const obfuscatedRegression = issues({ hotTake: obfuscatedRegressionText });
assert.equal(obfuscatedRegression.length, 1);
assert.equal(obfuscatedRegression[0].category, PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS);
assert.equal(obfuscatedRegression[0].rule, 'profanity');
assert.match(obfuscatedRegression[0].reason, /censored or obfuscated profanity/i);
assert.equal(obfuscatedRegression[0].sourcePreview, obfuscatedRegressionText, 'the complete source response must remain visible to Admin for ordinary REVIEW language');
assert.equal(detectPublicAppropriateness('You Do You!'), null, 'the harmless phrase adjacent to the regression must not be treated as the concern');

for (const harmless of [
  'You Do You!',
  "bruh that's crazy",
  'lowkey I love this',
  'lol that is such a vibe',
  'I keep yapping about music because that is me',
  'That performance was badass.',
  'I submitted my class assignment on classical music.',
  'I like passionfruit, shiitake mushrooms, and cocktail-making.',
  'The café has fish, it serves tea, and the shuttle arrives at noon.',
  'My friend Dick studies in Scunthorpe.',
  'F. U. N. cooking nights are my favorite.',
]) {
  assert.equal(detectPublicAppropriateness(harmless), null, `harmless wording must not false-positive: ${harmless}`);
}

const pii = issues({ passion: 'Email me at private.person@example.com about photography.' });
assert.equal(pii.length, 1);
assert.equal(pii[0].category, PROFILE_QA_CATEGORIES.PII);
assert.equal(pii[0].severity, PROFILE_QA_SEVERITIES.BLOCK);
assert.equal(pii[0].confidence, 'high');
assert.doesNotMatch(pii[0].sourcePreview, /private\.person|@/);

for (const benign of [
  'I personally do not like raves.',
  'I personally do not enjoy raves.',
  'I love going to concerts and raves.',
  'I joined VSA because I wanted to connect with the Vietnamese community.',
  'VSA helped me make friends.',
  'I went to a rave with friends.',
]) {
  assert.deepEqual(issues({ hotTake: benign }), [], `benign personal statement should pass: ${benign}`);
}

for (const representational of [
  'I know raving is VSA culture but I dislike the idea of it.',
  'Everyone in VSA parties.',
  'ACE is basically just a social club.',
  'The club is known for partying.',
]) {
  const result = issues({ hotTake: representational });
  assert.equal(result.filter((item) => item.category === PROFILE_QA_CATEGORIES.ORGANIZATION_REPRESENTATION).length, 1);
  assert.equal(result.find((item) => item.category === PROFILE_QA_CATEGORIES.ORGANIZATION_REPRESENTATION).severity, PROFILE_QA_SEVERITIES.REVIEW);
  assert.equal(result.some((item) => item.category === PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS), false, 'organization representation must remain a separate category');
}

const duplicateCandidate = issues({ hotTake: 'Raving is VSA culture, and VSA is basically known for parties.' });
assert.equal(duplicateCandidate.filter((item) => item.rule === 'broad_organization_characterization').length, 1, 'overlapping deterministic matches must deduplicate');

const sourceProfile = {
  id: 'andrew-cam',
  name: 'Andrew Cam',
  role: 'Big',
  hotTake: 'I know raving is VSA culture but I dislike the idea of it.',
};
const sourceIssue = auditPublicProfileContent(sourceProfile, { datasetYear: 2026 })[0];
const approvedReport = buildProfileContentQaReport({
  dataset: { id: 'dataset', name: 'Fall 2026', year: 2026 },
  rows: [{ profile_id: sourceProfile.id, public_data: sourceProfile, public_overrides: {} }],
  dispositions: [{
    profile_id: sourceProfile.id,
    field: sourceIssue.field,
    rule: sourceIssue.rule,
    source_hash: sourceIssue.sourceHash,
    disposition: 'keep_as_submitted',
  }],
});
assert.equal(approvedReport.profiles[0].issues[0].resolution, 'allowed_as_is');
assert.equal(approvedReport.profiles[0].status, PROFILE_QA_SEVERITIES.PASS);
assert.equal(approvedReport.profiles[0].unresolvedIssueCount, 0);
assert.equal(approvedReport.summary.reviewProfiles, 0);
assert.equal(approvedReport.summary.resolvedProfiles, 1);
assert.equal(approvedReport.summary.allowedAsIsIssues, 1);
assert.deepEqual(approvedReport.profiles[0].issues[0].sourcePreview, sourceProfile.hotTake);
assert.deepEqual(resolveEffectivePublicProfile(sourceProfile, {}), sourceProfile, 'Allow as-is must not change the effective public value');
assert.deepEqual(approvedReport.profiles[0].issues[0].overrideActive, false, 'Allow as-is must not create a public override');

const reopenedReport = buildProfileContentQaReport({
  dataset: { id: 'dataset', name: 'Fall 2026', year: 2026 },
  rows: [{ profile_id: sourceProfile.id, public_data: sourceProfile, public_overrides: {} }],
  dispositions: [],
});
assert.equal(reopenedReport.profiles[0].issues[0].resolution, 'unresolved');
assert.equal(reopenedReport.summary.reviewProfiles, 1);
assert.equal(reopenedReport.summary.unresolvedReviewIssues, 1);
assert.deepEqual(reopenedReport.profiles[0].issues[0].sourcePreview, sourceProfile.hotTake, 'Reopen must not change the source');
assert.deepEqual(resolveEffectivePublicProfile(sourceProfile, {}), sourceProfile, 'Reopen must not change effective public content or overrides');

const changedSource = { ...sourceProfile, hotTake: `${sourceProfile.hotTake} I still feel that way.` };
const changedReport = buildProfileContentQaReport({
  dataset: { year: 2026 },
  rows: [{ profile_id: changedSource.id, public_data: changedSource, public_overrides: {} }],
  dispositions: [{
    profile_id: sourceProfile.id,
    field: sourceIssue.field,
    rule: sourceIssue.rule,
    source_hash: sourceIssue.sourceHash,
    disposition: 'keep_as_submitted',
  }],
});
assert.equal(changedReport.profiles[0].issues[0].resolution, 'unresolved', 'changed source content must invalidate the prior source-hash approval');

const blockedDispositionReport = buildProfileContentQaReport({
  dataset: { year: 2026 },
  rows: [{ profile_id: 'pii-person', public_data: { id: 'pii-person', name: 'PII Person', passion: 'Email private.person@example.com' }, public_overrides: {} }],
  dispositions: [{
    profile_id: 'pii-person',
    field: 'passion',
    rule: 'public_pii',
    source_hash: issues({ passion: 'Email private.person@example.com' }).find((item) => item.rule === 'public_pii').sourceHash,
    disposition: 'keep_as_submitted',
  }],
});
assert.equal(blockedDispositionReport.profiles[0].issues[0].resolution, 'unresolved', 'BLOCK issues must ignore an ordinary Allow-as-is disposition');
assert.equal(blockedDispositionReport.summary.blockedProfiles, 1);

const originalSource = structuredClone(sourceProfile);
const editedOverrides = buildSinglePublicOverridePatch(sourceProfile, {}, 'hotTake', 'Raves are not personally my thing.');
assert.deepEqual(editedOverrides, { hotTake: 'Raves are not personally my thing.' });
assert.deepEqual(sourceProfile, originalSource, 'editing the public version must not mutate imported source data');
assert.equal(resolveEffectivePublicProfile(sourceProfile, editedOverrides).hotTake, 'Raves are not personally my thing.');
const overriddenReport = buildProfileContentQaReport({
  dataset: { year: 2026 },
  rows: [{ profile_id: sourceProfile.id, public_data: sourceProfile, public_overrides: editedOverrides }],
});
assert.equal(overriddenReport.profiles[0].issues[0].resolution, 'override_active');
assert.equal(overriddenReport.profiles[0].status, PROFILE_QA_SEVERITIES.PASS);
assert.equal(overriddenReport.profiles[0].sourceStatus, PROFILE_QA_SEVERITIES.REVIEW);
assert.equal(overriddenReport.summary.overrideProtectedIssues, 1);

const hiddenOverrides = buildSinglePublicOverridePatch(sourceProfile, {}, 'hotTake', '');
assert.deepEqual(hiddenOverrides, { hotTake: '' }, 'hide must use an explicit-empty public override');
assert.equal(resolveEffectivePublicProfile(sourceProfile, hiddenOverrides).hotTake, '');
assert.deepEqual(sourceProfile, originalSource, 'hiding a field must preserve imported source data');
const hiddenReport = buildProfileContentQaReport({
  dataset: { year: 2026 },
  rows: [{ profile_id: sourceProfile.id, public_data: sourceProfile, public_overrides: hiddenOverrides }],
});
assert.equal(hiddenReport.profiles[0].issues[0].resolution, 'hidden');
assert.equal(hiddenReport.summary.hiddenIssues, 1);

const previewPayload = { profiles: [{ public: sourceProfile }] };
const workbookPreview = buildContentQaPreview(previewPayload, { year: 2026 });
const sheetPreview = buildContentQaPreview(structuredClone(previewPayload), { year: 2026 });
assert.deepEqual(workbookPreview, sheetPreview, 'Sheet and Excel canonical public profiles must receive identical content QA');

const formatting = issues({ passion: '<script>alert(1)</script>' });
assert.equal(formatting.some((item) => item.category === PROFILE_QA_CATEGORIES.FORMATTING), true);
assert.deepEqual(issues({ aceTraitSlideUrl: '' }), [], 'the optional ACE Trait slide must not create missing-field QA');
assert.deepEqual(
  issues({ aceTraitSlideUrl: 'https://www.canva.com/design/optional-slide/view' }),
  [],
  'a valid optional slide URL is not a substantive-response QA field',
);

const routeSource = await readFile(new URL('../app/api/admin/datasets/profile-qa/route.js', import.meta.url), 'utf8');
const serverSource = await readFile(new URL('../lib/profile-qa-server.js', import.meta.url), 'utf8');
const adminPageSource = await readFile(new URL('../app/admin/page.js', import.meta.url), 'utf8');
const adminQaSource = await readFile(new URL('../components/AdminProfileQa.js', import.meta.url), 'utf8');
const publicDatasetSource = await readFile(new URL('../lib/datasets/public.js', import.meta.url), 'utf8');
const publicOverrideMigration = await readFile(new URL('../supabase/migrations/202609100001_public_profile_overrides.sql', import.meta.url), 'utf8');
const qaMigration = await readFile(new URL('../supabase/migrations/202609140001_profile_content_qa_dispositions.sql', import.meta.url), 'utf8');
const workbookRouteSource = await readFile(new URL('../app/api/admin/datasets/analyze/route.js', import.meta.url), 'utf8');
const sheetRouteSource = await readFile(new URL('../app/api/admin/datasets/sheets/analyze/route.js', import.meta.url), 'utf8');
const structuralQaSource = await readFile(new URL('../lib/import/profile-normalization.js', import.meta.url), 'utf8');

assert.match(routeSource, /authorizeAdminRequest\(request\)/);
assert.match(routeSource, /action === 'allow'/);
assert.match(routeSource, /action === 'reopen'/);
assert.match(routeSource, /action === 'edit' \|\| action === 'hide'/);
assert.match(serverSource, /updateAdminPublicProfile/);
assert.match(serverSource, /buildSinglePublicOverridePatch/);
assert.match(serverSource, /export async function allowProfileQaIssue/);
assert.match(serverSource, /export async function reopenProfileQaIssue/);
assert.match(serverSource, /\.from\('profile_content_qa_dispositions'\)[\s\S]{0,120}\.delete\(\)/, 'Reopen must remove only the matching disposition');
assert.match(serverSource, /Blocked privacy issues cannot be allowed as-is/);
const allowFunctionSource = serverSource.match(/export async function allowProfileQaIssue[\s\S]+?(?=\nexport async function reopenProfileQaIssue)/)?.[0] || '';
const reopenFunctionSource = serverSource.match(/export async function reopenProfileQaIssue[\s\S]+?(?=\nexport async function updateQaPublicField)/)?.[0] || '';
assert.doesNotMatch(allowFunctionSource, /updateAdminPublicProfile|buildSinglePublicOverridePatch|public_overrides/, 'Allow as-is must only write QA disposition metadata');
assert.doesNotMatch(reopenFunctionSource, /updateAdminPublicProfile|buildSinglePublicOverridePatch|dataset_profiles|public_overrides/, 'Reopen must only remove QA disposition metadata');
assert.doesNotMatch(serverSource, /\.from\('dataset_profiles'\)[\s\S]{0,220}\.update\(/, 'QA actions must not update imported source rows directly');
assert.match(adminPageSource, /AdminProfileQa/);
assert.match(adminQaSource, /Allow as-is/);
assert.match(adminQaSource, /Reopen review/);
assert.match(adminQaSource, /Edit public version/);
assert.match(adminQaSource, /Hide field/);
assert.match(adminQaSource, /Open full profile/);
assert.match(adminQaSource, /Needs review/);
assert.match(adminQaSource, /Resolved/);
assert.match(adminQaSource, /Blocked/);
assert.doesNotMatch(publicDatasetSource, /profile-qa|contentQa|qa_disposition|sourceHash/);
assert.doesNotMatch(publicOverrideMigration, /profile_content_qa|contentQa|qa_disposition/);
assert.match(qaMigration, /profile_content_qa_dispositions/);
assert.match(qaMigration, /source_hash text not null/);
assert.match(qaMigration, /revoke all on public\.profile_content_qa_dispositions from public, anon, authenticated/);
assert.match(qaMigration, /grant select, insert, update, delete on public\.profile_content_qa_dispositions to service_role/, 'the existing disposition schema already permits exact-row reopen deletion');
assert.doesNotMatch(qaMigration, /grant .* to anon|grant .* to authenticated/);
assert.match(workbookRouteSource, /buildContentQaPreview\(payload/);
assert.match(sheetRouteSource, /buildContentQaPreview\(/);
assert.match(structuralQaSource, /function buildImportHealth\(profiles\)/, 'existing structural QA remains a separate layer');
assert.match(structuralQaSource, /safeIssues/);

for (const source of [routeSource, serverSource, adminQaSource]) {
  assert.doesNotMatch(source, /openai|anthropic|moderation api|embedding/i, 'content QA must remain deterministic and local');
}

console.log('Deterministic public profile content QA, review dispositions, overrides, privacy, and parity tests passed.');
