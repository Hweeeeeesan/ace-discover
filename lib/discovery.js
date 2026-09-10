import { datasetDiscoveryKey } from './datasets/model.js';
import { normalizeMajorGroup } from './import/major-group.js';
import { scoreVibeEvidence } from './import/vibe-evidence.js';

export const DISCOVERY_STORAGE_KEY = 'profile-gallery:discovery-v2';
export const DISCOVERY_NAV_KEY = 'profile-gallery:discovery-navigation';

export function discoveryStorageKey(datasetSlug = 'fall-2025') {
  return datasetDiscoveryKey(datasetSlug);
}

export function discoveryNavigationKey(datasetSlug = 'fall-2025') {
  return `${DISCOVERY_NAV_KEY}:${datasetSlug}`;
}
export const VIBE_OPTIONS = [
  'Foodie', 'Outdoors', 'Gaming', 'Music', 'Creative', 'Fitness', 'Sports',
  'Travel', 'Movies & TV', 'Anime', 'Nightlife', 'Coffee & Cafes', 'Studying',
  'Fashion', 'Photography', 'Volunteering',
];
export const YEAR_OPTIONS = [
  'First year', 'Second year', 'Third year', 'Fourth year+', 'Graduate / Other',
];
export const MAJOR_GROUP_OPTIONS = [
  'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
  'Social Sciences', 'Arts, Media & Design', 'Education & Humanities',
  'Other / Undeclared',
];
export const SOCIAL_STYLE_OPTIONS = ['Introvert', 'Ambivert', 'Extrovert'];

export const DEFAULT_FILTERS = Object.freeze({
  vibes: [],
  years: [],
  majorGroups: [],
  socialLevelMin: 1,
  socialLevelMax: 5,
  socialStyles: [],
});

const ROLE_ORDER = ['Little', 'Big', 'Family'];

export function getAvailableRoles(profiles = []) {
  const counts = { Little: 0, Big: 0, Family: 0 };
  profiles.forEach((profile) => {
    if (profile?.role in counts) counts[profile.role] += 1;
  });
  return ROLE_ORDER.filter((role) => counts[role] > 0);
}

export function normalizeText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#']+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanLabel(value = '') {
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (text === text.toLowerCase()) {
    return text.replace(/\b\w/g, (character) => character.toUpperCase());
  }
  return text;
}

export function canonicalYear(value = '') {
  const normalized = normalizeText(value);
  if (!normalized || normalized.includes('not listed')) return '';
  if (/^(first|1st|1st year|freshman|year 1|1 year|first year)$/.test(normalized)) return 'First year';
  if (/^(second|2nd|2nd year|sophomore|year 2|2 year|second year)$/.test(normalized)) return 'Second year';
  if (/^(third|3rd|3rd year|junior|year 3|3 year|third year)$/.test(normalized)) return 'Third year';
  if (/^(fourth|4th|4th year|senior|year 4|4 year|fourth year|fourth year\+)$/.test(normalized)) return 'Fourth year+';
  if (normalized.includes('fifth') || normalized.includes('5th')) return 'Fourth year+';
  if (
    normalized.includes('grad') ||
    normalized.includes('master') ||
    normalized.includes('doctoral') ||
    normalized.includes('phd')
  ) {
    return 'Graduate / Other';
  }
  return 'Graduate / Other';
}

export function optionKey(value = '') {
  return normalizeText(value);
}

function addOption(map, rawValue, canonicalizer = cleanLabel) {
  const label = canonicalizer(rawValue);
  const value = optionKey(label);
  if (!value) return;

  const existing = map.get(value);
  if (existing) {
    existing.count += 1;
    return;
  }

  map.set(value, { value, label, count: 1 });
}

function sortedOptions(map, preferredOrder = []) {
  const order = new Map(preferredOrder.map((label, index) => [optionKey(label), index]));
  return Array.from(map.values()).sort((left, right) => {
    const leftOrder = order.has(left.value) ? order.get(left.value) : Number.MAX_SAFE_INTEGER;
    const rightOrder = order.has(right.value) ? order.get(right.value) : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
  });
}

