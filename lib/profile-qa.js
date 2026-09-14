import { createHash } from 'node:crypto';
import { detectPublicPiiKinds } from './import/profile-normalization.js';
import { normalizeProfileStory } from './profile-story.js';
import { resolveEffectivePublicProfile } from './profile-overrides.js';
import { detectPublicAppropriateness } from './profile-qa-language.js';

export const PROFILE_QA_SEVERITIES = Object.freeze({ PASS: 'pass', REVIEW: 'review', BLOCK: 'block' });
export const PROFILE_QA_CATEGORIES = Object.freeze({
  INCOMPLETE: 'incomplete',
  ORGANIZATION_REPRESENTATION: 'organization_representation',
  PUBLIC_APPROPRIATENESS: 'public_appropriateness',
  PII: 'pii',
  FORMATTING: 'formatting',
  OTHER_QUALITY: 'other_quality',
});

export const PROFILE_QA_CATEGORY_LABELS = Object.freeze({
  incomplete: 'Incomplete',
  organization_representation: 'Organization representation',
  public_appropriateness: 'Public appropriateness',
  pii: 'PII',
  formatting: 'Formatting',
  other_quality: 'Other quality concerns',
});

export const PROFILE_QA_FIELD_LABELS = Object.freeze({
  name: 'Name',
  pronouns: 'Pronouns',
  year: 'Year',
  major: 'Major',
  hobbies: 'Hobbies & activities',
  hobbyDetails: 'Hobby explanations',
  music: 'Current soundtrack',
  movies: 'Movies & shows',
  uniqueThings: 'Things that make me, me',
  tagline: 'Personality phrase',
  passion: 'I could talk about this for hours',
  perfectDay: 'My perfect day',
  idealHangout: 'Ideal hangout',
  bucketList: 'Bucket list',
  hotTake: 'My harmless hot take',
  bio: 'Public story',
});

