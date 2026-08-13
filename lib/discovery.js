export const DISCOVERY_STORAGE_KEY = 'profile-gallery:discovery-v2';
export const DISCOVERY_NAV_KEY = 'profile-gallery:discovery-navigation';

export const DEFAULT_FILTERS = Object.freeze({
  years: [],
  major: '',
  program: '',
  school: '',
  hasDeck: false,
});

const ROLE_ORDER = ['Little', 'Big', 'Family'];
const YEAR_ORDER = ['First', 'Second', 'Third', 'Fourth', 'Fifth+', 'Graduate', 'Not listed'];
const INVALID_OPTION_VALUES = new Set([
  '',
  'n a',
  'na',
  'none',
  'no',
  'not applicable',
  'not listed',
  'year not listed',
  'all of the above',
]);

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
  if (!normalized || normalized.includes('not listed')) return 'Not listed';
  if (/^(first|1st|freshman|year 1|1 year)$/.test(normalized)) return 'First';
  if (/^(second|2nd|2nd year|sophomore|year 2|2 year)$/.test(normalized)) return 'Second';
  if (/^(third|3rd|3rd year|junior|year 3|3 year)$/.test(normalized)) return 'Third';
  if (/^(fourth|4th|4th year|senior|year 4|4 year)$/.test(normalized)) return 'Fourth';
  if (normalized.includes('fifth') || normalized.includes('5th')) return 'Fifth+';
  if (
    normalized.includes('grad') ||
    normalized.includes('master') ||
    normalized.includes('doctoral') ||
    normalized.includes('phd')
  ) {
    return 'Graduate';
  }
  return cleanLabel(value) || 'Not listed';
}

export function canonicalSchool(value = '') {
  const normalized = normalizeText(value);
  if (!normalized || INVALID_OPTION_VALUES.has(normalized)) return '';
  if (normalized.includes('sjsu') || normalized.includes('san jose state')) return 'SJSU';
  if (normalized.includes('de anza')) return 'De Anza College';
  if (normalized === 'sjcc' || normalized.includes('san jose city')) return 'San Jose City College';
  if (normalized === 'wvc' || normalized.includes('west valley')) return 'West Valley College';
  return cleanLabel(value);
}

export function optionKey(value = '') {
  return normalizeText(value);
}

function addOption(map, rawValue, canonicalizer = cleanLabel, allowNotListed = false) {
  const label = canonicalizer(rawValue);
  const value = optionKey(label);
  if (!value) return;
  if (!allowNotListed && (INVALID_OPTION_VALUES.has(value) || value === 'not listed')) return;

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
  const majorMap = new Map();
  const programMap = new Map();
  const schoolMap = new Map();
  const roleCounts = { Little: 0, Big: 0, Family: 0 };

  profiles.forEach((profile) => {
    addOption(yearMap, profile.year, canonicalYear, true);
    addOption(majorMap, profile.major);
    addOption(programMap, profile.program);
    addOption(schoolMap, profile.school, canonicalSchool);
    if (profile.role in roleCounts) roleCounts[profile.role] += 1;
  });

  return {
    years: sortedOptions(yearMap, YEAR_ORDER),
    majors: sortedOptions(majorMap),
    programs: sortedOptions(programMap),
    schools: sortedOptions(schoolMap),
    roleCounts,
  };
}

export function sanitizeFilters(filters = {}) {
  return {
    years: Array.isArray(filters.years)
      ? filters.years.filter((value) => typeof value === 'string').slice(0, 12)
      : [],
    major: typeof filters.major === 'string' ? filters.major : '',
    program: typeof filters.program === 'string' ? filters.program : '',
    school: typeof filters.school === 'string' ? filters.school : '',
    hasDeck: Boolean(filters.hasDeck),
  };
}

export function countAdvancedFilters(filters = DEFAULT_FILTERS) {
  const safe = sanitizeFilters(filters);
  return safe.years.length
    + Number(Boolean(safe.major))
    + Number(Boolean(safe.program))
    + Number(Boolean(safe.school));
}

function profileField(profile, key) {
  if (key === 'interests') return Array.isArray(profile.interests) ? profile.interests.join(' ') : '';
  if (key === 'year') return `${profile.year || ''} ${canonicalYear(profile.year)} year`;
  return profile[key] || '';
}

const SEARCH_FIELDS = [
  ['name', 420],
  ['major', 260],
  ['interests', 230],
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
  if (filters.hasDeck && !profile.slideDeckUrl) return false;

  if (filters.years.length > 0) {
    const year = optionKey(canonicalYear(profile.year));
    if (!filters.years.includes(year)) return false;
  }

  if (filters.major && optionKey(profile.major) !== filters.major) return false;
  if (filters.program && optionKey(profile.program) !== filters.program) return false;
  if (filters.school && optionKey(canonicalSchool(profile.school)) !== filters.school) return false;
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
  const filtered = profiles.filter((profile) => matchesFilters(profile, role, filters));
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