export function getDiscoveryOptions(profiles) {
  const yearMap = new Map();
  const majorGroupMap = new Map(
    MAJOR_GROUP_OPTIONS.map((label) => [optionKey(label), { value: optionKey(label), label, count: 0 }]),
  );
  const roleCounts = { Little: 0, Big: 0, Family: 0 };

  profiles.forEach((profile) => {
    addOption(yearMap, profile.year, canonicalYear);
    const effectiveMajorGroup = normalizeMajorGroup(profile.major);
    const majorGroup = MAJOR_GROUP_OPTIONS.includes(effectiveMajorGroup)
      ? effectiveMajorGroup
      : 'Other / Undeclared';
    majorGroupMap.get(optionKey(majorGroup)).count += 1;
    if (profile.role in roleCounts) roleCounts[profile.role] += 1;
  });

  return {
    years: sortedOptions(yearMap, YEAR_OPTIONS),
    majorGroups: sortedOptions(majorGroupMap, MAJOR_GROUP_OPTIONS),
    roleCounts,
  };
}

export function sanitizeFilters(filters = {}) {
  const numericMin = Number(filters.socialLevelMin);
  const numericMax = Number(filters.socialLevelMax);
  const min = Number.isFinite(numericMin) ? Math.min(5, Math.max(1, Math.round(numericMin))) : 1;
  const max = Number.isFinite(numericMax) ? Math.min(5, Math.max(1, Math.round(numericMax))) : 5;
  const vibes = Array.isArray(filters.vibes)
    ? [...new Set(filters.vibes.filter((value) => VIBE_OPTIONS.includes(value)))]
    : Array.isArray(filters.selectedVibes)
      ? [...new Set(filters.selectedVibes.filter((value) => VIBE_OPTIONS.includes(value)))]
      : [];
  const years = Array.isArray(filters.years)
    ? [...new Set(filters.years
      .filter((value) => typeof value === 'string')
      .map((value) => optionKey(canonicalYear(value)))
      .filter((value) => YEAR_OPTIONS.map(optionKey).includes(value)))]
    : [];
  const majorGroups = Array.isArray(filters.majorGroups)
    ? [...new Set(filters.majorGroups
      .filter((value) => typeof value === 'string')
      .map(optionKey)
      .filter((value) => MAJOR_GROUP_OPTIONS.map(optionKey).includes(value)))]
    : [];
  return {
    vibes: vibes.slice(0, VIBE_OPTIONS.length),
    years: years.slice(0, YEAR_OPTIONS.length),
    majorGroups: majorGroups.slice(0, MAJOR_GROUP_OPTIONS.length),
    socialLevelMin: Math.min(min, max),
    socialLevelMax: Math.max(min, max),
    socialStyles: Array.isArray(filters.socialStyles)
      ? filters.socialStyles.filter((value) => SOCIAL_STYLE_OPTIONS.includes(value)).slice(0, 3)
      : [],
  };
}

export function countAdvancedFilters(filters = DEFAULT_FILTERS) {
  const safe = sanitizeFilters(filters);
  return safe.vibes.length
    + safe.years.length
    + safe.majorGroups.length
    + Number(safe.socialLevelMin !== 1 || safe.socialLevelMax !== 5)
    + safe.socialStyles.length;
}

