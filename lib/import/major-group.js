export const MAJOR_GROUP_ORDER = Object.freeze([
  'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
  'Social Sciences', 'Arts, Media & Design', 'Education & Humanities',
  'Other / Undeclared',
]);

const MAJOR_EXACT_GROUPS = new Map([
  ['cs', 'Computing & Data'],
  ['computer science', 'Computing & Data'],
  ['computer science cs', 'Computing & Data'],
  ['data science', 'Computing & Data'],
  ['software engineer', 'Computing & Data'],
  ['software engineering', 'Computing & Data'],
  ['mis', 'Business'],
  ['management information system', 'Business'],
  ['management information systems', 'Business'],
  ['business management information systems', 'Business'],
  ['business management info systems', 'Business'],
  ['business admin management information systems', 'Business'],
  ['finance mis', 'Business'],
  ['mis mba', 'Business'],
  ['management aviation', 'Business'],
  ['major not listed', 'Other / Undeclared'],
  ['n a', 'Other / Undeclared'],
  ['undeclared', 'Other / Undeclared'],
]);

const MAJOR_PHRASE_RULES = [
  ['Business', [
    /\bmanagement info(?:rmation)? systems?\b/, /\bmis\b/, /\bbusiness\b/,
    /\baccounting\b/, /\bfinance\b/, /\bmarketing\b/, /\bentrepreneurship\b/,
    /\bhuman resources?\b/, /\bmba\b/, /\boperations? (?:and )?supply ?chain\b/,
    /\bhospitality\b/,
  ]],
  ['Engineering', [
    /\bcomputer engineering\b/, /\bcomp engineering\b/, /\bcmpe\b/,
    /\bmechanical engineer(?:ing)?\b/, /\bmech e\b/, /\belectrical engineer(?:ing)?\b/,
    /\bcivil engineer(?:ing)?\b/, /\baerospace engineer(?:ing)?\b/,
    /\bindustrial engineer(?:ing)?\b/, /\bmanufacturing (?:systems?|engineering)\b/,
    /\betech manufacturing sys\b/, /\bbiomedical engineer(?:ing)?\b/,
    /\bchemical engineer(?:ing)?\b/, /\bmaterials? engineer(?:ing)?\b/,
    /\btechnology engineering\b/,
  ]],
  ['Computing & Data', [
    /\bcomputer science\b/, /\bdata science\b/, /\bsoftware engineer(?:ing)?\b/,
    /\bapplied computing\b/, /\bcomputer network system management\b/,
    /\btechnical informatics\b/, /\bstatistics\b/,
  ]],
  ['Health & Life Sciences', [
    /\bpublic health\b/, /\bnursing\b/, /\bpre nursing\b/, /\bbiology\b/,
    /\bbiological science/, /\bbiochem(?:istry)?\b/, /\bbiotech(?:nology)?\b/,
    /\bkinesiology\b/, /\bnutrition\b/, /\bhealth science\b/, /\bmicrobiology\b/,
    /\bmolecular biology\b/, /\boccupational therapy\b/, /\bzoology\b/,
    /\bmarine bio/,
  ]],
  ['Social Sciences', [
    /\bpsych(?:ology)?\b/, /\bsociology\b/, /\beconomics?\b/,
    /\bpolitical science\b/, /\banthropology\b/, /\bcommunications? studies\b/,
    /\bbehavioral sciences?\b/, /\bsocial work\b/, /\bjustice studies\b/,
    /\bglobal studies\b/,
  ]],
  ['Arts, Media & Design', [
    /\bgraphic design\b/, /\bdesign studies\b/, /\binteraction design\b/,
    /\banimation\b/, /\billustration\b/, /\bfilm\b/, /\bmusic\b/,
    /\bjournalism\b/, /\bphotography\b/, /\bdigital media\b/,
    /\bart studio\b/, /\btheatre arts\b/,
  ]],
  ['Education & Humanities', [
    /\benglish\b/, /\bhistory\b/, /\bphilosophy\b/, /\beducation\b/,
    /\bliberal studies\b/, /\blinguistics\b/, /\bhumanities\b/,
    /\bteacher preparation\b/,
  ]],
];

function normalizationKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeMajorGroup(value) {
  const normalized = normalizationKey(value);
  if (!normalized) return 'Other / Undeclared';
  if (MAJOR_EXACT_GROUPS.has(normalized)) return MAJOR_EXACT_GROUPS.get(normalized);
  for (const [group, patterns] of MAJOR_PHRASE_RULES) {
    if (patterns.some((pattern) => pattern.test(normalized))) return group;
  }
  return 'Other / Undeclared';
}

export function isMajorGroup(value) {
  return MAJOR_GROUP_ORDER.includes(value);
}

export function resolveMajorGroup(major, override = '') {
  return isMajorGroup(override) ? override : normalizeMajorGroup(major);
}
