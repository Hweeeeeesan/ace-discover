import { cleanText, normalizeInstagram, redactPii, VIBE_ORDER } from './import/profile-normalization.js';
import { normalizePublicHttpUrl } from './public-url.js';

export const PUBLIC_PROFILE_EDITABLE_FIELDS = Object.freeze([
  'name', 'pronouns', 'year', 'major', 'instagram', 'hobbies', 'hobbyDetails',
  'music', 'movies', 'uniqueThings', 'tagline', 'passion', 'perfectDay',
  'idealHangout', 'bucketList', 'hotTake', 'bio', 'aceTraitSlideUrl', 'vibes',
]);

const EDITABLE_FIELD_SET = new Set(PUBLIC_PROFILE_EDITABLE_FIELDS);
const TEXT_LIMITS = Object.freeze({
  name: 120,
  pronouns: 80,
  year: 80,
  major: 240,
  hobbies: 4000,
  hobbyDetails: 6000,
  music: 3000,
  movies: 3000,
  uniqueThings: 3000,
  tagline: 500,
  passion: 3000,
  perfectDay: 3000,
  idealHangout: 3000,
  bucketList: 3000,
  hotTake: 1500,
  bio: 5000,
  aceTraitSlideUrl: 2048,
});

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_VIBES = new Set(VIBE_ORDER);

export function resolveEffectivePublicProfile(importedPublicData = {}, publicOverrides = {}) {
  const imported = importedPublicData && typeof importedPublicData === 'object' && !Array.isArray(importedPublicData)
    ? importedPublicData
    : {};
  const overrides = publicOverrides && typeof publicOverrides === 'object' && !Array.isArray(publicOverrides)
    ? publicOverrides
    : {};
  const effective = { ...imported };
  for (const field of PUBLIC_PROFILE_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) effective[field] = overrides[field];
  }
  return effective;
}

export function publicOverrideFields(publicOverrides = {}) {
  return PUBLIC_PROFILE_EDITABLE_FIELDS.filter((field) => (
    publicOverrides && Object.prototype.hasOwnProperty.call(publicOverrides, field)
  ));
}

function normalizedText(field, value) {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const normalized = value.replace(/\r\n/g, '\n').replace(/\0/g, ' ')
    .split('\n').map((line) => redactPii(line)).join('\n').trim();
  if (normalized.length > TEXT_LIMITS[field]) throw new Error(`${field} exceeds its length limit.`);
  return normalized;
}

function normalizedPublicUrl(field, value) {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const candidate = value.trim();
  if (!candidate) return '';
  if (candidate.length > TEXT_LIMITS[field]) throw new Error(`${field} exceeds its length limit.`);
  const normalized = normalizePublicHttpUrl(candidate);
  if (!normalized) throw new Error(`${field} must be a safe HTTP or HTTPS URL.`);
  return normalized;
}

export function validatePublicOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Public overrides must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key) || !EDITABLE_FIELD_SET.has(key)) {
      throw new Error(`The field ${key} cannot be overridden.`);
    }
  }
  const normalized = {};
  for (const [field, rawValue] of Object.entries(value)) {
    if (field === 'vibes') {
      if (!Array.isArray(rawValue) || rawValue.length > 5) throw new Error('Vibes must be an array of at most 5 items.');
      const vibes = rawValue.map((vibe) => {
        if (typeof vibe !== 'string' || !cleanText(vibe)) throw new Error('Vibes must contain text values.');
        const normalizedVibe = cleanText(vibe);
        if (!VALID_VIBES.has(normalizedVibe)) throw new Error(`Invalid vibe: ${normalizedVibe}.`);
        return normalizedVibe;
      });
      if (new Set(vibes).size !== vibes.length) throw new Error('Vibes cannot contain duplicates.');
      normalized.vibes = vibes;
      continue;
    }
    normalized[field] = field === 'instagram'
      ? normalizeInstagram(normalizedText(field, rawValue))
      : field === 'aceTraitSlideUrl'
        ? normalizedPublicUrl(field, rawValue)
        : normalizedText(field, rawValue);
  }
  return normalized;
}

export function buildPublicOverridePatch(importedPublicData = {}, currentOverrides = {}, requestedValues = {}) {
  const imported = importedPublicData || {};
  const current = currentOverrides || {};
  const normalized = validatePublicOverrides(requestedValues);
  const next = {};
  for (const [field, value] of Object.entries(normalized)) {
    if (JSON.stringify(value) !== JSON.stringify(imported[field])) next[field] = value;
  }
  for (const field of publicOverrideFields(current)) {
    if (!(field in normalized)) next[field] = current[field];
  }
  return next;
}

export function buildSinglePublicOverridePatch(
  importedPublicData = {},
  currentOverrides = {},
  field,
  value,
) {
  const normalizedField = String(field || '');
  const normalized = validatePublicOverrides({ [normalizedField]: value });
  const next = validatePublicOverrides(currentOverrides || {});
  if (JSON.stringify(normalized[normalizedField]) === JSON.stringify(importedPublicData?.[normalizedField])) {
    delete next[normalizedField];
  } else {
    next[normalizedField] = normalized[normalizedField];
  }
  return next;
}
