// JavaScript runtime port of scripts/import-master-apps.py. The Sheet tests run
// every supported layout through both implementations to guard mapping drift.
import {
  MAX_INFERRED_VIBES,
  scoreVibeEvidence,
  VIBE_FIELD_WEIGHTS,
  VIBE_ORDER,
  VIBE_SCORE_THRESHOLD,
} from './vibe-evidence.js';
import { MAJOR_GROUP_ORDER, normalizeMajorGroup } from './major-group.js';
import { extractInterests } from './interest-extraction.js';

const PLACEHOLDER_IMAGE = '/profile-placeholder.svg';

export {
  MAX_INFERRED_VIBES,
  scoreVibeEvidence,
  VIBE_FIELD_WEIGHTS,
  VIBE_ORDER,
  VIBE_SCORE_THRESHOLD,
};

const BASE_SHEET_CONFIGS = {
  LITTLES: {
    aliases: ['littles', 'little', 'little apps', 'little applications'],
    role: 'Little', name: ['E', 'F'], year: 'M', school: 'O', major: 'P', program: 'R',
    hobbies: ['AA', 'S'], music: 'AG', movies: 'AH', perfectDay: 'AJ', story: 'BA',
    instagram: 'BD', image: 'BE', deck: 'BG', family: ['BH', 'U'],
    socialLevel: ['AU', 'BN'], socialStyle: ['AW', 'BP'],
  },
  BIGS: {
    aliases: ['bigs', 'big', 'big apps', 'big applications'],
    role: 'Big', name: ['E', 'F'], year: 'M', school: 'O', major: 'P', program: 'R',
    hobbies: ['AE', 'S'], music: 'AK', movies: 'AL', perfectDay: 'AN', story: 'BD',
    instagram: 'BG', image: 'BH', deck: 'BJ', family: ['T'],
    socialLevel: ['AY'], socialStyle: ['BA'],
  },
  FAMS: {
    aliases: ['fams', 'fam', 'family', 'families', 'family apps', 'family applications'],
    role: 'Family', name: ['E', 'F'], year: 'M', school: 'O', major: 'P', program: 'R',
    hobbies: ['S', 'AT'], music: 'U', movies: 'V', perfectDay: 'W', story: null,
    instagram: ['AK', 'BW', 'DN'], image: ['AL', 'BX', 'DO'], deck: ['BZ', 'DQ'],
    family: ['AN', 'CA'], socialLevel: ['AH', 'BN', 'DF'], socialStyle: ['BP', 'DH'],
  },
};

const MISSING_VALUES = new Set([
  '', '.', '..', '-', '--', 'n/a', 'na', 'none', 'no', 'nope', 'null',
  'not applicable', 'not available', 'did not submit', "didn't submit",
]);
const GOOGLE_DOC_HOSTS = new Set(['docs.google.com', 'sheets.google.com', 'slides.google.com']);
const DIRECT_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];
const PUBLIC_EXCLUDED_KEYS = new Set([
  'imageSourceUrl', 'driveFileId', 'driveFolderId', 'storagePath', 'resolvedDriveFileId',
  'imageIssue', 'imageKind', 'sourceGroup', 'sourceRow',
]);
const EMAIL_PATTERN = '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b';
const PHONE_PATTERN = '(?<!\\w)(?:\\+?1[ .-]?)?(?:\\(?\\d{3}\\)?[ .-]?)\\d{3}[ .-]?\\d{4}(?!\\w)';
const SCIENTIFIC_PHONE_PATTERN = '(?<!\\w)\\d(?:\\.\\d{7,12})?[Ee]\\+?9(?!\\w)';
const SENSITIVE_PARAMETER_PATTERN = '(?:^|[?&#;\\s])(?:access_token|refresh_token|id_token|client_secret|api_key|apikey|service_role_key|private_key)\\s*=\\s*[^&#;\\s]+';
const PRIVATE_KEY_PATTERN = '-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----';
const HTTP_URL_PATTERN = 'https?://[^\\s<>"\']+';
const INSTAGRAM_HANDLE_RE = /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_RESERVED_PATHS = new Set(['accounts', 'direct', 'explore', 'p', 'reel', 'reels', 'stories']);

