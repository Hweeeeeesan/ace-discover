import INTEREST_TAXONOMY from './interest-taxonomy.json' with { type: 'json' };

const RULES = INTEREST_TAXONOMY.rules.map((rule, taxonomyIndex) => ({
  ...rule,
  taxonomyIndex,
  headingKeys: new Set([rule.label, ...(rule.aliases || [])].map(normalizeInterestKey)),
  matchers: rule.patterns.map((pattern) => new RegExp(pattern, 'giu')),
}));
const PLACEHOLDERS = new Set(INTEREST_TAXONOMY.placeholders.map(normalizeInterestKey));
const BLOCKED_CUSTOM = new Set(INTEREST_TAXONOMY.blockedCustom.map(normalizeInterestKey));
const CUSTOM_PROSE_PATTERN = /\b(?:i|im|ive|my|we|our|you|love|like|enjoy|play|playing|go|going|make|making|watch|watching|listen|listening|have|has|been|because|when|while|with|for|to|since|about|ago)\b/i;
const SEGMENT_DELIMITER = /\n+|[•;]+|,\s+|\s+(?=\d+[.)]\s+)/g;
const STRUCTURED_SEGMENT_DELIMITER = /\n+|[•;]+|\s+(?=\d+[.)]\s+)|\s+(?=\*\s+\S)/g;
const NEGATION_PATTERN = /\b(?:do not|don't|dont|never|hate(?:s|d)?|dislik(?:e|es|ed)|not into|not a fan of|no interest in|can't stand|cant stand|cannot stand|avoid(?:s|ed|ing)?)(?:\s+[a-z0-9']+){0,6}$/;
const INDEPENDENT_EVIDENCE_PATTERN = /\b(?:and|or|also|plus|along with|as well as)\b/i;

export function normalizeInterestKey(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeHobbyText(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, ' ')
    .trim();
}

function delimiterKind(delimiter, followingText) {
  if (delimiter.includes('\n')) return 'newline';
  if (delimiter.includes('•')) return 'bullet';
  if (delimiter.includes(';')) return 'semicolon';
  if (delimiter.includes(',')) return 'comma';
  if (/^\d+[.)]\s+/.test(followingText)) return 'numbered';
  if (/^\*\s+\S/.test(followingText)) return 'bullet';
  return 'separator';
}

function segmentHobbies(text) {
  const segments = [];
  let start = 0;
  let beforeKind = 'start';
  let match;
  const numberedMarkers = text.match(/(?:^|\s)\d+[.)]\s+/g)?.length || 0;
  const starMarkers = text.match(/(?:^|\s)\*\s+\S/g)?.length || 0;
  const delimiter = numberedMarkers >= 2 || starMarkers >= 2
    ? STRUCTURED_SEGMENT_DELIMITER
    : SEGMENT_DELIMITER;
  delimiter.lastIndex = 0;
  while ((match = delimiter.exec(text)) !== null) {
    const afterKind = delimiterKind(match[0], text.slice(match.index + match[0].length));
    segments.push({ start, end: match.index, beforeKind, afterKind });
    start = match.index + match[0].length;
    beforeKind = afterKind;
  }
  segments.push({ start, end: text.length, beforeKind, afterKind: 'end' });

  return segments.map((range, segmentIndex) => {
    const raw = text.slice(range.start, range.end);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    const aside = trimmed.match(/^\((?:in\s+)?no particular order\)\s*/i);
    const asideLength = aside?.[0].length || 0;
    const prefix = trimmed.slice(asideLength).match(/^(?:[-–—*]\s+|\d+[.)]\s+)/);
    const prefixLength = asideLength + (prefix?.[0].length || 0);
    const content = trimmed.slice(prefixLength).trimStart();
    const contentOffset = range.start + leadingWhitespace + prefixLength
      + (trimmed.slice(prefixLength).length - trimmed.slice(prefixLength).trimStart().length);
    return {
      segmentIndex,
      start: contentOffset,
      end: contentOffset + content.length,
      text: content,
      beforeKind: range.beforeKind,
      afterKind: range.afterKind,
      prefixKind: prefix ? (/^\d/.test(prefix[0]) ? 'numbered' : 'bullet') : null,
    };
  }).filter(({ text: segmentText }) => Boolean(segmentText));
}