export function migrateDiscoveryState(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const numericSeed = Number(source.seed);
  const numericScrollTop = Number(source.scrollTop);
  const storedFilters = source.filters && typeof source.filters === 'object' ? source.filters : {};
  const legacyVibes = Array.isArray(storedFilters.vibes)
    ? storedFilters.vibes
    : source.selectedVibes;

  return {
    query: typeof source.query === 'string' ? source.query.slice(0, 160) : '',
    role: ['All', 'Little', 'Big', 'Family'].includes(source.role) ? source.role : 'All',
    unseen: source.unseen === true || source.mode === 'Unseen',
    saved: source.saved === true,
    filters: sanitizeFilters({ ...storedFilters, vibes: legacyVibes }),
    seed: Number.isFinite(numericSeed) && numericSeed > 0 ? numericSeed : createSeed(),
    encounteredOrderIds: Array.isArray(source.encounteredOrderIds)
      ? source.encounteredOrderIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)
      : null,
    seenOrderIds: Array.isArray(source.seenOrderIds)
      ? source.seenOrderIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)
      : null,
    activeProfileId: typeof source.activeProfileId === 'string' ? source.activeProfileId : '',
    scrollTop: Number.isFinite(numericScrollTop) && numericScrollTop >= 0 ? numericScrollTop : 0,
  };
}

export const PUBLIC_SEARCH_FIELDS = Object.freeze([
  { field: 'name', label: 'Name', weight: 420 },
  { field: 'major', label: 'Major', weight: 260 },
  { field: 'majorGroup', label: 'Major Area', weight: 245 },
  { field: 'interests', label: 'Interests', weight: 230 },
  { field: 'vibes', label: 'Vibes', weight: 210 },
  { field: 'role', label: 'Role', weight: 185 },
  { field: 'year', label: 'Year', weight: 175 },
  { field: 'school', label: 'School', weight: 135 },
  { field: 'program', label: 'Program', weight: 115 },
  { field: 'tagline', label: 'Tagline', weight: 100 },
  { field: 'pronouns', label: 'Pronouns', weight: 95 },
  { field: 'bio', label: 'Profile Story', weight: 85 },
  { field: 'hobbies', label: 'Hobbies', weight: 78 },
  { field: 'hobbyDetails', label: 'Hobby Details', weight: 76 },
  { field: 'passion', label: 'Passion', weight: 74 },
  { field: 'music', label: 'Music', weight: 72 },
  { field: 'movies', label: 'Movies & Shows', weight: 68 },
  { field: 'perfectDay', label: 'Perfect Day', weight: 62 },
  { field: 'idealHangout', label: 'Ideal Hangout', weight: 60 },
  { field: 'bucketList', label: 'Bucket List', weight: 58 },
  { field: 'uniqueThings', label: 'Unique Things', weight: 56 },
  { field: 'family', label: 'Family', weight: 55 },
  { field: 'hotTake', label: 'Hot Take', weight: 54 },
  { field: 'socialStyle', label: 'Social Style', weight: 50 },
]);

const SEARCH_FIELD_BY_KEY = new Map(PUBLIC_SEARCH_FIELDS.map((field) => [field.field, field]));
const DEEP_SEARCH_PRIORITY = [
  'hobbies', 'hobbyDetails', 'passion', 'idealHangout', 'perfectDay',
  'bucketList', 'uniqueThings', 'bio', 'music', 'movies', 'hotTake',
];
const VIBE_EVIDENCE_FIELD_MAP = Object.freeze({ story: 'bio' });
const searchDocumentCache = new WeakMap();
const vibeEvidenceCache = new WeakMap();