const PROGRAM_ROLE_MAP = new Map([
  ['fam ace little program', 'Little'],
  ['family ace little program', 'Little'],
  ['family and ace little program', 'Little'],
  ['ace little program', 'Little'],
  ['ace big only program', 'Big'],
  ['ace big only', 'Big'],
  ['ace bigs only', 'Big'],
  ['ace bigs only program', 'Big'],
  ['family program family only', 'Family'],
  ['family program only', 'Family'],
  ['family only program', 'Family'],
  ['family only', 'Family'],
  ['fam program only', 'Family'],
  ['fam only program', 'Family'],
  ['fam only', 'Family'],
]);

function safeCellText(value) {
  return [...String(value || '')]
    .filter((character) => ['\t', '\n', '\r'].includes(character) || character.codePointAt(0) >= 32)
    .join('');
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function columnIndex(column) {
  return [...String(column || '')].reduce(
    (index, character) => index * 26 + character.charCodeAt(0) - 64,
    0,
  ) - 1;
}

function rowFromValues(values = []) {
  const row = {};
  values.forEach((value, index) => {
    const text = safeCellText(value).trim();
    if (text) row[columnName(index)] = text;
  });
  return row;
}

function sheetNameKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function logicalSheetName(tabTitle) {
  const key = sheetNameKey(tabTitle);
  if (key === 'form responses 1') return 'BIGS';
  for (const [name, config] of Object.entries(BASE_SHEET_CONFIGS)) {
    if (config.aliases.some((alias) => sheetNameKey(alias) === key)) return name;
  }
  // Match the Python Sheet adapter: a selected, renamed Google Forms tab is
  // treated as the single-response layout and still must pass schema checks.
  return 'BIGS';
}

function firstColumn(columns) {
  return Array.isArray(columns) ? columns[0] : columns;
}

function matchingHeaderColumns(headers, tokens) {
  return Object.entries(headers)
    .filter(([, header]) => tokens.every((token) => String(header).toLowerCase().includes(token)))
    .map(([column]) => column)
    .sort((left, right) => columnIndex(left) - columnIndex(right));
}

function fall2026RoleScopedColumns(headers, {
  fieldName,
  headerTokens,
  allowLegacyMissingBig = false,
  bigAnchorTokens = null,
}) {
  const hobbyStarts = matchingHeaderColumns(headers, ['list your', 'favorite hobbies/activities']);
  const fieldColumns = matchingHeaderColumns(headers, headerTokens);
  if (hobbyStarts.length !== 2) {
    throw new Error(`BIGS schema mismatch: Fall 2026 Little and Big ${fieldName} headers could not be resolved safely.`);
  }
  const littleCandidates = fieldColumns.filter((column) => (
    columnIndex(column) > columnIndex(hobbyStarts[0])
    && columnIndex(column) < columnIndex(hobbyStarts[1])
  ));
  const bigCandidates = fieldColumns.filter((column) => (
    columnIndex(column) > columnIndex(hobbyStarts[1])
  ));
  const bigAnchors = bigAnchorTokens ? matchingHeaderColumns(headers, bigAnchorTokens) : [];
  const legacyMissingBig = allowLegacyMissingBig
    && bigCandidates.length === 0
    && bigAnchors.length === 0;
  const invalidAnchor = bigAnchorTokens && !legacyMissingBig && (
    bigAnchors.length !== 1
    || bigCandidates.length !== 1
    || columnIndex(bigCandidates[0]) <= columnIndex(bigAnchors[0])
  );
  if (
    littleCandidates.length !== 1
    || fieldColumns.length !== (legacyMissingBig ? 1 : 2)
    || (!legacyMissingBig && bigCandidates.length !== 1)
    || invalidAnchor
  ) {
    throw new Error(`BIGS schema mismatch: Fall 2026 Little and Big ${fieldName} headers could not be resolved safely.`);
  }
  return {
    Little: littleCandidates[0],
    Family: littleCandidates[0],
    Big: legacyMissingBig ? null : bigCandidates[0],
  };
}

function fall2026PassionColumns(headers) {
  return fall2026RoleScopedColumns(headers, {
    fieldName: 'passion',
    headerTokens: ['passionate', 'talk about', 'hours'],
  });
}

function fall2026IdealHangoutColumns(headers) {
  return fall2026RoleScopedColumns(headers, {
    fieldName: 'ideal hangout',
    headerTokens: ['what', 'ideal hangout'],
    allowLegacyMissingBig: true,
    bigAnchorTokens: ['subtle ace trait', 'slide'],
  });
}

function selectSheetConfig(sheetName, headers) {
  const config = { ...BASE_SHEET_CONFIGS[sheetName] };
  if (sheetName === 'LITTLES' && String(headers.BC || '').toLowerCase().includes('instagram')) {
    Object.assign(config, {
      family: ['S'], hobbies: ['Y'], music: 'AE', movies: 'AF', perfectDay: 'AH',
      story: 'AZ', instagram: 'BC', image: 'BD', deck: null,
      socialLevel: ['AT'], socialStyle: ['AV'],
    });
  } else if (sheetName === 'BIGS' && String(headers.CD || '').toLowerCase().includes('personality')) {
    const passionByRole = fall2026PassionColumns(headers);
    const idealHangoutByRole = fall2026IdealHangoutColumns(headers);
    Object.assign(config, {
      year: 'N', school: 'P', major: 'Q', program: 'R', family: ['AS', 'BN'],
      hobbies: ['S', 'BY'], hobbyDetails: ['T', 'BZ'], music: ['U', 'CA'],
      movies: ['V', 'CB'], passionByRole, tagline: ['X', 'CD'],
      perfectDay: ['Y', 'CE'], uniqueThings: ['W', 'CF'], bucketList: ['AB', 'CG'],
      hotTake: ['Z', 'CH'], idealHangoutByRole, instagram: 'K', image: ['AQ', 'CX'],
      deck: null, socialLevel: ['AL', 'CS'], socialStyle: ['AN', 'CU'],
      story: ['BL', 'CV'], f26: true,
    });
  } else if (sheetName === 'BIGS' && String(headers.DN || '').toLowerCase().includes('instagram')) {
    Object.assign(config, {
      family: ['CA', 'AN'], hobbies: ['CL', 'AT'], music: 'CR', movies: 'CS',
      perfectDay: 'CU', story: 'DK', instagram: 'DN', image: 'DO', deck: 'DQ',
      socialLevel: ['DF', 'AH'], socialStyle: ['DH', 'AV'],
    });
  }
  return config;
}

function validateSheetSchema(sheetName, headers, config) {
  const expected = [
    ['E', ['first']],
    ['F', ['last']],
    [firstColumn(config.instagram), ['instagram']],
    [firstColumn(config.socialLevel), ['social setting']],
    [firstColumn(config.socialStyle), ['introvert', 'mbti']],
  ];
  for (const [column, tokens] of expected) {
    const header = String(headers[column] || '').toLowerCase();
    if (!tokens.some((token) => header.includes(token))) {
      throw new Error(`${sheetName} schema mismatch: expected ${JSON.stringify(tokens.length === 1 ? tokens[0] : tokens)} in column ${column} header.`);
    }
  }
}

function first(row, columns) {
  if (!columns) return '';
  for (const column of Array.isArray(columns) ? columns : [columns]) {
    const value = String(row[column] || '').trim();
    if (value) return value;
  }
  return '';
}

export function cleanText(value) {
  return String(value || '').replace(/\0/g, ' ').trim().replace(/\s+/g, ' ');
}

function normalizationKey(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeProgramRole(value) {
  return PROGRAM_ROLE_MAP.get(normalizationKey(value));
}

function deriveProfileRole(program, sheetRole, programIsAuthoritative = false) {
  if (!programIsAuthoritative) return sheetRole;
  const role = normalizeProgramRole(program);
  if (role) return role;
  throw new Error(`Fall 2026 program choice is missing or unrecognized; role was not inferred: ${JSON.stringify(cleanText(program))}`);
}

function normalizeYear(value) {
  const normalized = normalizationKey(value);
  if (!normalized || new Set(['n a', 'na', 'none', 'year not listed', 'not listed']).has(normalized)) return '';
  if (/^(?:first|1st|1st year|freshman|year 1|1 year|first year)$/.test(normalized)) return 'First year';
  if (/^(?:second|2nd|2nd year|sophomore|year 2|2 year|second year)$/.test(normalized)) return 'Second year';
  if (/^(?:third|3rd|3rd year|junior|year 3|3 year|third year)$/.test(normalized)) return 'Third year';
  if (/^(?:fourth|4th|senior|year 4|4 year|fourth year)$/.test(normalized)) return 'Fourth year+';
  if (/\b(?:fifth|5th|sixth|6th)\b/.test(normalized)) return 'Fourth year+';
  return 'Graduate / Other';
}

function parseSocialLevel(value) {
  const normalized = cleanText(value);
  if (!/^[1-5](?:\.0+)?$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function normalizeSocialStyle(value) {
  const normalized = normalizationKey(value);
  if (!normalized) return '';
  const hasIntrovert = /\bintrovert\w*\b/.test(normalized);
  const hasExtrovert = /\bextrovert\w*\b/.test(normalized);
  const hasAmbivert = /\bambivert\w*\b|\bambi\b/.test(normalized);
  if (hasAmbivert || (hasIntrovert && hasExtrovert)) return 'Ambivert';
  if (hasIntrovert) return 'Introvert';
  if (hasExtrovert) return 'Extrovert';
  return '';
}

function firstParsed(row, columns, parser) {
  for (const column of columns || []) {
    const parsed = parser(row[column] || '');
    if (parsed !== null && parsed !== '') return parsed;
  }
  return parser === parseSocialLevel ? null : '';
}

export function redactPii(value) {
  let text = cleanText(value)
    .replace(new RegExp(EMAIL_PATTERN, 'gi'), '[email removed]')
    .replace(new RegExp(PHONE_PATTERN, 'g'), '[phone removed]')
    .replace(new RegExp(SCIENTIFIC_PHONE_PATTERN, 'gi'), '[phone removed]');
  if (new RegExp(PRIVATE_KEY_PATTERN, 'i').test(text)) return '[private credential removed]';
  if (new RegExp(SENSITIVE_PARAMETER_PATTERN, 'i').test(text)) {
    text = text
      .replace(new RegExp(HTTP_URL_PATTERN, 'gi'), '[link with embedded credentials removed]')
      .replace(new RegExp(SENSITIVE_PARAMETER_PATTERN, 'gi'), '[embedded credential removed]');
  }
  return text;
}

function redactMultiline(value) {
  return String(value || '').replace(/\r\n/g, '\n').split('\n').map(redactPii).join('\n').trim();
}

function validInstagramHandle(value) {
  return INSTAGRAM_HANDLE_RE.test(String(value || ''));
}

function instagramHandleFromUrl(value) {
  let candidate = String(value || '').replace(/[.,);\]]+$/, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return '';
  }
  if (!['instagram.com', 'www.instagram.com'].includes(parsed.hostname.toLowerCase())) return '';
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 1) return '';
  const handle = pathParts[0];
  if (INSTAGRAM_RESERVED_PATHS.has(handle.toLowerCase()) || !validInstagramHandle(handle)) return '';
  return handle;
}

export function normalizeInstagram(value) {
  const text = cleanText(value);
  const lower = text.toLowerCase();
  if (MISSING_VALUES.has(lower)) return '';
  if (["don't have instagram", 'do not have instagram', "don't have one", 'no instagram', 'without instagram'].some((phrase) => lower.includes(phrase))) return '';

  const candidates = [];
  const exactHandle = text.startsWith('@') ? text.slice(1) : text;
  if (validInstagramHandle(exactHandle)) candidates.push(exactHandle);

  for (const match of text.matchAll(/(?<![A-Za-z0-9._])((?:https?:\/\/)?(?:www\.)?instagram\.com\/[^\s<>"']+)/gi)) {
    const handle = instagramHandleFromUrl(match[1]);
    if (handle) candidates.push(handle);
  }
  for (const match of text.matchAll(/(?<![A-Za-z0-9._])@([A-Za-z0-9._]{1,30})(?![A-Za-z0-9._])/g)) candidates.push(match[1]);
  for (const match of text.matchAll(/\b(?:user(?:name)?|ig|instagram)(?:(?:\s+(?:is|handle))?\s*[:=]\s*|\s+(?:is|handle)\s+)@?([A-Za-z0-9._]{1,30})(?![A-Za-z0-9._])/gi)) candidates.push(match[1]);
  for (const match of text.matchAll(/(?<![A-Za-z0-9._])([A-Za-z0-9._]{1,30})\s+on\s+instagram\b/gi)) candidates.push(match[1]);

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const handle = String(candidate).trim().replace(/^@/, '');
    const key = handle.toLowerCase();
    if (!validInstagramHandle(handle) || INSTAGRAM_RESERVED_PATHS.has(key) || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique.length === 1 ? `https://www.instagram.com/${unique[0]}/` : '';
}

function firstInstagram(row, columns) {
  for (const column of Array.isArray(columns) ? columns : [columns]) {
    const normalized = normalizeInstagram(row[column] || '');
    if (normalized) return normalized;
  }
  return '';
}

function looksLikeName(value) {
  return /^[A-Za-z][A-Za-z .'-]{0,60}$/.test(cleanText(value));
}

function isLegacyBigCompactRow(row) {
  return new RegExp(EMAIL_PATTERN, 'i').test(cleanText(row.E))
    && looksLikeName(row.B)
    && looksLikeName(row.C);
}

function isLegacyBigExpandedRow(row) {
  return cleanText(row.A).toLowerCase() === '(edit)'
    && looksLikeName(row.E)
    && looksLikeName(row.F)
    && new RegExp(`^(?:${EMAIL_PATTERN})$`, 'i').test(cleanText(row.B))
    && /^https?:\/\//.test(cleanText(row.BB))
    && !cleanText(row.BH);
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
}

function validDriveId(value) {
  const text = String(value || '');
  const upper = text.toUpperCase();
  return /^[A-Za-z0-9_-]{10,200}$/.test(text)
    && !['RESTRICTED', 'REDACTED', 'PLACEHOLDER', 'FILE_ID', 'FOLDER_ID'].some((token) => upper.includes(token));
}

function parseDriveSource(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!(host.endsWith('drive.google.com') || host.endsWith('googleusercontent.com'))) return null;

  const folderQueryId = parsed.searchParams.get('folderId') || '';
  if (folderQueryId) return validDriveId(folderQueryId) ? { type: 'folder', id: folderQueryId } : { type: 'invalid', id: '' };
  const folderMatch = parsed.pathname.match(/\/(?:folders|folder\/d)\/([A-Za-z0-9_-]{10,200})/);
  if (folderMatch) return validDriveId(folderMatch[1]) ? { type: 'folder', id: folderMatch[1] } : { type: 'invalid', id: '' };
  for (const pattern of [/\/file\/d\/([A-Za-z0-9_-]{10,200})/, /\/d\/([A-Za-z0-9_-]{10,200})(?:[=/]|$)/]) {
    const match = parsed.pathname.match(pattern);
    if (match) return validDriveId(match[1]) ? { type: 'file', id: match[1] } : { type: 'invalid', id: '' };
  }
  for (const key of ['id', 'fileId', 'folderId']) {
    const id = parsed.searchParams.get(key) || '';
    if (validDriveId(id)) return { type: 'file', id };
  }
  return { type: 'invalid', id: '' };
}

function parseImageSource(rawValue) {
  const raw = cleanText(rawValue);
  const lower = raw.toLowerCase().trim();
  const result = {
    source: raw,
    kind: 'missing',
    driveId: '',
    appUrl: PLACEHOLDER_IMAGE,
    issue: 'No image link was submitted.',
  };
  if (MISSING_VALUES.has(lower)) return result;
  if (lower.startsWith('file://')) return { ...result, kind: 'local-file', issue: 'A local computer file path cannot be loaded by a deployed website.' };

  let candidateUrl = raw;
  if (!/^https?:\/\//i.test(candidateUrl)) {
    const embedded = candidateUrl.match(/https?:\/\/[^\s<>"']+/i);
    if (!embedded) return { ...result, kind: 'invalid-value', issue: 'The image field contains text instead of an http(s) image link.' };
    candidateUrl = embedded[0].replace(/[.,);\]]+$/, '');
  }

  let parsed;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    return { ...result, kind: 'invalid-url', issue: 'The submitted image URL could not be parsed.' };
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '';
  const driveSource = parseDriveSource(candidateUrl);
  if (driveSource) {
    if (driveSource.type === 'invalid') return { ...result, kind: 'invalid-drive-link', issue: 'The submitted Drive link contains a placeholder or invalid file ID.' };
    const isFolder = driveSource.type === 'folder';
    return {
      ...result,
      kind: isFolder ? 'drive-folder' : 'drive-file',
      driveId: driveSource.id,
      appUrl: `/api/drive-image?${isFolder ? 'folderId' : 'fileId'}=${encodeURIComponent(driveSource.id)}`,
      issue: '',
    };
  }
  if (GOOGLE_DOC_HOSTS.has(host) || host.endsWith('.docs.google.com') || host === 'forms.gle') {
    return { ...result, kind: 'google-document', issue: 'A Google Docs, Sheets, or Slides page was submitted instead of an image file.' };
  }
  if (['photos.app.goo.gl', 'photos.google.com'].includes(host) || host.endsWith('.photos.google.com')) {
    return { ...result, kind: 'google-photos-share', issue: 'Download the photo and upload it as one individual Google Drive image file.' };
  }
  if (host === 'share.icloud.com') return { ...result, kind: 'icloud-share', issue: 'Download the photo and upload it as one individual Google Drive image file.' };
  if (['tiktok.com', 'www.tiktok.com', 'instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com'].includes(host)) {
    return { ...result, kind: 'social-share', issue: 'A social-media sharing page is not a direct image. Upload the image to Google Drive.' };
  }
  if (['http:', 'https:'].includes(parsed.protocol) && parsed.host) {
    if (DIRECT_IMAGE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) return { ...result, kind: 'direct-image-url', appUrl: candidateUrl, issue: '' };
    return { ...result, kind: 'unverified-web-url', issue: 'This sharing page is not an obvious direct image URL; replace it with a Drive image file.' };
  }
  return { ...result, kind: 'invalid-url', issue: 'The submitted value is not a supported image URL.' };
}

function normalizeDeck(value) {
  const url = cleanText(value);
  return url.startsWith('http://') || url.startsWith('https://') ? url : '';
}

function imageCandidates(image) {
  const candidates = [image.appUrl];
  if (image.kind === 'drive-file' && image.driveId) candidates.push(`https://drive.google.com/thumbnail?id=${encodeURIComponent(image.driveId)}&sz=w1600`);
  candidates.push(PLACEHOLDER_IMAGE);
  return [...new Set(candidates.filter(Boolean))];
}

export function interestTags(hobbies) {
  return extractInterests(redactMultiline(hobbies));
}

export function inferVibes(...values) {
  const fields = values.length === 1
    && values[0]
    && typeof values[0] === 'object'
    && !Array.isArray(values[0])
    ? values[0]
    : Object.fromEntries(
      ['hobbies', 'music', 'movies', 'perfectDay', 'story']
        .map((field, index) => [field, values[index] || '']),
    );
  return scoreVibeEvidence(fields)
    .filter(({ score }) => score >= VIBE_SCORE_THRESHOLD)
    .slice(0, MAX_INFERRED_VIBES)
    .map(({ vibe }) => vibe);
}

function publicProfile(profile) {
  return Object.fromEntries(Object.entries(profile).filter(([key]) => !PUBLIC_EXCLUDED_KEYS.has(key)));
}

function validatePublicProfilePrivacy(profiles) {
  const violations = [];
  const patterns = [EMAIL_PATTERN, PHONE_PATTERN, SCIENTIFIC_PHONE_PATTERN, PRIVATE_KEY_PATTERN, SENSITIVE_PARAMETER_PATTERN];
  for (const profile of profiles.map(publicProfile)) {
    for (const [field, value] of Object.entries(profile)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'string' && patterns.some((pattern) => new RegExp(pattern, 'i').test(item))) {
          violations.push({ profileId: profile.id || '', field });
        }
      }
    }
  }
  if (violations.length) {
    throw new Error(`Privacy validation blocked this import because sensitive data remained in public fields: ${JSON.stringify(violations.slice(0, 5))}`);
  }
}

function buildImportHealth(profiles) {
  const supportedImages = new Set(['drive-file', 'drive-folder', 'direct-image-url']);
  const imageCounts = {};
  const roleCounts = { Little: 0, Big: 0, Family: 0 };
  const vibeDistribution = Object.fromEntries(VIBE_ORDER.map((vibe) => [vibe, 0]));
  const majorGroupDistribution = Object.fromEntries(MAJOR_GROUP_ORDER.map((group) => [group, 0]));
  const socialLevelDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 'Missing / invalid': 0 };
  const socialStyleDistribution = { Introvert: 0, Ambivert: 0, Extrovert: 0, 'Missing / unknown': 0 };
  const issues = {
    missingInstagram: [], missingMajor: [], missingYear: [], missingMeaningfulText: [],
    missingOrInvalidImage: [], missingSocialLevel: [], missingSocialStyle: [],
    missingOrUnclassifiedMajorGroup: [],
  };
  for (const profile of profiles) {
    roleCounts[profile.role] = (roleCounts[profile.role] || 0) + 1;
    imageCounts[profile.imageKind] = (imageCounts[profile.imageKind] || 0) + 1;
    for (const vibe of profile.vibes) vibeDistribution[vibe] += 1;
    const majorGroup = profile.majorGroup || 'Other / Undeclared';
    majorGroupDistribution[majorGroup] += 1;
    if ([1, 2, 3, 4, 5].includes(profile.socialLevel)) socialLevelDistribution[profile.socialLevel] += 1;
    else {
      socialLevelDistribution['Missing / invalid'] += 1;
      issues.missingSocialLevel.push(profile.id);
    }
    if (['Introvert', 'Ambivert', 'Extrovert'].includes(profile.socialStyle)) socialStyleDistribution[profile.socialStyle] += 1;
    else {
      socialStyleDistribution['Missing / unknown'] += 1;
      issues.missingSocialStyle.push(profile.id);
    }
    if (majorGroup === 'Other / Undeclared') issues.missingOrUnclassifiedMajorGroup.push(profile.id);
    if (!profile.instagram) issues.missingInstagram.push(profile.id);
    if (new Set(['', 'n/a', 'na', 'none', 'major not listed']).has(cleanText(profile.major).toLowerCase())) issues.missingMajor.push(profile.id);
    if (new Set(['', 'n/a', 'na', 'none', 'year not listed']).has(cleanText(profile.year).toLowerCase())) issues.missingYear.push(profile.id);
    const meaningful = ['bio', 'hobbies', 'music', 'movies', 'perfectDay'].map((field) => profile[field] || '').join(' ');
    if (cleanText(meaningful).length < 40) issues.missingMeaningfulText.push(profile.id);
    if (!supportedImages.has(profile.imageKind)) issues.missingOrInvalidImage.push(profile.id);
  }
  const usableImages = Object.entries(imageCounts).reduce((total, [kind, count]) => total + (supportedImages.has(kind) ? count : 0), 0);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    totalProfiles: profiles.length,
    roleCounts,
    instagramCount: profiles.filter((profile) => profile.instagram).length,
    slideDeckCount: profiles.filter((profile) => profile.slideDeckUrl).length,
    imageStatus: {
      usable: usableImages,
      missingOrInvalid: profiles.length - usableImages,
      byKind: Object.fromEntries(Object.entries(imageCounts).sort(([left], [right]) => left.localeCompare(right))),
    },
    missingFieldCounts: Object.fromEntries(Object.entries(issues).map(([key, value]) => [key, value.length])),
    vibeDistribution,
    majorGroupDistribution,
    socialLevelDistribution,
    socialStyleDistribution,
    issues,
  };
}

function buildDatasetPayload(profiles) {
  validatePublicProfilePrivacy(profiles);
  const health = buildImportHealth(profiles);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const safeIssues = Object.fromEntries(Object.entries(health.issues).map(([key, profileIds]) => [
    key,
    profileIds.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name, role: byId.get(id).role })),
  ]));
  return {
    profiles: profiles.map((profile) => ({
      public: publicProfile(profile),
      driveFileId: profile.driveFileId || '',
      driveFolderId: profile.driveFolderId || '',
      imageKind: profile.imageKind || '',
      imageIssue: profile.imageIssue || '',
    })),
    health,
    safeIssues,
    criticalErrors: [],
  };
}

