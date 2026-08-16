import { datasetDiscoveryKey } from './datasets/model.js';

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
    addOption(yearMap, profile.normalizedYear || profile.year, canonicalYear);
    const majorGroup = MAJOR_GROUP_OPTIONS.includes(profile.majorGroup)
      ? profile.majorGroup
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
    activeProfileId: typeof source.activeProfileId === 'string' ? source.activeProfileId : '',
    scrollTop: Number.isFinite(numericScrollTop) && numericScrollTop >= 0 ? numericScrollTop : 0,
  };
}

function profileField(profile, key) {
  if (key === 'interests') return Array.isArray(profile.interests) ? profile.interests.join(' ') : '';
  if (key === 'vibes') return Array.isArray(profile.vibes) ? profile.vibes.join(' ') : '';
  if (key === 'year') return `${profile.year || ''} ${profile.normalizedYear || canonicalYear(profile.year)}`;
  return profile[key] || '';
}

const SEARCH_FIELDS = [
  ['name', 420],
  ['major', 260],
  ['majorGroup', 245],
  ['interests', 230],
  ['vibes', 210],
  ['role', 185],
  ['year', 175],
  ['school', 135],
  ['program', 115],
  ['bio', 85],
  ['hobbies', 78],
  ['music', 72],
  ['movies', 68],
  ['perfectDay', 62],
  ['family', 55],
];

export function scoreProfile(profile, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return 0;

  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const fields = SEARCH_FIELDS.map(([key, weight]) => ({
    key,
    weight,
    value: normalizeText(profileField(profile, key)),
  }));
  const searchableText = fields.map((field) => field.value).join(' ');

  if (!tokens.every((token) => searchableText.includes(token))) return -1;

  let score = 0;
  fields.forEach((field) => {
    if (!field.value) return;

    if (field.value === normalizedQuery) score += field.weight * 4;
    else if (field.value.startsWith(normalizedQuery)) score += field.weight * 2.5;
    else if (field.value.includes(normalizedQuery)) score += field.weight * 1.5;

    tokens.forEach((token) => {
      if (field.value === token) score += field.weight * 1.5;
      else if (field.value.startsWith(token)) score += field.weight * 0.9;
      else if (field.value.split(' ').includes(token)) score += field.weight * 0.65;
      else if (field.value.includes(token)) score += field.weight * 0.35;
    });
  });

  const name = normalizeText(profile.name);
  if (name === normalizedQuery) score += 1800;
  else if (name.startsWith(normalizedQuery)) score += 1100;
  else if (name.includes(normalizedQuery)) score += 720;

  return score;
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
    const year = optionKey(profile.normalizedYear || canonicalYear(profile.year));
    if (!filters.years.includes(year)) return false;
  }

  if (filters.majorGroups.length > 0 && !filters.majorGroups.includes(optionKey(profile.majorGroup))) {
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

export function filterAndOrderProfiles(profiles, values = {}) {
  const role = ['All', 'Little', 'Big', 'Family'].includes(values.role) ? values.role : 'All';
  const query = typeof values.query === 'string' ? values.query : '';
  const seed = Number.isFinite(Number(values.seed)) ? Number(values.seed) : 1;
  const filters = sanitizeFilters(values);
  const unseen = values.unseen === true;
  const seenIds = new Set(Array.isArray(values.seenIds) ? values.seenIds : []);
  const saved = values.saved === true;
  const savedIds = new Set(Array.isArray(values.savedIds) ? values.savedIds : []);
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

  if (!normalizedQuery) return balancedShuffle(filtered, seed);

  return filtered
    .map((profile) => ({ profile, score: scoreProfile(profile, normalizedQuery) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftKey = hashString(left.profile.id, seed + hashString(normalizedQuery));
      const rightKey = hashString(right.profile.id, seed + hashString(normalizedQuery));
      return leftKey - rightKey || left.profile.id.localeCompare(right.profile.id);
    })
    .map(({ profile }) => profile);
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
  return seed || 1;
}
