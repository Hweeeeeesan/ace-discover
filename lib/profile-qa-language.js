const MASK_CHARACTER = '[*_–—.\\-]';
const ALLOWED_SEPARATOR = '[\\s*_–—.\\-]{0,3}';
const WORD_EDGE_START = '(?<![\\p{L}\\p{N}])';
const WORD_EDGE_END = '(?![\\p{L}\\p{N}])';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termMatcher(term, suffix = '') {
  const letters = Array.from(term);
  const tolerantBody = letters.map((letter, index) => {
    const escaped = escapeRegex(letter);
    if (index === 0 || index === letters.length - 1) return escaped;
    return `(?:${escaped}|${MASK_CHARACTER})`;
  }).join(ALLOWED_SEPARATOR);
  return Object.freeze({
    plain: new RegExp(`${WORD_EDGE_START}${escapeRegex(term)}${suffix}${WORD_EDGE_END}`, 'iu'),
    tolerant: new RegExp(`${WORD_EDGE_START}${tolerantBody}${suffix}${WORD_EDGE_END}`, 'iu'),
  });
}

function termFamily(terms) {
  return terms.map((entry) => (
    typeof entry === 'string' ? termMatcher(entry) : termMatcher(entry.term, entry.suffix)
  ));
}

// Curated for an official public student-organization profile. Borderline words
// such as “badass”, “damn”, and “hell” are intentionally excluded.
const PUBLIC_APPROPRIATENESS_RULES = Object.freeze([
  Object.freeze({
    rule: 'hateful_or_slur_language',
    group: 'hateful_language',
    terms: termFamily([
      { term: 'nigger', suffix: 's?' },
      { term: 'nigga', suffix: 's?' },
      { term: 'faggot', suffix: 's?' },
      { term: 'chink', suffix: 's?' },
      { term: 'gook', suffix: 's?' },
      { term: 'retard', suffix: 's?' },
    ]),
    reason: 'This response appears to contain hateful or slur language and warrants human review before public display.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'threatening_language',
    group: 'threats_severe_hostility',
    patterns: [
      /\b(?:i|we)\s+(?:will|'ll|want to|wanna|am going to|are going to)\s+(?:kill|hurt|attack|beat up)\b/iu,
      /\b(?:you|they|he|she)\s+(?:should|deserve(?:s)? to)\s+(?:die|be hurt|be attacked|get beaten up)\b/iu,
    ],
    reason: 'This response appears to contain threatening or severe hostile language and warrants human review before public display.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'explicit_sexual_language',
    group: 'explicit_sexual_language',
    terms: termFamily(['blowjob', 'handjob', 'gangbang']),
    patterns: [
      /\b(?:pornographic|hardcore porn|sexual intercourse|oral sex|anal sex)\b/iu,
    ],
    reason: 'This response appears to contain explicit sexual terminology that may not fit an official public profile.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'graphic_vulgarity',
    group: 'graphic_vulgarity',
    patterns: [
      /\b(?:eat|eating)\s+(?:my\s+)?shit\b/iu,
      /\b(?:suck|sucking)\s+(?:my|a)\s+(?:dick|cock)\b/iu,
      /\bpiece\s+of\s+shit\b/iu,
    ],
    reason: 'This response contains graphic vulgarity that may not fit an official public profile.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'degrading_severe_insult',
    group: 'threats_severe_hostility',
    patterns: [
      /\b(?:you|they|he|she|everyone|people in [a-z ]{2,30})\b.{0,35}\b(?:idiots?|stupid|dumb|trash|disgusting|worthless)\b/iu,
    ],
    reason: 'This response appears to direct a degrading severe insult at a person or group.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'vulgar_language',
    group: 'vulgarity',
    terms: termFamily([
      { term: 'bitch', suffix: '(?:es|y|ing)?' },
      { term: 'asshole', suffix: 's?' },
      { term: 'cunt', suffix: 's?' },
      { term: 'douchebag', suffix: 's?' },
      { term: 'dickhead', suffix: 's?' },
      { term: 'jackass', suffix: '(?:es)?' },
    ]),
    reason: 'This response contains vulgar language that may not fit an official public profile.',
    obfuscatedReason: 'This response contains censored or obfuscated vulgar language that may not fit an official public profile.',
    confidence: 'high',
  }),
  Object.freeze({
    rule: 'profanity',
    group: 'profanity',
    terms: termFamily([
      { term: 'fuck', suffix: '(?:s|ed|er|ers|ing)?' },
      { term: 'motherfucker', suffix: 's?' },
      { term: 'shit', suffix: '(?:s|ty|ting)?' },
      { term: 'bullshit', suffix: '(?:s|ting)?' },
    ]),
    reason: 'This response contains profanity that may not fit an official public profile.',
    obfuscatedReason: 'This response contains censored or obfuscated profanity that may not fit an official public profile.',
    confidence: 'high',
  }),
]);

function matchRule(rule, text) {
  if (rule.patterns?.some((pattern) => pattern.test(text))) return { obfuscated: false };
  for (const matcher of rule.terms || []) {
    if (matcher.plain.test(text)) return { obfuscated: false };
    if (matcher.tolerant.test(text)) return { obfuscated: true };
  }
  return null;
}

export function detectPublicAppropriateness(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  for (const rule of PUBLIC_APPROPRIATENESS_RULES) {
    const match = matchRule(rule, text);
    if (!match) continue;
    return {
      rule: rule.rule,
      group: rule.group,
      confidence: rule.confidence,
      reason: match.obfuscated && rule.obfuscatedReason ? rule.obfuscatedReason : rule.reason,
      obfuscated: match.obfuscated,
    };
  }
  return null;
}