function buildProfiles(tabTitle, values) {
  const sheetName = logicalSheetName(tabTitle);
  const headers = rowFromValues(values[0]);
  const config = selectSheetConfig(sheetName, headers);
  validateSheetSchema(sheetName, headers, config);
  const profiles = [];
  const seen = new Map();

  values.slice(1).forEach((valuesRow, index) => {
    const row = rowFromValues(valuesRow);
    let hobbyDetails = '';
    let passion = '';
    let tagline = '';
    let uniqueThings = '';
    let bucketList = '';
    let hotTake = '';
    let idealHangout = '';
    let firstName;
    let lastName;
    let year;
    let school;
    let major;
    let program;
    let family;
    let hobbies;
    let story;
    let perfectDay;
    let music;
    let movies;
    let instagram;
    let rawImage;
    let rawDeck;
    let socialLevel;
    let socialStyle;

    if (sheetName === 'BIGS' && isLegacyBigCompactRow(row)) {
      firstName = row.B || '';
      lastName = row.C || '';
      year = row.J || '';
      school = row.K || '';
      major = row.L || '';
      program = row.G || '';
      family = row.M || '';
      hobbies = row.S || '';
      story = row.P || '';
      perfectDay = '';
      music = '';
      movies = '';
      instagram = '';
      rawImage = '';
      rawDeck = '';
      socialLevel = null;
      socialStyle = '';
    } else if (sheetName === 'BIGS' && isLegacyBigExpandedRow(row)) {
      firstName = row.E || '';
      lastName = row.F || '';
      year = row.M || '';
      school = row.N || '';
      major = row.O || '';
      program = row.J || '';
      family = row.P || '';
      hobbies = row.Z || '';
      story = row.AX || '';
      perfectDay = row.AI || '';
      music = row.AF || '';
      movies = row.AG || '';
      instagram = normalizeInstagram(row.BA || '');
      rawImage = row.BB || '';
      rawDeck = '';
      socialLevel = parseSocialLevel(row.AS || '');
      socialStyle = normalizeSocialStyle(row.AU || '');
    } else {
      firstName = first(row, config.name[0]);
      lastName = first(row, config.name[1]);
      year = first(row, config.year);
      school = first(row, config.school);
      major = first(row, config.major);
      program = first(row, config.program);
      family = first(row, config.family);
      hobbies = first(row, config.hobbies);
      hobbyDetails = first(row, config.hobbyDetails);
      passion = first(row, config.passion);
      tagline = first(row, config.tagline);
      uniqueThings = first(row, config.uniqueThings);
      bucketList = first(row, config.bucketList);
      hotTake = first(row, config.hotTake);
      idealHangout = first(row, config.idealHangout);
      story = config.story ? first(row, config.story) : '';
      perfectDay = first(row, config.perfectDay);
      music = first(row, config.music);
      movies = first(row, config.movies);
      instagram = firstInstagram(row, config.instagram);
      rawImage = first(row, config.image);
      rawDeck = first(row, config.deck);
      socialLevel = firstParsed(row, config.socialLevel, parseSocialLevel);
      socialStyle = firstParsed(row, config.socialStyle, normalizeSocialStyle);
    }

    const name = redactPii(`${firstName} ${lastName}`);
    if (!name || name.includes('[email removed]') || name.includes('[phone removed]')) return;
    const role = deriveProfileRole(program, config.role, Boolean(config.f26));
    if (config.passionByRole) passion = first(row, config.passionByRole[role]);
    if (config.idealHangoutByRole) idealHangout = first(row, config.idealHangoutByRole[role]);
    const base = slugify(name);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    const id = occurrence === 1 ? base : `${base}-${occurrence}`;
    const image = parseImageSource(rawImage);
    const interests = interestTags(hobbies);

    profiles.push({
      id,
      name,
      role,
      major: redactPii(major) || 'Major not listed',
      majorGroup: normalizeMajorGroup(major),
      year: redactPii(year) || 'Year not listed',
      normalizedYear: normalizeYear(year),
      socialLevel,
      socialStyle,
      school: redactPii(school),
      program: redactPii(program),
      family: redactPii(family),
      bio: redactPii(story || hobbies || perfectDay),
      interests,
      vibes: inferVibes({
        hobbies,
        hobbyDetails,
        passion,
        perfectDay,
        idealHangout,
        story,
        music,
        movies,
      }),
      hobbies: redactMultiline(hobbies),
      hobbyDetails: redactMultiline(hobbyDetails),
      music: redactMultiline(music),
      movies: redactMultiline(movies),
      perfectDay: redactPii(perfectDay),
      tagline: redactMultiline(tagline),
      uniqueThings: redactMultiline(uniqueThings),
      passion: redactMultiline(passion),
      idealHangout: redactMultiline(idealHangout),
      bucketList: redactMultiline(bucketList),
      hotTake: redactMultiline(hotTake),
      instagram,
      image: image.appUrl,
      imageCandidates: imageCandidates(image),
      imageKind: image.kind,
      imageIssue: image.issue,
      imageSourceUrl: image.source,
      driveFileId: image.kind === 'drive-file' ? image.driveId : '',
      driveFolderId: image.kind === 'drive-folder' ? image.driveId : '',
      slideDeckUrl: normalizeDeck(rawDeck),
      sourceGroup: sheetName,
      sourceRow: index + 2,
    });
  });
  return profiles;
}

export function analyzeSheetValues(tabTitle, values) {
  if (!String(tabTitle || '') || !Array.isArray(values) || values.length < 2) {
    throw new Error('The selected worksheet is empty or invalid.');
  }
  const profiles = buildProfiles(tabTitle, values);
  if (!profiles.length) throw new Error('The worksheet did not contain any importable profiles.');
  return buildDatasetPayload(profiles);
}