export function normalizePublicText(value = '') {
  const text = Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' || typeof item === 'number').join(' · ')
    : (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function publicFieldValue(profile, field) {
  if (field === 'year') {
    const year = normalizePublicText(profile.year);
    return [year, canonicalYear(year)].filter(Boolean).join(' · ');
  }
  if (field === 'majorGroup') return normalizeMajorGroup(profile.major);
  return normalizePublicText(profile[field]);
}

export function buildPublicSearchDocument(profile = {}) {
  if (profile && typeof profile === 'object' && searchDocumentCache.has(profile)) {
    return searchDocumentCache.get(profile);
  }

  const document = PUBLIC_SEARCH_FIELDS.map(({ field, label, weight }) => {
    const text = publicFieldValue(profile, field);
    return { field, label, text, normalizedText: normalizeText(text), weight };
  }).filter(({ normalizedText }) => Boolean(normalizedText));

  if (profile && typeof profile === 'object') searchDocumentCache.set(profile, document);
  return document;
}

function foldForHighlight(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase();
}

function highlightRanges(text, query) {
  const foldedText = foldForHighlight(text);
  const tokens = [...new Set(normalizeText(query).split(' ').filter(Boolean))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const ranges = [];

  tokens.forEach((token) => {
    let fromIndex = 0;
    while (fromIndex < foldedText.length) {
      const start = foldedText.indexOf(token, fromIndex);
      if (start === -1) break;
      const end = start + token.length;
      if (!ranges.some((range) => start < range.end && end > range.start)) ranges.push({ start, end });
      fromIndex = Math.max(end, start + 1);
    }
  });

  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function trimSnippetWindow(text, matchStart, matchEnd, maxLength) {
  if (text.length <= maxLength) return { text, offset: 0, prefix: false, suffix: false };
  const matchCenter = Math.floor((matchStart + matchEnd) / 2);
  let start = Math.max(0, matchCenter - Math.floor(maxLength / 2));
  let end = Math.min(text.length, start + maxLength);
  start = Math.max(0, end - maxLength);

  if (start > 0) {
    const nextSpace = text.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < matchStart) start = nextSpace + 1;
  }
  if (end < text.length) {
    const previousSpace = text.lastIndexOf(' ', end);
    if (previousSpace > matchEnd) end = previousSpace;
  }

  return {
    text: text.slice(start, end).trim(),
    offset: start,
    prefix: start > 0,
    suffix: end < text.length,
  };
}

export function createMatchSnippet(value, query, maxLength = 148) {
  const text = normalizePublicText(value);
  const ranges = highlightRanges(text, query);
  if (!text || !ranges.length) return null;

  const window = trimSnippetWindow(text, ranges[0].start, ranges[0].end, maxLength);
  const visibleRanges = ranges
    .map((range) => ({ start: range.start - window.offset, end: range.end - window.offset }))
    .filter((range) => range.start >= 0 && range.end <= window.text.length);
  const parts = [];
  let cursor = 0;
  visibleRanges.forEach((range) => {
    if (range.start > cursor) parts.push({ text: window.text.slice(cursor, range.start), highlight: false });
    parts.push({ text: window.text.slice(range.start, range.end), highlight: true });
    cursor = range.end;
  });
  if (cursor < window.text.length) parts.push({ text: window.text.slice(cursor), highlight: false });

  return {
    text: `${window.prefix ? '…' : ''}${window.text}${window.suffix ? '…' : ''}`,
    parts: [
      ...(window.prefix ? [{ text: '…', highlight: false }] : []),
      ...parts,
      ...(window.suffix ? [{ text: '…', highlight: false }] : []),
    ],
  };
}

function scoreSearchDocument(document, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const searchableText = document.map((field) => field.normalizedText).join(' ');
  if (!tokens.every((token) => searchableText.includes(token))) return -1;

  let score = 0;
  document.forEach((field) => {
    if (field.normalizedText === normalizedQuery) score += field.weight * 4;
    else if (field.normalizedText.startsWith(normalizedQuery)) score += field.weight * 2.5;
    else if (field.normalizedText.includes(normalizedQuery)) score += field.weight * 1.5;

    tokens.forEach((token) => {
      if (field.normalizedText === token) score += field.weight * 1.5;
      else if (field.normalizedText.startsWith(token)) score += field.weight * 0.9;
      else if (field.normalizedText.split(' ').includes(token)) score += field.weight * 0.65;
      else if (field.normalizedText.includes(token)) score += field.weight * 0.35;
    });
  });

  const name = document.find(({ field }) => field === 'name')?.normalizedText || '';
  if (name === normalizedQuery) score += 1800;
  else if (name.startsWith(normalizedQuery)) score += 1100;
  else if (name.includes(normalizedQuery)) score += 720;
  return score;
}

export function scoreProfile(profile, query) {
  return scoreSearchDocument(buildPublicSearchDocument(profile), query);
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seed) {
  const result = [...items];
  const random = mulberry32(Number(seed) || 1);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function hashString(value, seed = 1) {
  let hash = (2166136261 ^ Number(seed)) >>> 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function takeDifferentMajor(bucket, previousMajor) {
  if (!bucket.length) return null;
  if (!previousMajor) return bucket.shift();

  const candidateIndex = bucket.findIndex(
    (profile, index) => index < 10 && optionKey(profile.major) !== previousMajor,
  );

  if (candidateIndex <= 0) return bucket.shift();
  const [profile] = bucket.splice(candidateIndex, 1);
  return profile;
}

export function balancedShuffle(profiles, seed) {
  if (profiles.length < 3) return seededShuffle(profiles, seed);

  const grouped = new Map();
  profiles.forEach((profile) => {
    const role = profile.role || 'Other';
    if (!grouped.has(role)) grouped.set(role, []);
    grouped.get(role).push(profile);
  });

  const roles = Array.from(grouped.keys()).sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left);
    const rightIndex = ROLE_ORDER.indexOf(right);
    const safeLeft = leftIndex === -1 ? ROLE_ORDER.length : leftIndex;
    const safeRight = rightIndex === -1 ? ROLE_ORDER.length : rightIndex;
    return safeLeft - safeRight || left.localeCompare(right);
  });

  const buckets = new Map(
    roles.map((role, index) => [role, seededShuffle(grouped.get(role), Number(seed) + index * 9973)]),
  );
  const totals = new Map(roles.map((role) => [role, buckets.get(role).length]));
  const placed = new Map(roles.map((role) => [role, 0]));

  const output = [];
  let previousRole = '';
  let roleRun = 0;
  let previousMajor = '';

  while (output.length < profiles.length) {
    const step = output.length + 1;
    let candidates = roles.filter((role) => buckets.get(role).length > 0);

    if (roleRun >= 2) {
      const alternatives = candidates.filter((role) => role !== previousRole);
      if (alternatives.length > 0) candidates = alternatives;
    }

    candidates.sort((left, right) => {
      const leftDeficit = (step * totals.get(left)) / profiles.length - placed.get(left);
      const rightDeficit = (step * totals.get(right)) / profiles.length - placed.get(right);
      const leftPenalty = left === previousRole ? 0.42 * roleRun : 0;
      const rightPenalty = right === previousRole ? 0.42 * roleRun : 0;
      const leftScore = leftDeficit - leftPenalty + (hashString(`${step}:${left}`, seed) / 0xffffffff) * 0.05;
      const rightScore = rightDeficit - rightPenalty + (hashString(`${step}:${right}`, seed) / 0xffffffff) * 0.05;
      return rightScore - leftScore || left.localeCompare(right);
    });

    const role = candidates[0];
    const profile = takeDifferentMajor(buckets.get(role), previousMajor);
    if (!profile) break;

    output.push(profile);
    placed.set(role, placed.get(role) + 1);
    previousMajor = optionKey(profile.major);

    if (role === previousRole) roleRun += 1;
    else {
      previousRole = role;
      roleRun = 1;
    }
  }

  return output;
}

function matchesFilters(profile, role, filters) {
  if (role !== 'All' && profile.role !== role) return false;

  if (filters.years.length > 0) {
    const year = optionKey(canonicalYear(profile.year));
    if (!filters.years.includes(year)) return false;
  }

  if (filters.majorGroups.length > 0 && !filters.majorGroups.includes(optionKey(normalizeMajorGroup(profile.major)))) {
    return false;
  }

  const isDefaultSocialRange = filters.socialLevelMin === 1 && filters.socialLevelMax === 5;
  const socialLevel = Number(profile.socialLevel);
  const hasSocialLevel = Number.isInteger(socialLevel) && socialLevel >= 1 && socialLevel <= 5;
  if (!isDefaultSocialRange && (
    !hasSocialLevel
    || socialLevel < filters.socialLevelMin
    || socialLevel > filters.socialLevelMax
  )) return false;

  if (
    filters.socialStyles.length > 0
    && !filters.socialStyles.includes(profile.socialStyle)
  ) return false;
  return true;
}

export function filterProfiles(profiles, { role = 'All', filters = DEFAULT_FILTERS } = {}) {
  const safeRole = ['All', 'Little', 'Big', 'Family'].includes(role) ? role : 'All';
  const safeFilters = sanitizeFilters(filters);
  return profiles.filter((profile) => matchesFilters(profile, safeRole, safeFilters));
}

function searchMatchContext(profile, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return null;
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const entries = new Map(buildPublicSearchDocument(profile).map((entry) => [entry.field, entry]));

  for (const field of DEEP_SEARCH_PRIORITY) {
    const entry = entries.get(field);
    if (!entry) continue;
    const isFieldMatch = entry.normalizedText.includes(normalizedQuery)
      || tokens.every((token) => entry.normalizedText.includes(token));
    if (!isFieldMatch) continue;
    const snippet = createMatchSnippet(entry.text, query);
    if (snippet) {
      return {
        type: 'search',
        field: entry.field,
        label: entry.label,
        snippet,
        matchedTerm: normalizePublicText(query),
      };
    }
  }

  return null;
}

function profileVibeEvidence(profile) {
  if (profile && typeof profile === 'object' && vibeEvidenceCache.has(profile)) {
    return vibeEvidenceCache.get(profile);
  }
  const results = scoreVibeEvidence({
    hobbies: profile.hobbies,
    hobbyDetails: profile.hobbyDetails,
    passion: profile.passion,
    perfectDay: profile.perfectDay,
    idealHangout: profile.idealHangout,
    story: profile.bio,
    music: profile.music,
    movies: profile.movies,
  });
  if (profile && typeof profile === 'object') vibeEvidenceCache.set(profile, results);
  return results;
}

function strongestSelectedVibe(profile, selectedVibes) {
  const assigned = new Set(Array.isArray(profile.vibes) ? profile.vibes : []);
  const eligible = new Set(selectedVibes.filter((vibe) => assigned.has(vibe)));
  if (!eligible.size) return null;

  const scored = profileVibeEvidence(profile).find(({ vibe }) => eligible.has(vibe));
  if (scored) return scored;
  const vibe = VIBE_OPTIONS.find((option) => eligible.has(option));
  return vibe ? { vibe, score: 0, evidence: [] } : null;
}

function strongestPublicEvidence(profile, vibeMatch) {
  if (!vibeMatch?.evidence?.length) return null;
  const priority = new Map(DEEP_SEARCH_PRIORITY.map((field, index) => [field, index]));
  const evidence = [...vibeMatch.evidence].sort((left, right) => {
    const leftField = VIBE_EVIDENCE_FIELD_MAP[left.field] || left.field;
    const rightField = VIBE_EVIDENCE_FIELD_MAP[right.field] || right.field;
    return right.points - left.points
      || (priority.get(leftField) ?? Number.MAX_SAFE_INTEGER) - (priority.get(rightField) ?? Number.MAX_SAFE_INTEGER);
  })[0];
  const field = VIBE_EVIDENCE_FIELD_MAP[evidence.field] || evidence.field;
  const entry = buildPublicSearchDocument(profile).find((candidate) => candidate.field === field);
  if (!entry) return null;
  const snippet = createMatchSnippet(entry.text, evidence.phrase);
  return snippet ? { field, label: entry.label, snippet, matchedTerm: evidence.phrase } : null;
}

function usefulFilterTerms(profile, filters, vibeMatch = null) {
  const terms = [];
  if (vibeMatch?.vibe) terms.push(vibeMatch.vibe);
  if (filters.socialStyles.includes(profile.socialStyle)) terms.push(profile.socialStyle);
  return terms;
}

export function buildProfileMatchContext(profile, values = {}) {
  const filters = sanitizeFilters(values);
  const vibeMatch = strongestSelectedVibe(profile, filters.vibes);
  const searchContext = searchMatchContext(profile, values.query);
  const filterTerms = usefulFilterTerms(profile, filters, vibeMatch);

  if (searchContext) {
    return filterTerms.length ? { ...searchContext, alsoMatches: filterTerms } : searchContext;
  }

  if (vibeMatch) {
    const evidence = strongestPublicEvidence(profile, vibeMatch);
    return {
      type: 'vibe',
      field: evidence?.field || 'vibes',
      label: evidence?.label || SEARCH_FIELD_BY_KEY.get('vibes').label,
      values: filterTerms,
      snippet: evidence?.snippet || null,
      matchedTerm: evidence?.matchedTerm || vibeMatch.vibe,
    };
  }

  if (filterTerms.length) {
    return {
      type: 'filter',
      field: 'socialStyle',
      label: SEARCH_FIELD_BY_KEY.get('socialStyle').label,
      values: filterTerms,
      snippet: null,
      matchedTerm: filterTerms[0],
    };
  }

  return null;
}

export function filterAndOrderProfiles(profiles, values = {}) {
  const role = ['All', 'Little', 'Big', 'Family'].includes(values.role) ? values.role : 'All';
  const query = typeof values.query === 'string' ? values.query : '';
  const seed = Number.isFinite(Number(values.seed)) ? Number(values.seed) : 1;
  const filters = sanitizeFilters(values);
  const unseen = values.unseen === true;
  const seenIds = new Set(Array.isArray(values.seenIds) ? values.seenIds : []);
  const orderingSeenIds = new Set(Array.isArray(values.orderingSeenIds) ? values.orderingSeenIds : seenIds);
  const saved = values.saved === true;
  const savedIds = new Set(Array.isArray(values.savedIds) ? values.savedIds : []);
  const encounteredIds = new Set(Array.isArray(values.encounteredIds) ? values.encounteredIds : []);
  const filtered = profiles.filter((profile) => {
    if (role !== 'All' && profile.role !== role) return false;
    if (unseen && seenIds.has(profile.id)) return false;
    if (saved && !savedIds.has(profile.id)) return false;
    if (
      filters.vibes.length > 0
      && !filters.vibes.some((vibe) => profile.vibes?.includes(vibe))
    ) return false;
    return matchesFilters(profile, 'All', filters);
  });
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    const tiers = [[], [], []];
    filtered.forEach((profile) => {
      const tier = encounteredIds.has(profile.id)
        ? (orderingSeenIds.has(profile.id) ? 2 : 1)
        : 0;
      tiers[tier].push(profile);
    });
    return tiers.flatMap((tier) => balancedShuffle(tier, seed));
  }

  return filtered
    .map((profile) => ({ profile, score: scoreProfile(profile, normalizedQuery) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTier = encounteredIds.has(left.profile.id)
        ? (orderingSeenIds.has(left.profile.id) ? 2 : 1)
        : 0;
      const rightTier = encounteredIds.has(right.profile.id)
        ? (orderingSeenIds.has(right.profile.id) ? 2 : 1)
        : 0;
      if (leftTier !== rightTier) return leftTier - rightTier;
      const leftKey = hashString(left.profile.id, seed + hashString(normalizedQuery));
      const rightKey = hashString(right.profile.id, seed + hashString(normalizedQuery));
      return leftKey - rightKey || left.profile.id.localeCompare(right.profile.id);
    })
    .map(({ profile }) => profile);
}

export function buildDiscoveryResults(profiles, values = {}) {
  return filterAndOrderProfiles(profiles, values).map((profile) => ({
    profile,
    matchContext: buildProfileMatchContext(profile, values),
  }));
}

export function createSeed(previousSeed) {
  let seed;
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    seed = values[0];
  } else {
    seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }

  if (seed === previousSeed) seed = (seed + 1) >>> 0;
  if (!seed) seed = 1;
  if (seed === previousSeed) seed = previousSeed === 1 ? 2 : 1;
  return seed;
}