const CONTENT_FIELDS = Object.freeze(Object.keys(PROFILE_QA_FIELD_LABELS));
const SUBSTANTIVE_FIELDS = new Set(['hobbies', 'hobbyDetails', 'music', 'uniqueThings', 'passion', 'perfectDay', 'bio']);
const LOW_INFORMATION_VALUES = new Set([
  'idk', 'i dont know', 'i do not know', 'n a', 'na', 'not sure', 'whatever', 'anything',
  'nothing', 'none', 'no idea', 'dont know', 'do not know', 'tbd', 'skip',
]);
const HTML_LIKE = /<\/?(?:script|iframe|form|style|div|span|body|html|object|embed|a)(?:\s|>|\/)/i;
const REPEATED_CHARACTERS = /(.)\1{14,}/u;
const URL_ONLY = /^https?:\/\/\S+$/i;
const REDACTION_MARKER = /\[(?:email|phone|private credential|embedded credential|link with embedded credentials) removed\]/i;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedWords(value) {
  return clean(value).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function profileQaSourceHash(field, value) {
  return createHash('sha256').update(`${field}\0${clean(value)}`).digest('hex');
}

function safePreview(value, pii = false) {
  if (pii) return '[Potential private information hidden in QA summary]';
  const compact = clean(value).replace(/\s+/g, ' ');
  return compact.length > 600 ? `${compact.slice(0, 597)}…` : compact;
}

function issue(field, value, category, severity, rule, reason, confidence = 'high') {
  return {
    category,
    severity,
    field,
    fieldLabel: PROFILE_QA_FIELD_LABELS[field] || field,
    reason,
    rule,
    confidence,
    sourceHash: profileQaSourceHash(field, value),
    sourcePreview: safePreview(value, category === PROFILE_QA_CATEGORIES.PII),
  };
}

function deduplicateIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = `${item.field}|${item.category}|${item.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listItems(value) {
  const text = clean(value);
  if (!text) return [];
  const numbered = text
    .replace(/(^|\s)(\d{1,2}[.)])\s+/g, '\n$2 ')
    .split(/\r?\n/)
    .map((item) => item.replace(/^\d{1,2}[.)]\s+/, '').trim())
    .filter(Boolean);
  if (numbered.length > 1) return numbered;
  const lines = text.split(/\r?\n|;/).map((item) => item.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const commas = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (
    text.length <= 300
    && commas.length >= 3
    && commas.every((item) => normalizedWords(item).split(/\s+/).filter(Boolean).length <= 8)
  ) return commas;
  const conjunctions = text.split(/\s+and\s+/i).map((item) => item.replace(/^[-*•,]\s*|[,;]\s*$/g, '').trim()).filter(Boolean);
  return text.length <= 240 && conjunctions.length >= 3 ? conjunctions : [text];
}

function explanationCount(profile) {
  const story = normalizeProfileStory(profile);
  const storyCount = story.hobbyItems.filter((item) => clean(item.detail)).length;
  const detailText = clean(profile.hobbyDetails);
  const sections = detailText
    .replace(/(^|\s)(\d{1,2}[.)])\s+/g, '\n$2 ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{1,2}[.)]\s+/, '').trim())
    .filter((line) => line.length >= 12).length;
  const proseSentences = detailText
    .split(/[.!?]+(?:\s+|$)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12).length;
  return Math.max(storyCount, sections, proseSentences);
}

function organizationRepresentationConcern(value) {
  const text = clean(value);
  if (!/\b(?:sjsu\s+vsa|vsa|ace|fam|our club|our organization|the club)\b/i.test(text)) return false;
  return [
    /\b(?:raving|partying|parties|raves?)\s+is\s+(?:sjsu\s+)?vsa\s+culture\b/i,
    /\b(?:sjsu\s+)?vsa\s+culture\b/i,
    /\b(?:everyone|everybody)\s+in\s+(?:sjsu\s+)?vsa\b/i,
    /\ball\s+(?:the\s+)?(?:sjsu\s+)?vsa\s+(?:people|members?)\b/i,
    /\b(?:vsa|ace|fam)\s+(?:people|members?)\s+(?:are|always|all|mostly)\b/i,
    /\b(?:vsa|ace|fam|our club|our organization|the club)\s+(?:is|are)\s+(?:basically|always|mostly|known for)\b/i,
    /\b(?:the club|our club|our organization)\s+is\s+known\s+for\b/i,
  ].some((pattern) => pattern.test(text));
}

function lowInformationIssue(field, value) {
  if (!SUBSTANTIVE_FIELDS.has(field)) return null;
  const normalized = normalizedWords(value);
  if (!LOW_INFORMATION_VALUES.has(normalized)) return null;
  return issue(
    field,
    value,
    PROFILE_QA_CATEGORIES.INCOMPLETE,
    PROFILE_QA_SEVERITIES.REVIEW,
    'low_information_response',
    'This field normally benefits from a substantive public answer, but the response contains very little usable information.',
  );
}

function formattingIssues(field, value) {
  const text = clean(value);
  const issues = [];
  if (HTML_LIKE.test(text)) {
    issues.push(issue(field, text, PROFILE_QA_CATEGORIES.FORMATTING, PROFILE_QA_SEVERITIES.REVIEW, 'malformed_html_like_content', 'This response contains HTML-like markup that may display poorly or include neighboring data.'));
  }
  if (REPEATED_CHARACTERS.test(text)) {
    issues.push(issue(field, text, PROFILE_QA_CATEGORIES.FORMATTING, PROFILE_QA_SEVERITIES.REVIEW, 'repeated_character_string', 'This response contains an unusually long repeated-character sequence that may be accidental.'));
  }
  if (URL_ONLY.test(text) && SUBSTANTIVE_FIELDS.has(field)) {
    issues.push(issue(field, text, PROFILE_QA_CATEGORIES.FORMATTING, PROFILE_QA_SEVERITIES.REVIEW, 'url_only_response', 'A URL was supplied where a meaningful public response was expected.'));
  }
  if (/\[(?:truncated|cut off|response clipped)\]/i.test(text) || (text.length >= 140 && /(?:\.{3}|…)$/.test(text))) {
    issues.push(issue(field, text, PROFILE_QA_CATEGORIES.FORMATTING, PROFILE_QA_SEVERITIES.REVIEW, 'possibly_truncated_response', 'This response appears to be truncated and should be checked against the source.'));
  }
  if (text.length >= 20 && /\b(?:and|but|because|so|then)\s*[.!?]*$/i.test(text)) {
    issues.push(issue(field, text, PROFILE_QA_CATEGORIES.OTHER_QUALITY, PROFILE_QA_SEVERITIES.REVIEW, 'unfinished_fragment', 'This response appears to end mid-thought.'));
  }
  return issues;
}

function appropriatenessIssue(field, value) {
  const text = clean(value);
  const concern = detectPublicAppropriateness(text);
  return concern ? issue(
    field,
    text,
    PROFILE_QA_CATEGORIES.PUBLIC_APPROPRIATENESS,
    PROFILE_QA_SEVERITIES.REVIEW,
    concern.rule,
    concern.reason,
    concern.confidence,
  ) : null;
}

export function auditPublicProfileContent(profile = {}, options = {}) {
  const issues = [];
  for (const field of CONTENT_FIELDS) {
    const value = clean(profile[field]);
    if (!value) continue;
    const piiKinds = detectPublicPiiKinds(value);
    if (piiKinds.length) {
      issues.push(issue(
        field,
        value,
        PROFILE_QA_CATEGORIES.PII,
        PROFILE_QA_SEVERITIES.BLOCK,
        'public_pii',
        `Possible ${piiKinds.join(' or ')} information was detected in a public field.`,
      ));
    } else if (REDACTION_MARKER.test(value)) {
      issues.push(issue(
        field,
        value,
        PROFILE_QA_CATEGORIES.PII,
        PROFILE_QA_SEVERITIES.REVIEW,
        'privacy_redaction_marker',
        'The import privacy filter removed private information from this response; review the remaining public wording.',
      ));
    }
    const lowInformation = lowInformationIssue(field, value);
    if (lowInformation) issues.push(lowInformation);
    issues.push(...formattingIssues(field, value));
    const appropriateness = appropriatenessIssue(field, value);
    if (appropriateness) issues.push(appropriateness);
    if (organizationRepresentationConcern(value)) {
      issues.push(issue(
        field,
        value,
        PROFILE_QA_CATEGORIES.ORGANIZATION_REPRESENTATION,
        PROFILE_QA_SEVERITIES.REVIEW,
        'broad_organization_characterization',
        'This response makes a broad characterization of VSA, ACE, FAM, or the club that may not accurately represent the organization publicly.',
      ));
    }
  }

  const datasetYear = Number(options.datasetYear || 0);
  const uniqueThings = clean(profile.uniqueThings);
  const uniqueThingCount = listItems(uniqueThings).length;
  const uniqueThingWordCount = normalizedWords(uniqueThings).split(/\s+/).filter(Boolean).length;
  if (
    uniqueThings
    && (datasetYear >= 2026 || options.expectUniqueThings === true)
    && uniqueThingCount < 3
    && uniqueThingWordCount < 18
  ) {
    issues.push(issue(
      'uniqueThings',
      uniqueThings,
      PROFILE_QA_CATEGORIES.INCOMPLETE,
      PROFILE_QA_SEVERITIES.REVIEW,
      'partial_unique_things',
      'The prompt requests 3–5 things, but this response appears to provide fewer than 3 meaningful items.',
    ));
  }

  const hobbies = listItems(profile.hobbies);
  const hobbyDetails = clean(profile.hobbyDetails);
  const explanations = explanationCount(profile);
  if (
    hobbies.length >= 4
    && hobbyDetails
    && explanations > 0
    && explanations <= Math.floor(hobbies.length / 2)
  ) {
    issues.push(issue(
      'hobbyDetails',
      hobbyDetails,
      PROFILE_QA_CATEGORIES.INCOMPLETE,
      PROFILE_QA_SEVERITIES.REVIEW,
      'hobby_explanation_count_mismatch',
      `${hobbies.length} hobbies are listed, but only ${explanations} appear to have explanations.`,
    ));
  }

  return deduplicateIssues(issues);
}

function issueKey(profileId, field, rule, sourceHash) {
  return `${profileId}|${field}|${rule}|${sourceHash}`;
}

function statusForIssues(issues) {
  if (issues.some((item) => item.severity === PROFILE_QA_SEVERITIES.BLOCK && item.resolution === 'unresolved')) return PROFILE_QA_SEVERITIES.BLOCK;
  if (issues.some((item) => item.resolution === 'unresolved')) return PROFILE_QA_SEVERITIES.REVIEW;
  return PROFILE_QA_SEVERITIES.PASS;
}

export function buildProfileContentQaReport({ dataset = {}, rows = [], dispositions = [] } = {}) {
  const allowedAsIs = new Set(dispositions
    .filter((item) => item.disposition === 'keep_as_submitted')
    .map((item) => issueKey(item.profile_id, item.field, item.rule, item.source_hash)));
  const profiles = rows.map((row) => {
    const source = row.public_data || row.public || row;
    const profileId = String(source.id || row.profile_id || '');
    const overrides = row.public_overrides || {};
    const sourceIssues = auditPublicProfileContent(source, { datasetYear: dataset.year });
    const effective = resolveEffectivePublicProfile(source, overrides);
    const effectiveIssues = auditPublicProfileContent(effective, { datasetYear: dataset.year });
    const issues = sourceIssues.map((sourceIssue) => {
      let resolution = 'unresolved';
      const hasOverride = Object.prototype.hasOwnProperty.call(overrides, sourceIssue.field);
      if (hasOverride && clean(overrides[sourceIssue.field]) === '') {
        resolution = 'hidden';
      } else if (hasOverride && !effectiveIssues.some((item) => (
        item.field === sourceIssue.field && item.rule === sourceIssue.rule
      ))) {
        resolution = 'override_active';
      } else if (
        sourceIssue.severity !== PROFILE_QA_SEVERITIES.BLOCK
        && allowedAsIs.has(issueKey(profileId, sourceIssue.field, sourceIssue.rule, sourceIssue.sourceHash))
      ) {
        resolution = 'allowed_as_is';
      }
      return {
        ...sourceIssue,
        resolution,
        overrideActive: hasOverride,
        effectivePreview: hasOverride
          ? safePreview(overrides[sourceIssue.field], sourceIssue.category === PROFILE_QA_CATEGORIES.PII)
          : '',
      };
    });
    return {
      id: profileId,
      name: String(source.name || source.id || row.profile_id || 'Unnamed profile'),
      role: String(source.role || ''),
      status: statusForIssues(issues),
      sourceStatus: sourceIssues.some((item) => item.severity === PROFILE_QA_SEVERITIES.BLOCK)
        ? PROFILE_QA_SEVERITIES.BLOCK
        : sourceIssues.length ? PROFILE_QA_SEVERITIES.REVIEW : PROFILE_QA_SEVERITIES.PASS,
      issueCount: issues.length,
      unresolvedIssueCount: issues.filter((item) => item.resolution === 'unresolved').length,
      unresolvedReviewIssueCount: issues.filter((item) => (
        item.resolution === 'unresolved' && item.severity === PROFILE_QA_SEVERITIES.REVIEW
      )).length,
      blockedIssueCount: issues.filter((item) => (
        item.resolution === 'unresolved' && item.severity === PROFILE_QA_SEVERITIES.BLOCK
      )).length,
      resolvedIssueCount: issues.filter((item) => item.resolution !== 'unresolved').length,
      publicOverridesUpdatedAt: row.public_overrides_updated_at || null,
      issues,
    };
  });
  const counts = { pass: 0, review: 0, block: 0 };
  const categoryCounts = Object.fromEntries(Object.values(PROFILE_QA_CATEGORIES).map((category) => [category, 0]));
  const sourceCategoryCounts = Object.fromEntries(Object.values(PROFILE_QA_CATEGORIES).map((category) => [category, 0]));
  for (const profile of profiles) {
    counts[profile.status] += 1;
    for (const item of profile.issues) {
      sourceCategoryCounts[item.category] += 1;
      if (item.resolution === 'unresolved') categoryCounts[item.category] += 1;
    }
  }
  const resolvedIssues = profiles.reduce((total, profile) => total + profile.resolvedIssueCount, 0);
  return {
    dataset: { id: dataset.id || '', name: dataset.name || '', year: dataset.year || null },
    summary: {
      totalProfiles: profiles.length,
      clearProfiles: profiles.filter((profile) => profile.issueCount === 0).length,
      resolvedProfiles: profiles.filter((profile) => profile.issueCount > 0 && profile.unresolvedIssueCount === 0).length,
      reviewProfiles: counts.review,
      blockedProfiles: counts.block,
      flaggedSourceProfiles: profiles.filter((profile) => profile.issueCount > 0).length,
      unresolvedIssues: profiles.reduce((total, profile) => total + profile.unresolvedIssueCount, 0),
      unresolvedReviewIssues: profiles.reduce((total, profile) => total + profile.unresolvedReviewIssueCount, 0),
      blockedIssues: profiles.reduce((total, profile) => total + profile.blockedIssueCount, 0),
      resolvedIssues,
      allowedAsIsIssues: profiles.reduce((total, profile) => (
        total + profile.issues.filter((item) => item.resolution === 'allowed_as_is').length
      ), 0),
      overrideProtectedIssues: profiles.reduce((total, profile) => (
        total + profile.issues.filter((item) => item.resolution === 'override_active').length
      ), 0),
      hiddenIssues: profiles.reduce((total, profile) => (
        total + profile.issues.filter((item) => item.resolution === 'hidden').length
      ), 0),
      counts,
      categoryCounts,
      sourceCategoryCounts,
    },
    profiles: profiles.filter((profile) => profile.issueCount > 0),
  };
}

export function buildContentQaPreview(payload, dataset = {}) {
  const rows = (payload?.profiles || []).map((profile) => ({ public_data: profile.public || profile }));
  const report = buildProfileContentQaReport({ dataset, rows });
  return {
    summary: report.summary,
    profiles: report.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      role: profile.role,
      status: profile.status,
      issueCount: profile.issueCount,
      categories: Array.from(new Set(profile.issues.map((item) => item.category))),
    })),
  };
}