function segmentForPosition(segments, position) {
  return segments.find(({ start, end }) => position >= start && position <= end)?.segmentIndex ?? -1;
}

function headingForSegment(segment, totalSegments, listLike) {
  const strongStructure = Boolean(segment.prefixKind)
    || ['newline', 'bullet', 'numbered'].includes(segment.beforeKind)
    || ['newline', 'bullet', 'numbered'].includes(segment.afterKind);
  const listSeparated = listLike && (
    ['comma', 'semicolon'].includes(segment.beforeKind)
    || ['comma', 'semicolon'].includes(segment.afterKind)
  );
  const container = segment.text.match(/^(?:hobbies?|interests?|currently|wanna (?:get back into|do|learn))\s*:\s*(.*)$/i);
  if (container) {
    if (!container[1].trim()) return null;
    const remainder = container[1].trimStart();
    return headingForSegment({
      ...segment,
      text: remainder,
      start: segment.start + container[0].indexOf(container[1])
        + (container[1].length - remainder.length),
    }, totalSegments, listLike);
  }
  const labeled = segment.text.match(/^([^.!?\n]{2,80}?)[!?]?(?:\s*:\s*|\s+[–—-]\s+)(?=\S)/);
  if (labeled) {
    const text = labeled[1].trim();
    return {
      text,
      start: segment.start,
      end: segment.start + text.length,
      segmentIndex: segment.segmentIndex,
      explicit: true,
      customEligible: true,
    };
  }
  if (
    segment.text.length <= 30
    && !/[.!?]/.test(segment.text)
    && (strongStructure || listSeparated || totalSegments === 1)
  ) {
    return {
      text: segment.text,
      start: segment.start,
      end: segment.end,
      segmentIndex: segment.segmentIndex,
      explicit: strongStructure || listSeparated,
      customEligible: strongStructure || listSeparated || totalSegments === 1,
    };
  }
  return null;
}

