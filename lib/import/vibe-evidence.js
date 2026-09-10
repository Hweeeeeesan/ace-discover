import VIBE_SCORING from './vibe-scoring.json' with { type: 'json' };

export const VIBE_ORDER = VIBE_SCORING.vibes.map(({ name }) => name);
export const VIBE_SCORE_THRESHOLD = VIBE_SCORING.threshold;
export const MAX_INFERRED_VIBES = VIBE_SCORING.maxVibes;
export const VIBE_FIELD_WEIGHTS = Object.freeze({ ...VIBE_SCORING.fieldWeights });

const VIBE_ORDER_INDEX = new Map(VIBE_ORDER.map((vibe, index) => [vibe, index]));
const NEGATION_PATTERN = /(?:do not|don't|dont|never|hate(?:s|d)?|dislik(?:e|es|ed)|not into|not a fan of|no interest in|can't stand|cant stand|cannot stand|avoid(?:s|ed|ing)?)(?:\s+[a-z0-9']+){0,6}$/;

function cleanEvidenceText(value) {
  return String(value || '').replace(/\0/g, ' ').trim().replace(/\s+/g, ' ');
}

function isNegatedEvidence(text, start) {
  const prefix = text.slice(Math.max(0, start - 140), start);
  const sentencePrefix = prefix.slice(Math.max(
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('\n'),
  ) + 1);
  const normalized = sentencePrefix
    .replace(/’/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
  return NEGATION_PATTERN.test(normalized);
}

function overlapsAcceptedEvidence(start, end, accepted) {
  return accepted.some((span) => start < span.end && end > span.start);
}

export function scoreVibeEvidence(fields = {}) {
  const results = [];
  for (const vibeConfig of VIBE_SCORING.vibes) {
    let score = 0;
    const evidence = [];
    for (const [field, fieldWeight] of Object.entries(VIBE_SCORING.fieldWeights)) {
      const text = cleanEvidenceText(fields?.[field]).toLowerCase();
      if (!text) continue;
      const accepted = [];
      const seenPhrases = new Set();
      for (const level of ['strong', 'weak']) {
        const strength = VIBE_SCORING.strengths[level];
        for (const [rule, pattern] of vibeConfig[level]) {
          const matcher = new RegExp(pattern, 'gi');
          for (const match of text.matchAll(matcher)) {
            const phrase = match[0].toLowerCase();
            const start = match.index;
            const end = start + match[0].length;
            if (seenPhrases.has(phrase)
              || overlapsAcceptedEvidence(start, end, accepted)
              || isNegatedEvidence(text, start)) continue;
            const points = Number(fieldWeight) * Number(strength);
            accepted.push({ start, end });
            seenPhrases.add(phrase);
            score += points;
            evidence.push({ field, rule, strength: level, phrase, points });
          }
        }
      }
    }
    if (score > 0) results.push({ vibe: vibeConfig.name, score, evidence });
  }
  return results.sort((left, right) => (
    right.score - left.score
    || VIBE_ORDER_INDEX.get(left.vibe) - VIBE_ORDER_INDEX.get(right.vibe)
  ));
}
