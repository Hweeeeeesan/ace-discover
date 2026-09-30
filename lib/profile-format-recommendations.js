const NUMBERED_RE = /^\s*(\d+)[.)]\s*(.+)$/;
const LABELED_RE = /^(.+?)\s*(?::|\s[-–—]\s+)(.+)$/;
const UNMATCHED = '__unmatched__';

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function splitLines(value) {
  return normalizeLineEndings(value)
    .replace(/\s*\|\s*/g, '\n')
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean);
}

function stripListPrefix(value) {
  return String(value || '').replace(/^\s*(?:[-–—*]\s+|\d+[.)]\s+)/, '').trim();
}

function hobbyTargets(value) {
  const text = normalizeLineEndings(value);
  const separated = splitLines(text);
  if (separated.length > 1) return separated.map(stripListPrefix);
  if (text.includes(',') && !/[.!?]/.test(text)) return text.split(',').map((item) => item.trim()).filter(Boolean);
  return separated.map(stripListPrefix);
}

function exactTarget(label, hobbies) {
  const normalized = String(label || '').trim().toLocaleLowerCase();
  return hobbies.find((hobby) => hobby.toLocaleLowerCase() === normalized) || null;
}

function parseDescriptionChunks(value) {
  const rawLines = splitLines(value);
  if (!rawLines.length) return [];
  const numbered = rawLines.every((line) => NUMBERED_RE.test(line));
  return rawLines.map((line, index) => {
    const number = line.match(NUMBERED_RE);
    const labeled = line.match(LABELED_RE);
    return {
      id: `description-${index + 1}`,
      text: labeled ? labeled[2].trim() : number ? number[2].trim() : line,
      label: labeled ? labeled[1].trim() : '',
      number: number ? Number(number[1]) : null,
      numbered,
    };
  });
}

function sameHobby(left, right) {
  return String(left || '').toLocaleLowerCase() === String(right || '').toLocaleLowerCase();
}

function buildSuggestedDetails(hobbies, matches) {
  const byHobby = new Map(matches.map((match) => [match.hobby, match.text]));
  return hobbies.map((hobby) => byHobby.get(hobby)).filter(Boolean).join('\n');
}

export const UNMATCHED_HOBBY = UNMATCHED;

export function analyzeProfileFormatting({ hobbies = '', hobbyDetails = '' } = {}) {
  const hobbyTargetsList = hobbyTargets(hobbies);
  const current = { hobbies: normalizeLineEndings(hobbies), hobbyDetails: normalizeLineEndings(hobbyDetails) };
  const chunks = parseDescriptionChunks(hobbyDetails);
  if (!chunks.length) {
    return {
      status: 'no-descriptions', confidence: 'UNMATCHED', pattern: 'none', current,
      hobbies: hobbyTargetsList, descriptions: [], suggested: [], canApply: false,
      reason: 'No separate hobby description chunks were detected.',
    };
  }

  const hasLabels = chunks.some((chunk) => chunk.label);
  const allSequential = chunks.every((chunk) => chunk.number !== null)
    && chunks.every((chunk, index) => chunk.number === index + 1);
  const positional = !hasLabels && allSequential && chunks.length === hobbyTargetsList.length;
  const cleanParallel = !hasLabels && chunks.every((chunk) => chunk.number === null)
    && chunks.length === hobbyTargetsList.length;
  const countMismatch = !hasLabels && chunks.some((chunk) => chunk.number !== null)
    && (!allSequential || chunks.length !== hobbyTargetsList.length);

  const descriptions = chunks.map((chunk, index) => {
    const exact = exactTarget(chunk.label, hobbyTargetsList);
    const hobby = exact || (positional || cleanParallel ? hobbyTargetsList[index] : UNMATCHED);
    return {
      ...chunk,
      hobby,
      matchType: exact ? 'EXACT' : (positional || cleanParallel) ? 'POSITIONAL' : 'UNMATCHED',
    };
  });

  const hasUnmatched = descriptions.some((description) => description.hobby === UNMATCHED);
  if (cleanParallel) {
    return {
      status: 'clean', confidence: 'POSITIONAL', pattern: 'parallel', current, hobbies: hobbyTargetsList, descriptions,
      suggested: descriptions, canApply: false,
    };
  }

  return {
    status: hasUnmatched || countMismatch ? 'manual-review' : 'recommendation',
    confidence: hasUnmatched || countMismatch ? 'UNMATCHED' : descriptions.every((d) => d.matchType === 'EXACT') ? 'EXACT' : 'POSITIONAL',
    pattern: hasLabels ? 'labeled' : allSequential ? 'numbered' : 'delimited',
    current,
    hobbies: hobbyTargetsList,
    descriptions,
    suggested: descriptions,
    canApply: !hasUnmatched && !countMismatch,
    reason: countMismatch
      ? 'The numbered descriptions do not align one-to-one with the listed hobbies.'
      : hasUnmatched ? 'Some descriptions have no safe automatic hobby match.' : '',
  };
}

export function applyDescriptionMatches(hobbies, descriptions) {
  const targets = hobbyTargets(hobbies);
  const assigned = descriptions.filter((description) => description.hobby && description.hobby !== UNMATCHED);
  const normalizedAssignments = assigned.map((description) => description.hobby.toLocaleLowerCase());
  const duplicate = normalizedAssignments.find((hobby, index) => normalizedAssignments.indexOf(hobby) !== index);
  if (duplicate || assigned.length !== descriptions.length || !assigned.length || !assigned.every((description) => targets.some((target) => sameHobby(target, description.hobby)))) {
    return { ok: false, reason: 'Every detected description must have one unique hobby match before applying; unmatched text is preserved by leaving the current value unchanged.' };
  }
  return { ok: true, hobbyDetails: buildSuggestedDetails(targets, assigned) };
}