function titleCustomInterest(value) {
  return value.split(/(\s+|-)/).map((part) => (
    /^[\p{L}\p{N}]/u.test(part)
      ? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`
      : part
  )).join('');
}

function isSafeCustomInterest(value) {
  const text = value.trim();
  const key = normalizeInterestKey(text);
  const words = key.split(' ').filter(Boolean);
  return text.length >= 2
    && text.length <= 30
    && words.length <= 5
    && !(words.length === 1 && /^[a-z]{2}$/.test(key))
    && !PLACEHOLDERS.has(key)
    && !BLOCKED_CUSTOM.has(key)
    && /^\p{L}/u.test(text)
    && !/^(?:and|or|but)\b/i.test(text)
    && !words.includes('program')
    && !CUSTOM_PROSE_PATTERN.test(key)
    && /^[\p{L}\p{N}\s&/'’+-]+$/u.test(text)
    && !/https?:\/\//i.test(text)
    && !/\[(?:email|phone|private|embedded).*removed\]/i.test(text)
    && !/\d{7,}/.test(text);
}

function isNegatedInterest(text, start) {
  const prefix = text.slice(Math.max(0, start - 140), start);
  const sentenceStart = Math.max(
    prefix.lastIndexOf('.'),
    prefix.lastIndexOf('!'),
    prefix.lastIndexOf('?'),
    prefix.lastIndexOf(';'),
    prefix.lastIndexOf('\n'),
  ) + 1;
  const normalized = prefix.slice(sentenceStart)
    .replace(/’/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
  return NEGATION_PATTERN.test(normalized);
}

function candidateRank(candidate) {
  return [candidate.priority, candidate.position, candidate.taxonomyIndex];
}

function compareCandidates(left, right) {
  const leftRank = candidateRank(left);
  const rightRank = candidateRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
  }
  return left.label.localeCompare(right.label);
}

function isKnownHeading(heading) {
  const key = normalizeInterestKey(heading.text);
  return RULES.some(({ headingKeys }) => headingKeys.has(key));
}

export function extractInterests(publicHobbies = '') {
  const text = normalizeHobbyText(publicHobbies);
  if (!normalizeInterestKey(text) || PLACEHOLDERS.has(normalizeInterestKey(text))) return [];

  const segments = segmentHobbies(text);
  const listLike = text.length <= 180
    && !/[.!?]/.test(text)
    && !CUSTOM_PROSE_PATTERN.test(normalizeInterestKey(text));
  const headings = segments.map((segment) => (
    headingForSegment(segment, segments.length, listLike)
  )).filter(Boolean);
  const protectedExplicitHeadings = headings.filter((heading) => (
    heading.explicit
    && heading.customEligible
    && !isKnownHeading(heading)
    && isSafeCustomInterest(heading.text)
  ));
  const matchesByLabel = new Map();

  RULES.forEach((rule) => {
    const matches = [];
    headings.forEach((heading) => {
      if (rule.headingKeys.has(normalizeInterestKey(heading.text))) {
        matches.push({
          position: heading.start,
          end: heading.end,
          segmentIndex: heading.segmentIndex,
          priority: 0,
          inHeading: true,
        });
      }
    });
    rule.matchers.forEach((matcher) => {
      matcher.lastIndex = 0;
      for (const match of text.matchAll(matcher)) {
        const position = match.index;
        if (isNegatedInterest(text, position)) continue;
        const segmentIndex = segmentForPosition(segments, position);
        const inHeading = headings.some((heading) => (
          position >= heading.start && position < heading.end
        ));
        matches.push({
          position,
          end: position + match[0].length,
          segmentIndex,
          priority: inHeading ? 0 : (rule.generic ? 2 : 1),
          inHeading,
        });
      }
    });
    if (matches.length) matchesByLabel.set(rule.label, { rule, matches });
  });

  INTEREST_TAXONOMY.genericSuppression.forEach(({ generic, specifics }) => {
    const genericMatch = matchesByLabel.get(generic);
    if (!genericMatch) return;
    const specificMatches = specifics.flatMap((label) => (
      matchesByLabel.get(label)?.matches || []
    ));
    genericMatch.matches = genericMatch.matches.filter((genericEvidence) => (
      !specificMatches.some((specificEvidence) => {
        if (genericEvidence.segmentIndex !== specificEvidence.segmentIndex) return false;
        const [left, right] = genericEvidence.position <= specificEvidence.position
          ? [genericEvidence, specificEvidence]
          : [specificEvidence, genericEvidence];
        const bridge = text.slice(left.end, right.position);
        return bridge.length <= 80 && !INDEPENDENT_EVIDENCE_PATTERN.test(bridge);
      })
    ));
    if (!genericMatch.matches.length) matchesByLabel.delete(generic);
  });

  const known = Array.from(matchesByLabel.values()).map(({ rule, matches }) => {
    const availableMatches = matches.filter(({ position }) => (
      !protectedExplicitHeadings.some((heading) => (
        position >= heading.start && position < heading.end
      ))
    ));
    if (!availableMatches.length) return null;
    const best = [...availableMatches].sort((left, right) => (
      left.priority - right.priority || left.position - right.position
    ))[0];
    return {
      label: rule.label,
      priority: best.priority,
      position: best.position,
      taxonomyIndex: rule.taxonomyIndex,
    };
  }).filter(Boolean);
  const knownKeys = new Set(known.map(({ label }) => normalizeInterestKey(label)));
  const custom = [];
  headings.forEach((heading, index) => {
    const key = normalizeInterestKey(heading.text);
    const knownHeading = isKnownHeading(heading);
    const containsKnownMatch = Array.from(matchesByLabel.values()).some(({ matches }) => (
      matches.some(({ position }) => (
        position >= heading.start
        && position < heading.end
        && !protectedExplicitHeadings.some((protectedHeading) => (
          position >= protectedHeading.start && position < protectedHeading.end
        ))
      ))
    ));
    if (
      !heading.customEligible
      || knownHeading
      || containsKnownMatch
      || knownKeys.has(key)
      || !isSafeCustomInterest(heading.text)
    ) return;
    const label = titleCustomInterest(heading.text);
    const normalizedLabel = normalizeInterestKey(label);
    if (knownKeys.has(normalizedLabel) || custom.some((candidate) => candidate.key === normalizedLabel)) return;
    custom.push({
      label,
      key: normalizedLabel,
      priority: heading.explicit ? 0 : 3,
      position: heading.start,
      taxonomyIndex: RULES.length + index,
    });
  });

  return [...known, ...custom]
    .sort(compareCandidates)
    .slice(0, INTEREST_TAXONOMY.maxInterests)
    .map(({ label }) => label);
}
