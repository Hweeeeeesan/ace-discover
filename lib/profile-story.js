function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const NUMBERED_LINE = /^(\d{1,2})[.)]\s*(\S[\s\S]*)$/u;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?<!\w)(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}(?!\w)/;
const LABEL_SENTENCE_START = /^(?:i|i'm|im|my|we|we're|we are|you|it|this|that|there)\b/i;
const TOKEN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'is', 'making', 'my', 'of', 'on', 'the', 'to', 'with',
]);

function numberedEntries(value) {
  const lines = clean(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches = lines.map((line) => line.match(NUMBERED_LINE));
  if (!matches.length || matches.some((match) => !match)) return [];
  if (matches.some((match, index) => Number(match[1]) !== index + 1)) return [];
  return matches.map((match) => match[2].trim());
}

function numberedItems(value) {
  return numberedEntries(value);
}

function containsPrivateContact(value) {
  return EMAIL.test(value) || PHONE.test(value);
}

function conciseHobbyLabel(value) {
  const label = clean(value).replace(/^\d{1,2}[.)]\s*/, '');
  if (!label || label.length > 80 || containsPrivateContact(label)) return '';
  if (label.split(/\s+/).length > 12 || LABEL_SENTENCE_START.test(label)) return '';
  const withoutEllipses = label.replace(/\.{2,}/g, '');
  if (/[.!?]\s+\S/u.test(withoutEllipses)) return '';
  return label;
}

function validStructuredEntry(name, detail) {
  const safeName = conciseHobbyLabel(name);
  const safeDetail = clean(detail);
  if (!safeName || safeDetail.length < 2 || containsPrivateContact(`${safeName}\n${safeDetail}`)) return null;
  if (/^[:;=8xX-]*[)(/\\dDpP]+$/u.test(safeDetail)) return null;
  return { name: safeName, detail: safeDetail };
}

function structuredHobbyLabel(line) {
  // A normal label uses the first colon, but some applicants include a
  // colon-like phrase in the hobby name itself (for example, “information:
  // maxxing...?: explanation”). In that case, use the later boundary when
  // the intervening phrase is visibly label-like punctuation.
  const normalizedLine = line.replace(/^\d{1,2}[.)]\s*/, '').trim();
  const colonPositions = [...normalizedLine.matchAll(/:/g)].map((match) => match.index);
  if (!colonPositions.length) return null;
  let boundary = colonPositions[0];
  if (colonPositions.length > 1) {
    const lastBoundary = colonPositions.at(-1);
    const intervening = normalizedLine.slice(colonPositions[0] + 1, lastBoundary).trim();
    const candidate = normalizedLine.slice(0, lastBoundary).trim();
    if (
      candidate.length >= 2
      && candidate.length <= 80
      && /(?:\.{2,}|[!?])/.test(intervening)
    ) boundary = lastBoundary;
  }
  const name = normalizedLine.slice(0, boundary).replace(/\s*:\s*/g, ' ').trim();
  const detail = normalizedLine.slice(boundary + 1).trim();
  return validStructuredEntry(name, detail);
}

function structuredDashEntry(line) {
  const normalizedLine = line.replace(/^\d{1,2}[.)]\s*/, '').trim();
  const match = normalizedLine.match(/^(.{2,80}?)\s+[–—-]\s+(.+)$/u);
  return match ? validStructuredEntry(match[1], match[2]) : null;
}

function topLevelHobbyNames(value) {
  const rawParts = [];
  let current = '';
  let depth = 0;
  for (const character of clean(value)) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth = Math.max(0, depth - 1);
    if (depth === 0 && [',', ';', '\n', '\r'].includes(character)) {
      if (clean(current)) rawParts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (clean(current)) rawParts.push(current);
  const labels = rawParts.map(conciseHobbyLabel);
  return labels.every(Boolean) ? labels : [];
}

function tokenVariants(value) {
  const tokens = clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((token) => token.length >= 3 && !TOKEN_STOP_WORDS.has(token)).flatMap((token) => {
    const variants = [token];
    if (token.length > 5 && token.endsWith('ing')) {
      const root = token.slice(0, -3);
      variants.push(root, `${root}e`);
    }
    if (token.length > 4 && token.endsWith('ed')) variants.push(token.slice(0, -2));
    if (token.length > 4 && token.endsWith('s')) variants.push(token.slice(0, -1));
    return variants;
  });
}

function labelMatchesExplanation(label, explanation) {
  const labelTokens = tokenVariants(label);
  const detailTokens = tokenVariants(explanation);
  return labelTokens.some((labelToken) => detailTokens.some((detailToken) => (
    labelToken === detailToken
    || (Math.min(labelToken.length, detailToken.length) >= 4
      && (labelToken.startsWith(detailToken) || detailToken.startsWith(labelToken)))
  )));
}

function parseHobbies(hobbies, details) {
  const names = topLevelHobbyNames(hobbies);
  const explanationLines = clean(details).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const explicit = explanationLines.map((line) => structuredHobbyLabel(line) || structuredDashEntry(line));
  if (explicit.length && explicit.every(Boolean)) return { items: explicit, format: 'structured' };

  const numbered = numberedEntries(details);
  const safeToPair = numbered.length >= 2
    && names.length === numbered.length
    && !containsPrivateContact(`${hobbies}\n${details}`)
    && names.every((name, index) => labelMatchesExplanation(name, numbered[index]));
  if (safeToPair) {
    return {
      items: names.map((name, index) => ({ name, detail: numbered[index] })),
      format: 'paired',
    };
  }
  if (numbered.length) return { items: [], format: 'numbered' };
  if (names.length && !details) return { items: names.map((name) => ({ name })), format: 'names' };
  return { items: [], format: 'raw' };
}

export function normalizeProfileStory(profile = {}) {
  const hobbies = clean(profile.hobbies);
  const hobbyDetails = clean(profile.hobbyDetails);
  const parsedHobbies = parseHobbies(hobbies, hobbyDetails);
  const story = {
    tagline: clean(profile.tagline),
    uniqueThings: numberedItems(profile.uniqueThings),
    uniqueThingsText: clean(profile.uniqueThings),
    passion: clean(profile.passion),
    perfectDay: clean(profile.perfectDay),
    hobbies,
    hobbyDetails,
    hobbyItems: parsedHobbies.items,
    hobbyFormat: parsedHobbies.format,
    music: clean(profile.music),
    moviesTv: clean(profile.movies || profile.moviesTv),
    idealHangout: clean(profile.idealHangout),
    bucketList: clean(profile.bucketList),
    hotTake: clean(profile.hotTake),
  };
  story.isEditorial = Boolean(
    story.tagline || story.uniqueThingsText || story.passion || story.idealHangout
      || story.bucketList || story.hotTake || story.hobbyDetails,
  );
  return story;
}

export function normalizeProfileIntro(profile = {}, story = normalizeProfileStory(profile)) {
  const bio = clean(profile.bio);
  return {
    tagline: story.isEditorial ? story.tagline : '',
    bio: /^(?:little|big|family) applicant$/i.test(bio) ? '' : bio,
  };
}
