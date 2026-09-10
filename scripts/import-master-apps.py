#!/usr/bin/env python3
"""Import the Fall 2025 application workbook into the profile gallery.

The importer deliberately writes only profile-facing fields to lib/profiles.js.
A separate data/profiles.json file retains image-source metadata for dataset
seed/import tooling; remote image ingestion remains a separate dataset-scoped step.
"""

import csv
import json
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
import posixpath
from urllib.parse import parse_qs, quote, urlparse

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS = {'m': MAIN}
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
DOC_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PLACEHOLDER_IMAGE = '/profile-placeholder.svg'
VIBE_SCORING_PATH = Path(__file__).resolve().parents[1] / 'lib' / 'import' / 'vibe-scoring.json'
VIBE_SCORING = json.loads(VIBE_SCORING_PATH.read_text(encoding='utf-8'))
INTEREST_TAXONOMY_PATH = Path(__file__).resolve().parents[1] / 'lib' / 'import' / 'interest-taxonomy.json'
INTEREST_TAXONOMY = json.loads(INTEREST_TAXONOMY_PATH.read_text(encoding='utf-8'))
INTEREST_NEGATION_PATTERN = re.compile(
    r"\b(?:do not|don't|dont|never|hate(?:s|d)?|dislik(?:e|es|ed)|not into|"
    r"not a fan of|no interest in|can't stand|cant stand|cannot stand|"
    r"avoid(?:s|ed|ing)?)(?:\s+[a-z0-9']+){0,6}$",
    re.I,
)
VIBE_ORDER = [config['name'] for config in VIBE_SCORING['vibes']]
VIBE_SCORE_THRESHOLD = VIBE_SCORING['threshold']
MAX_INFERRED_VIBES = VIBE_SCORING['maxVibes']
VIBE_FIELD_WEIGHTS = VIBE_SCORING['fieldWeights']
VIBE_ORDER_INDEX = {vibe: index for index, vibe in enumerate(VIBE_ORDER)}
NEGATION_PATTERN = re.compile(
    r"(?:do not|don't|dont|never|hate(?:s|d)?|dislik(?:e|es|ed)|not into|"
    r"not a fan of|no interest in|can't stand|cant stand|cannot stand|"
    r"avoid(?:s|ed|ing)?)(?:\s+[a-z0-9']+){0,6}$"
)

YEAR_GROUP_ORDER = [
    'First year', 'Second year', 'Third year', 'Fourth year+', 'Graduate / Other',
]
MAJOR_GROUP_ORDER = [
    'Computing & Data', 'Engineering', 'Business', 'Health & Life Sciences',
    'Social Sciences', 'Arts, Media & Design', 'Education & Humanities',
    'Other / Undeclared',
]

# Exact normalized phrases are evaluated before the conservative phrase rules below.
# This makes the current dataset auditable while still handling minor punctuation/case changes.
MAJOR_EXACT_GROUPS = {
    'cs': 'Computing & Data',
    'computer science': 'Computing & Data',
    'computer science cs': 'Computing & Data',
    'data science': 'Computing & Data',
    'software engineer': 'Computing & Data',
    'software engineering': 'Computing & Data',
    'mis': 'Business',
    'management information system': 'Business',
    'management information systems': 'Business',
    'business management information systems': 'Business',
    'business management info systems': 'Business',
    'business admin management information systems': 'Business',
    'finance mis': 'Business',
    'mis mba': 'Business',
    'management aviation': 'Business',
    'major not listed': 'Other / Undeclared',
    'n a': 'Other / Undeclared',
    'undeclared': 'Other / Undeclared',
}

MAJOR_PHRASE_RULES = [
    ('Business', (
        r'\bmanagement info(?:rmation)? systems?\b', r'\bmis\b',
        r'\bbusiness\b', r'\baccounting\b', r'\bfinance\b', r'\bmarketing\b',
        r'\bentrepreneurship\b', r'\bhuman resources?\b', r'\bmba\b',
        r'\boperations? (?:and )?supply ?chain\b', r'\bhospitality\b',
    )),
    ('Engineering', (
        r'\bcomputer engineering\b', r'\bcomp engineering\b', r'\bcmpe\b',
        r'\bmechanical engineer(?:ing)?\b', r'\bmech e\b',
        r'\belectrical engineer(?:ing)?\b', r'\bcivil engineer(?:ing)?\b',
        r'\baerospace engineer(?:ing)?\b', r'\bindustrial engineer(?:ing)?\b',
        r'\bmanufacturing (?:systems?|engineering)\b', r'\betech manufacturing sys\b',
        r'\bbiomedical engineer(?:ing)?\b', r'\bchemical engineer(?:ing)?\b',
        r'\bmaterials? engineer(?:ing)?\b', r'\btechnology engineering\b',
    )),
    ('Computing & Data', (
        r'\bcomputer science\b', r'\bdata science\b', r'\bsoftware engineer(?:ing)?\b',
        r'\bapplied computing\b', r'\bcomputer network system management\b',
        r'\btechnical informatics\b', r'\bstatistics\b',
    )),
    ('Health & Life Sciences', (
        r'\bpublic health\b', r'\bnursing\b', r'\bpre nursing\b',
        r'\bbiology\b', r'\bbiological science', r'\bbiochem(?:istry)?\b',
        r'\bbiotech(?:nology)?\b', r'\bkinesiology\b', r'\bnutrition\b',
        r'\bhealth science\b', r'\bmicrobiology\b', r'\bmolecular biology\b',
        r'\boccupational therapy\b', r'\bzoology\b', r'\bmarine bio',
    )),
    ('Social Sciences', (
        r'\bpsych(?:ology)?\b', r'\bsociology\b', r'\beconomics?\b',
        r'\bpolitical science\b', r'\banthropology\b', r'\bcommunications? studies\b',
        r'\bbehavioral sciences?\b', r'\bsocial work\b', r'\bjustice studies\b',
        r'\bglobal studies\b',
    )),
    ('Arts, Media & Design', (
        r'\bgraphic design\b', r'\bdesign studies\b', r'\binteraction design\b',
        r'\banimation\b', r'\billustration\b', r'\bfilm\b', r'\bmusic\b',
        r'\bjournalism\b', r'\bphotography\b', r'\bdigital media\b',
        r'\bart studio\b', r'\btheatre arts\b',
    )),
    ('Education & Humanities', (
        r'\benglish\b', r'\bhistory\b', r'\bphilosophy\b', r'\beducation\b',
        r'\bliberal studies\b', r'\blinguistics\b', r'\bhumanities\b',
        r'\bteacher preparation\b',
    )),
]

SHEETS = {
    'LITTLES': {
        'aliases': ('littles', 'little', 'little apps', 'little applications'), 'required': True, 'role': 'Little',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('AA', 'S'), 'music': 'AG', 'movies': 'AH', 'perfectDay': 'AJ', 'story': 'BA',
        'instagram': 'BD', 'image': 'BE', 'deck': 'BG', 'family': ('BH', 'U'),
        'socialLevel': ('AU', 'BN'), 'socialStyle': ('AW', 'BP'),
    },
    'BIGS': {
        'aliases': ('bigs', 'big', 'big apps', 'big applications'), 'required': True, 'role': 'Big',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('AE', 'S'), 'music': 'AK', 'movies': 'AL', 'perfectDay': 'AN', 'story': 'BD',
        'instagram': 'BG', 'image': 'BH', 'deck': 'BJ', 'family': ('T',),
        'socialLevel': ('AY',), 'socialStyle': ('BA',),
    },
    'FAMS': {
        'aliases': ('fams', 'fam', 'family', 'families', 'family apps', 'family applications'), 'required': False, 'role': 'Family',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('S', 'AT'), 'music': 'U', 'movies': 'V', 'perfectDay': 'W', 'story': None,
        'instagram': ('AK', 'BW', 'DN'), 'image': ('AL', 'BX', 'DO'),
        'deck': ('BZ', 'DQ'), 'family': ('AN', 'CA'),
        'socialLevel': ('AH', 'BN', 'DF'), 'socialStyle': ('BP', 'DH'),
    },
}

MISSING_VALUES = {
    '', '.', '..', '-', '--', 'n/a', 'na', 'none', 'no', 'nope', 'null',
    'not applicable', 'not available', 'did not submit', "didn't submit",
}
GOOGLE_DOC_HOSTS = {'docs.google.com', 'sheets.google.com', 'slides.google.com'}
DIRECT_IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp')
PUBLIC_EXCLUDED_KEYS = {
    'imageSourceUrl', 'driveFileId', 'driveFolderId', 'storagePath', 'resolvedDriveFileId',
    'imageIssue', 'imageKind', 'sourceGroup', 'sourceRow',
}
EMAIL_RE = re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.I)
PHONE_RE = re.compile(
    r'(?<!\w)(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}(?!\w)'
)
SCIENTIFIC_PHONE_RE = re.compile(r'(?<!\w)\d(?:\.\d{7,12})?[Ee]\+?9(?!\w)', re.I)
SENSITIVE_PARAMETER_RE = re.compile(
    r'(?i)(?:^|[?&#;\s])(?:access_token|refresh_token|id_token|client_secret|'
    r'api_key|apikey|service_role_key|private_key)\s*=\s*[^&#;\s]+'
)
PRIVATE_KEY_RE = re.compile(r'-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----', re.I)
HTTP_URL_RE = re.compile(r'https?://[^\s<>"\']+', re.I)
INSTAGRAM_HANDLE_RE = re.compile(
    r'^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$'
)
INSTAGRAM_URL_RE = re.compile(
    r'(?i)(?<![A-Za-z0-9._])((?:https?://)?(?:www\.)?instagram\.com/[^\s<>"\']+)'
)
INSTAGRAM_AT_HANDLE_RE = re.compile(
    r'(?<![A-Za-z0-9._])@([A-Za-z0-9._]{1,30})(?![A-Za-z0-9._])'
)
INSTAGRAM_LABELED_HANDLE_RE = re.compile(
    r'(?i)\b(?:user(?:name)?|ig|instagram)'
    r'(?:(?:\s+(?:is|handle))?\s*[:=]\s*|\s+(?:is|handle)\s+)'
    r'@?([A-Za-z0-9._]{1,30})(?![A-Za-z0-9._])'
)
INSTAGRAM_ON_PLATFORM_RE = re.compile(
    r'(?i)(?<![A-Za-z0-9._])([A-Za-z0-9._]{1,30})\s+on\s+instagram\b'
)
INSTAGRAM_RESERVED_PATHS = {
    'accounts', 'direct', 'explore', 'p', 'reel', 'reels', 'stories',
}


def cell_value(cell, shared):
    cell_type = cell.attrib.get('t')
    value = cell.find('m:v', NS)
    inline = cell.find('m:is', NS)

    if cell_type == 's' and value is not None and value.text:
        try:
            return shared[int(value.text)]
        except (ValueError, IndexError):
            return value.text

    if cell_type == 'inlineStr' and inline is not None:
        return ''.join((node.text or '') for node in inline.iter(f'{{{MAIN}}}t'))

    return (value.text or '') if value is not None else ''


def _sheet_name_key(value):
    return re.sub(r'[^a-z0-9]+', ' ', (value or '').strip().lower()).strip()


def resolve_worksheet_paths(archive, allow_partial=False):
    """Resolve logical worksheet names through workbook relationships.

    XLSX worksheet filenames are package implementation details and may be
    renumbered independently of the logical sheet names shown in Excel.
    """
    try:
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        relationships = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
    except KeyError as error:
        raise ValueError(f'Workbook is missing required XLSX metadata: {error.args[0]}') from error

    targets = {}
    for relationship in relationships.findall(f'{{{REL_NS}}}Relationship'):
        if relationship.attrib.get('Type') != f'{DOC_REL_NS}/worksheet':
            continue
        target = relationship.attrib.get('Target', '')
        if target.startswith('/'):
            path = target.lstrip('/')
        else:
            path = posixpath.normpath(posixpath.join('xl', target))
        targets[relationship.attrib.get('Id', '')] = path

    resolved = {}
    sheets = workbook.find('m:sheets', NS)
    for sheet in sheets.findall('m:sheet', NS) if sheets is not None else []:
        logical_name = sheet.attrib.get('name', '')
        relationship_id = sheet.attrib.get(f'{{{DOC_REL_NS}}}id', '')
        path = targets.get(relationship_id)
        if path:
            resolved[_sheet_name_key(logical_name)] = path

    # Fall 2026's test export is a single Google Forms sheet. Its Big answers
    # live in the duplicated BY:CY block, so expose that sheet through the
    # existing logical BIGS pipeline without changing older workbook handling.
    form_response_path = next(
        (path for name, path in resolved.items() if name == 'form responses 1'),
        None,
    )
    if form_response_path and form_response_path in archive.namelist():
        return {'BIGS': form_response_path}

    missing = []
    selected = {}
    for logical_key, config in SHEETS.items():
        aliases = {_sheet_name_key(alias) for alias in config['aliases']}
        path = next((resolved[name] for name in aliases if name in resolved), None)
        if not path or path not in archive.namelist():
            if not config.get('required', True):
                continue
            missing.append(logical_key)
        else:
            selected[logical_key] = path
    if missing and not allow_partial:
        detected = sorted(name for name in resolved if name)
        raise ValueError(
            'Workbook is missing required logical worksheet(s): '
            f"{missing}. Detected logical sheets: {detected}"
        )
    if not selected:
        detected = sorted(name for name in resolved if name)
        raise ValueError(f'Workbook has no recognized response worksheets. Detected logical sheets: {detected}')
    return selected


def _header_values(archive, path, shared):
    root = ET.fromstring(archive.read(path))
    header_row = root.find('.//m:sheetData/m:row', NS)
    headers = {}
    for cell in header_row.findall('m:c', NS) if header_row is not None else []:
        match = re.match(r'([A-Z]+)', cell.attrib.get('r', ''))
        if match:
            headers[match.group(1)] = cell_value(cell, shared).lower()
    return headers


def _column_index(column):
    index = 0
    for character in str(column or ''):
        index = index * 26 + ord(character) - 64
    return index - 1


def _matching_header_columns(headers, tokens):
    return sorted(
        (
            column for column, header in headers.items()
            if all(token in str(header).lower() for token in tokens)
        ),
        key=_column_index,
    )


def _fall_2026_passion_columns(headers):
    hobby_starts = _matching_header_columns(headers, ('list your', 'favorite hobbies/activities'))
    passion_columns = _matching_header_columns(headers, ('passionate', 'talk about', 'hours'))
    if len(hobby_starts) < 2:
        raise ValueError(
            'BIGS schema mismatch: Fall 2026 Little and Big passion headers '
            'could not be resolved safely.'
        )
    little_candidates = [
        column for column in passion_columns
        if _column_index(hobby_starts[0]) < _column_index(column) < _column_index(hobby_starts[1])
    ]
    big_candidates = [
        column for column in passion_columns
        if _column_index(column) > _column_index(hobby_starts[1])
    ]
    if len(little_candidates) != 1 or len(big_candidates) != 1:
        raise ValueError(
            'BIGS schema mismatch: Fall 2026 Little and Big passion headers '
            'could not be resolved safely.'
        )
    return {
        'Little': little_candidates[0],
        'Family': little_candidates[0],
        'Big': big_candidates[0],
    }


def select_sheet_configs(archive, shared, worksheet_paths):
    """Choose verified column layouts without changing the Fall defaults."""
    configs = {}
    for sheet_name, base in SHEETS.items():
        if sheet_name not in worksheet_paths:
            continue
        config = dict(base)
        headers = _header_values(archive, worksheet_paths[sheet_name], shared)
        if sheet_name == 'LITTLES' and 'instagram' in headers.get('BC', ''):
            config.update({
                'family': ('S',), 'hobbies': ('Y',), 'music': 'AE', 'movies': 'AF',
                'perfectDay': 'AH', 'story': 'AZ', 'instagram': 'BC', 'image': 'BD',
                'deck': None, 'socialLevel': ('AT',), 'socialStyle': ('AV',),
            })
        elif sheet_name == 'BIGS' and 'personality' in headers.get('CD', ''):
            passion_by_role = _fall_2026_passion_columns(headers)
            config.update({
                'year': 'N', 'school': 'P', 'major': 'Q', 'program': 'R',
                'family': ('AS', 'BN'), 'hobbies': ('S', 'BY'), 'hobbyDetails': ('T', 'BZ'),
                'music': ('U', 'CA'), 'movies': ('V', 'CB'),
                'passionByRole': passion_by_role,
                'tagline': ('X', 'CD'), 'perfectDay': ('Y', 'CE'), 'uniqueThings': ('W', 'CF'),
                'bucketList': ('AB', 'CG'), 'hotTake': ('Z', 'CH'), 'idealHangout': 'AA',
                'instagram': 'K', 'image': ('AQ', 'CX'), 'deck': None,
                'socialLevel': ('AL', 'CS'), 'socialStyle': ('AN', 'CU'), 'story': ('BL', 'CV'),
                'f26': True,
            })
        elif sheet_name == 'BIGS' and 'instagram' in headers.get('DN', ''):
            config.update({
                'family': ('CA', 'AN'), 'hobbies': ('CL', 'AT'), 'music': 'CR',
                'movies': 'CS', 'perfectDay': 'CU', 'story': 'DK', 'instagram': 'DN',
                'image': 'DO', 'deck': 'DQ', 'socialLevel': ('DF', 'AH'),
                'socialStyle': ('DH', 'AV'),
            })
        configs[sheet_name] = config
    return configs


def read_sheet(archive, path, shared):
    root = ET.fromstring(archive.read(path))
    rows = []

    for row in root.findall('.//m:sheetData/m:row', NS)[1:]:
        values = {}
        for cell in row.findall('m:c', NS):
            match = re.match(r'([A-Z]+)', cell.attrib.get('r', ''))
            if match:
                values[match.group(1)] = cell_value(cell, shared).strip()
        rows.append(values)

    return rows


def first(row, columns):
    if not columns:
        return ''
    if isinstance(columns, str):
        columns = (columns,)

    for column in columns:
        value = row.get(column, '').strip()
        if value:
            return value
    return ''


def clean_text(value):
    value = (value or '').replace('\x00', ' ').strip()
    return re.sub(r'\s+', ' ', value)


def normalization_key(value):
    value = unicodedata.normalize('NFKD', clean_text(value))
    value = ''.join(character for character in value if not unicodedata.combining(character))
    value = value.lower().replace('&', ' and ')
    return re.sub(r'[^a-z0-9]+', ' ', value).strip()


PROGRAM_ROLE_MAP = {
    'fam ace little program': 'Little',
    'family ace little program': 'Little',
    'family and ace little program': 'Little',
    'ace little program': 'Little',
    'ace big only program': 'Big',
    'ace big only': 'Big',
    'ace bigs only': 'Big',
    'ace bigs only program': 'Big',
    'family program family only': 'Family',
    'family program only': 'Family',
    'family only program': 'Family',
    'family only': 'Family',
    'fam program only': 'Family',
    'fam only program': 'Family',
    'fam only': 'Family',
}


def normalize_program_role(value):
    """Map known program choices to public roles without substring inference."""
    return PROGRAM_ROLE_MAP.get(normalization_key(value))


def derive_profile_role(program, sheet_role, program_is_authoritative=False):
    """Keep legacy sheet roles, but require a known program choice for Fall 2026."""
    if not program_is_authoritative:
        return sheet_role
    role = normalize_program_role(program)
    if role:
        return role
    raise ValueError(
        'Fall 2026 program choice is missing or unrecognized; role was not inferred: '
        f'{clean_text(program)!r}'
    )


def normalize_year(value):
    normalized = normalization_key(value)
    if not normalized or normalized in {'n a', 'na', 'none', 'year not listed', 'not listed'}:
        return ''
    if re.fullmatch(r'(?:first|1st|1st year|freshman|year 1|1 year|first year)', normalized):
        return 'First year'
    if re.fullmatch(r'(?:second|2nd|2nd year|sophomore|year 2|2 year|second year)', normalized):
        return 'Second year'
    if re.fullmatch(r'(?:third|3rd|3rd year|junior|year 3|3 year|third year)', normalized):
        return 'Third year'
    if re.fullmatch(r'(?:fourth|4th|senior|year 4|4 year|fourth year)', normalized):
        return 'Fourth year+'
    if re.search(r'\b(?:fifth|5th|sixth|6th)\b', normalized):
        return 'Fourth year+'
    if re.search(r'\b(?:grad|graduate|masters?|doctoral|phd)\b', normalized):
        return 'Graduate / Other'
    return 'Graduate / Other'


def normalize_major_group(value):
    normalized = normalization_key(value)
    if not normalized:
        return 'Other / Undeclared'
    if normalized in MAJOR_EXACT_GROUPS:
        return MAJOR_EXACT_GROUPS[normalized]
    for group, patterns in MAJOR_PHRASE_RULES:
        if any(re.search(pattern, normalized) for pattern in patterns):
            return group
    return 'Other / Undeclared'


def parse_social_level(value):
    normalized = clean_text(value)
    if not re.fullmatch(r'[1-5](?:\.0+)?', normalized):
        return None
    return int(float(normalized))


def normalize_social_style(value):
    normalized = normalization_key(value)
    if not normalized:
        return ''
    has_introvert = bool(re.search(r'\bintrovert\w*\b', normalized))
    has_extrovert = bool(re.search(r'\bextrovert\w*\b', normalized))
    has_ambivert = bool(re.search(r'\bambivert\w*\b|\bambi\b', normalized))
    if has_ambivert or (has_introvert and has_extrovert):
        return 'Ambivert'
    if has_introvert:
        return 'Introvert'
    if has_extrovert:
        return 'Extrovert'
    return ''


def first_parsed(row, columns, parser):
    for column in columns or ():
        parsed = parser(row.get(column, ''))
        if parsed not in (None, ''):
            return parsed
    return None if parser is parse_social_level else ''


def redact_pii(value):
    value = clean_text(value)
    value = EMAIL_RE.sub('[email removed]', value)
    value = PHONE_RE.sub('[phone removed]', value)
    value = SCIENTIFIC_PHONE_RE.sub('[phone removed]', value)
    if PRIVATE_KEY_RE.search(value):
        return '[private credential removed]'
    if SENSITIVE_PARAMETER_RE.search(value):
        value = HTTP_URL_RE.sub('[link with embedded credentials removed]', value)
        value = SENSITIVE_PARAMETER_RE.sub('[embedded credential removed]', value)
    return value


def redact_multiline(value):
    """Redact public story answers while retaining author-supplied line breaks."""
    return '\n'.join(redact_pii(line) for line in (value or '').replace('\r\n', '\n').split('\n')).strip()


def valid_instagram_handle(value):
    return bool(INSTAGRAM_HANDLE_RE.fullmatch(value or ''))


def instagram_handle_from_url(value):
    candidate = value.rstrip('.,);]')
    if not re.match(r'^https?://', candidate, flags=re.I):
        candidate = f'https://{candidate}'

    try:
        parsed = urlparse(candidate)
    except ValueError:
        return ''

    host = parsed.netloc.lower().split(':')[0]
    if host not in {'instagram.com', 'www.instagram.com'}:
        return ''

    path_parts = [part for part in parsed.path.split('/') if part]
    if len(path_parts) != 1:
        return ''

    handle = path_parts[0]
    if handle.lower() in INSTAGRAM_RESERVED_PATHS or not valid_instagram_handle(handle):
        return ''
    return handle


def normalize_instagram(value):
    """Return one unambiguous Instagram profile URL or an empty string."""
    text = clean_text(value)
    lower = text.lower()
    if lower in MISSING_VALUES:
        return ''
    if any(phrase in lower for phrase in (
        "don't have instagram", 'do not have instagram', "don't have one",
        'no instagram', 'without instagram',
    )):
        return ''

    candidates = []
    exact_handle = text[1:] if text.startswith('@') else text
    if valid_instagram_handle(exact_handle):
        candidates.append(exact_handle)

    for url in INSTAGRAM_URL_RE.findall(text):
        handle = instagram_handle_from_url(url)
        if handle:
            candidates.append(handle)

    candidates.extend(INSTAGRAM_AT_HANDLE_RE.findall(text))
    candidates.extend(INSTAGRAM_LABELED_HANDLE_RE.findall(text))
    candidates.extend(INSTAGRAM_ON_PLATFORM_RE.findall(text))

    unique = []
    seen = set()
    for candidate in candidates:
        handle = candidate.strip().lstrip('@')
        key = handle.lower()
        if (
            not valid_instagram_handle(handle)
            or key in INSTAGRAM_RESERVED_PATHS
            or key in seen
        ):
            continue
        seen.add(key)
        unique.append(key)

    if len(unique) != 1:
        return ''
    return f'https://www.instagram.com/{unique[0]}/'


def first_instagram(row, columns):
    if isinstance(columns, str):
        columns = (columns,)
    for column in columns or ():
        normalized = normalize_instagram(row.get(column, ''))
        if normalized:
            return normalized
    return ''


def looks_like_name(value):
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z .'-]{0,60}", clean_text(value)))


def is_legacy_big_compact_row(row):
    """Detect an early short-form response whose name starts in column B."""
    current_first = clean_text(row.get('E', ''))
    legacy_first = clean_text(row.get('B', ''))
    legacy_last = clean_text(row.get('C', ''))
    return bool(
        EMAIL_RE.search(current_first)
        and looks_like_name(legacy_first)
        and looks_like_name(legacy_last)
    )


def is_legacy_big_expanded_row(row):
    """Detect an older full-form response whose later answers are shifted left.

    The workbook contains an edited response created before several questions
    were added to the Big application. The name is still in E/F, but profile
    fields such as major, hobbies, story, Instagram, and image use an older
    column layout. A Drive image in BB plus an empty current image cell (BH)
    makes this version distinguishable without relying on a person's name.
    """
    return bool(
        clean_text(row.get('A', '')).lower() == '(edit)'
        and looks_like_name(row.get('E', ''))
        and looks_like_name(row.get('F', ''))
        and EMAIL_RE.fullmatch(clean_text(row.get('B', '')))
        and clean_text(row.get('BB', '')).startswith(('http://', 'https://'))
        and not clean_text(row.get('BH', ''))
    )


def slugify(value):
    value = re.sub(r'[^a-zA-Z0-9]+', '-', value.lower()).strip('-')
    return value or 'profile'


def valid_drive_id(value):
    value = value or ''
    upper = value.upper()
    placeholder_tokens = ('RESTRICTED', 'REDACTED', 'PLACEHOLDER', 'FILE_ID', 'FOLDER_ID')
    return bool(
        re.fullmatch(r'[A-Za-z0-9_-]{10,200}', value)
        and not any(token in upper for token in placeholder_tokens)
    )


def drive_id_from_query(parsed):
    query = parse_qs(parsed.query)
    for key in ('id', 'fileId', 'folderId'):
        candidate = (query.get(key) or [''])[0]
        if valid_drive_id(candidate):
            return candidate
    return ''


def parse_drive_source(value):
    """Return one canonical Drive source without exposing URL parsing downstream."""
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    host = parsed.netloc.lower().split(':')[0]
    if not (host.endswith('drive.google.com') or host.endswith('googleusercontent.com')):
        return None

    path = parsed.path or ''
    query = parse_qs(parsed.query)
    folder_query_id = (query.get('folderId') or [''])[0]
    if folder_query_id:
        return {'type': 'folder', 'id': folder_query_id} if valid_drive_id(folder_query_id) else {'type': 'invalid', 'id': ''}
    folder_match = re.search(r'/(?:folders|folder/d)/([A-Za-z0-9_-]{10,200})', path)
    if folder_match:
        drive_id = folder_match.group(1)
        return {'type': 'folder', 'id': drive_id} if valid_drive_id(drive_id) else {'type': 'invalid', 'id': ''}

    for pattern in (
        r'/file/d/([A-Za-z0-9_-]{10,200})',
        r'/d/([A-Za-z0-9_-]{10,200})(?:[=/]|$)',
    ):
        match = re.search(pattern, path)
        if match:
            drive_id = match.group(1)
            return {'type': 'file', 'id': drive_id} if valid_drive_id(drive_id) else {'type': 'invalid', 'id': ''}

    drive_id = drive_id_from_query(parsed)
    return {'type': 'file', 'id': drive_id} if drive_id else {'type': 'invalid', 'id': ''}


def parse_image_source(raw_value):
    """Classify one spreadsheet image value and build the app-facing URL."""
    raw = clean_text(raw_value)
    lower = raw.lower().strip()
    result = {
        'source': raw,
        'kind': 'missing',
        'drive_id': '',
        'app_url': PLACEHOLDER_IMAGE,
        'issue': 'No image link was submitted.',
    }

    if lower in MISSING_VALUES:
        return result

    if lower.startswith('file://'):
        result.update({
            'kind': 'local-file',
            'issue': 'A local computer file path cannot be loaded by a deployed website.',
        })
        return result

    # Extract a link from comments such as "please use this https://...".
    candidate_url = raw
    if not re.match(r'^https?://', candidate_url, flags=re.I):
        embedded = re.search(r'https?://[^\s<>"\']+', candidate_url, flags=re.I)
        if embedded:
            candidate_url = embedded.group(0).rstrip('.,);]')
        else:
            result.update({
                'kind': 'invalid-value',
                'issue': 'The image field contains text instead of an http(s) image link.',
            })
            return result

    try:
        parsed = urlparse(candidate_url)
    except ValueError:
        result.update({
            'kind': 'invalid-url',
            'issue': 'The submitted image URL could not be parsed.',
        })
        return result

    host = parsed.netloc.lower().split(':')[0]
    path = parsed.path or ''

    drive_source = parse_drive_source(candidate_url)
    if drive_source:
        if drive_source['type'] == 'invalid':
            result.update({
                'kind': 'invalid-drive-link',
                'issue': 'The submitted Drive link contains a placeholder or invalid file ID.',
            })
            return result
        drive_id = drive_source['id']
        is_folder = drive_source['type'] == 'folder'
        result.update({
            'kind': 'drive-folder' if is_folder else 'drive-file',
            'drive_id': drive_id,
            'app_url': f'/api/drive-image?{"folderId" if is_folder else "fileId"}={quote(drive_id)}',
            'issue': '',
        })
        return result

    if host in GOOGLE_DOC_HOSTS or host.endswith('.docs.google.com') or host == 'forms.gle':
        result.update({
            'kind': 'google-document',
            'issue': 'A Google Docs, Sheets, or Slides page was submitted instead of an image file.',
        })
        return result

    # Sharing pages are HTML pages, not direct images.
    if host in {'photos.app.goo.gl', 'photos.google.com'} or host.endswith('.photos.google.com'):
        result.update({
            'kind': 'google-photos-share',
            'issue': 'Download the photo and upload it as one individual Google Drive image file.',
        })
        return result

    if host == 'share.icloud.com':
        result.update({
            'kind': 'icloud-share',
            'issue': 'Download the photo and upload it as one individual Google Drive image file.',
        })
        return result

    social_hosts = {
        'tiktok.com', 'www.tiktok.com', 'instagram.com', 'www.instagram.com',
        'facebook.com', 'www.facebook.com',
    }
    if host in social_hosts:
        result.update({
            'kind': 'social-share',
            'issue': 'A social-media sharing page is not a direct image. Upload the image to Google Drive.',
        })
        return result

    if parsed.scheme in {'http', 'https'} and parsed.netloc:
        if path.lower().endswith(DIRECT_IMAGE_EXTENSIONS):
            result.update({
                'kind': 'direct-image-url',
                'app_url': candidate_url,
                'issue': '',
            })
        else:
            result.update({
                'kind': 'unverified-web-url',
                'issue': 'This sharing page is not an obvious direct image URL; replace it with a Drive image file.',
            })
        return result

    result.update({
        'kind': 'invalid-url',
        'issue': 'The submitted value is not a supported image URL.',
    })
    return result


def normalize_deck(url):
    url = clean_text(url)
    return url if url.startswith(('http://', 'https://')) else ''


def image_candidates(image):
    candidates = [image['app_url']]
    if image['kind'] == 'drive-file' and image['drive_id']:
        candidates.append(
            f"https://drive.google.com/thumbnail?id={quote(image['drive_id'])}&sz=w1600"
        )
    candidates.append(PLACEHOLDER_IMAGE)
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def normalize_interest_key(value=''):
    text = unicodedata.normalize('NFKD', str(value or ''))
    text = ''.join(char for char in text if not unicodedata.combining(char)).lower()
    text = text.replace('&', ' and ')
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', text)).strip()


def normalize_hobby_text(value=''):
    text = re.sub(r'<br\s*/?>', '\n', str(value or ''), flags=re.I)
    return text.replace('\r\n', '\n').replace('\r', '\n').replace('\0', ' ').strip()


def segment_hobbies(text):
    numbered_markers = len(re.findall(r'(?:^|\s)\d+[.)]\s+', text))
    star_markers = len(re.findall(r'(?:^|\s)\*\s+\S', text))
    delimiter = re.compile(
        r'\n+|[•;]+|\s+(?=\d+[.)]\s+)|\s+(?=\*\s+\S)'
        if numbered_markers >= 2 or star_markers >= 2
        else r'\n+|[•;]+|,\s+|\s+(?=\d+[.)]\s+)'
    )
    ranges = []
    start = 0
    before_kind = 'start'
    for match in delimiter.finditer(text):
        value = match.group(0)
        following_text = text[match.end():]
        if '\n' in value:
            after_kind = 'newline'
        elif '•' in value:
            after_kind = 'bullet'
        elif ';' in value:
            after_kind = 'semicolon'
        elif ',' in value:
            after_kind = 'comma'
        elif re.match(r'^\d+[.)]\s+', following_text):
            after_kind = 'numbered'
        elif re.match(r'^\*\s+\S', following_text):
            after_kind = 'bullet'
        else:
            after_kind = 'separator'
        ranges.append((start, match.start(), before_kind, after_kind))
        start = match.end()
        before_kind = after_kind
    ranges.append((start, len(text), before_kind, 'end'))

    segments = []
    for segment_index, (range_start, range_end, before_kind, after_kind) in enumerate(ranges):
        raw = text[range_start:range_end]
        leading_whitespace = len(raw) - len(raw.lstrip())
        trimmed = raw.strip()
        aside = re.match(r'^\((?:in\s+)?no particular order\)\s*', trimmed, re.I)
        aside_length = len(aside.group(0)) if aside else 0
        prefix = re.match(r'^(?:[-–—*]\s+|\d+[.)]\s+)', trimmed[aside_length:])
        prefix_length = aside_length + (len(prefix.group(0)) if prefix else 0)
        after_prefix = trimmed[prefix_length:]
        prefix_whitespace = len(after_prefix) - len(after_prefix.lstrip())
        content = after_prefix.lstrip()
        if not content:
            continue
        content_offset = range_start + leading_whitespace + prefix_length + prefix_whitespace
        segments.append({
            'segmentIndex': segment_index,
            'start': content_offset,
            'end': content_offset + len(content),
            'text': content,
            'beforeKind': before_kind,
            'afterKind': after_kind,
            'prefixKind': (
                'numbered' if prefix and prefix.group(0)[0].isdigit()
                else 'bullet' if prefix else None
            ),
        })
    return segments


def segment_for_position(segments, position):
    for segment in segments:
        if segment['start'] <= position <= segment['end']:
            return segment['segmentIndex']
    return -1


def heading_for_segment(segment, total_segments, list_like):
    strong_structure = bool(segment['prefixKind']) or any(
        kind in {'newline', 'bullet', 'numbered'}
        for kind in (segment['beforeKind'], segment['afterKind'])
    )
    list_separated = list_like and any(
        kind in {'comma', 'semicolon'}
        for kind in (segment['beforeKind'], segment['afterKind'])
    )
    container = re.match(
        r'^(?:hobbies?|interests?|currently|wanna (?:get back into|do|learn))\s*:\s*(.*)$',
        segment['text'],
        re.I,
    )
    if container:
        if not container.group(1).strip():
            return None
        remainder = container.group(1).lstrip()
        nested = dict(segment)
        nested['text'] = remainder
        nested['start'] = (
            segment['start'] + container.start(1)
            + (len(container.group(1)) - len(remainder))
        )
        return heading_for_segment(nested, total_segments, list_like)
    labeled = re.match(r'^([^.!?\n]{2,80}?)[!?]?(?:\s*:\s*|\s+[–—-]\s+)(?=\S)', segment['text'])
    if labeled:
        text = labeled.group(1).strip()
        return {
            'text': text,
            'start': segment['start'],
            'end': segment['start'] + len(text),
            'segmentIndex': segment['segmentIndex'],
            'explicit': True,
            'customEligible': True,
        }
    if (
        len(segment['text']) <= 30
        and not re.search(r'[.!?]', segment['text'])
        and (strong_structure or list_separated or total_segments == 1)
    ):
        return {
            'text': segment['text'],
            'start': segment['start'],
            'end': segment['end'],
            'segmentIndex': segment['segmentIndex'],
            'explicit': strong_structure or list_separated,
            'customEligible': strong_structure or list_separated or total_segments == 1,
        }
    return None


def title_custom_interest(value):
    parts = re.split(r'(\s+|-)', value)
    return ''.join(
        f'{part[0].upper()}{part[1:].lower()}' if part and part[0].isalnum() else part
        for part in parts
    )


def is_safe_custom_interest(value):
    text = value.strip()
    key = normalize_interest_key(text)
    words = [word for word in key.split(' ') if word]
    placeholders = {normalize_interest_key(item) for item in INTEREST_TAXONOMY['placeholders']}
    blocked = {
        normalize_interest_key(item)
        for item in INTEREST_TAXONOMY['blockedCustom']
    }
    prose_pattern = re.compile(
        r'\b(?:i|im|ive|my|we|our|you|love|like|enjoy|play|playing|go|going|make|making|'
        r'watch|watching|listen|listening|have|has|been|because|when|while|with|for|to|'
        r'since|about|ago)\b',
        re.I,
    )
    return (
        2 <= len(text) <= 30
        and len(words) <= 5
        and not (len(words) == 1 and re.fullmatch(r'[a-z]{2}', key))
        and key not in placeholders
        and key not in blocked
        and text[0].isalpha()
        and not re.match(r'^(?:and|or|but)\b', text, re.I)
        and 'program' not in words
        and not prose_pattern.search(key)
        and bool(re.fullmatch(r"[\w\s&/'’+-]+", text, re.UNICODE))
        and not re.search(r'https?://', text, re.I)
        and not re.search(r'\[(?:email|phone|private|embedded).*removed\]', text, re.I)
        and not re.search(r'\d{7,}', text)
    )


def is_negated_interest(text, start):
    prefix = text[max(0, start - 140):start]
    sentence_start = max(
        prefix.rfind('.'), prefix.rfind('!'), prefix.rfind('?'),
        prefix.rfind(';'), prefix.rfind('\n'),
    ) + 1
    normalized = re.sub(r"[^a-z0-9']+", ' ', prefix[sentence_start:].replace('’', "'")).strip()
    return bool(INTEREST_NEGATION_PATTERN.search(normalized))


def is_known_heading(heading):
    key = normalize_interest_key(heading['text'])
    return any(
        key in {
            normalize_interest_key(item)
            for item in [rule['label'], *rule.get('aliases', [])]
        }
        for rule in INTEREST_TAXONOMY['rules']
    )


def interest_tags(hobbies):
    text = normalize_hobby_text(redact_multiline(hobbies))
    normalized_text = normalize_interest_key(text)
    placeholders = {normalize_interest_key(item) for item in INTEREST_TAXONOMY['placeholders']}
    if not normalized_text or normalized_text in placeholders:
        return []

    segments = segment_hobbies(text)
    list_like = (
        len(text) <= 180
        and not re.search(r'[.!?]', text)
        and not re.search(
            r'\b(?:i|im|ive|my|we|our|you|love|like|enjoy|play|playing|go|going|make|making|'
            r'watch|watching|listen|listening|have|has|been|because|when|while|with|for|to|'
            r'since|about|ago)\b',
            normalize_interest_key(text),
            re.I,
        )
    )
    headings = [
        heading
        for segment in segments
        if (heading := heading_for_segment(segment, len(segments), list_like)) is not None
    ]
    protected_explicit_headings = [
        heading for heading in headings
        if (
            heading['explicit']
            and heading['customEligible']
            and not is_known_heading(heading)
            and is_safe_custom_interest(heading['text'])
        )
    ]
    matches_by_label = {}

    for taxonomy_index, rule in enumerate(INTEREST_TAXONOMY['rules']):
        heading_keys = {
            normalize_interest_key(item)
            for item in [rule['label'], *rule.get('aliases', [])]
        }
        matches = []
        for heading in headings:
            if normalize_interest_key(heading['text']) in heading_keys:
                matches.append({
                    'position': heading['start'],
                    'end': heading['end'],
                    'segmentIndex': heading['segmentIndex'],
                    'priority': 0,
                    'inHeading': True,
                })
        for pattern in rule['patterns']:
            for match in re.finditer(pattern, text, flags=re.I):
                position = match.start()
                if is_negated_interest(text, position):
                    continue
                in_heading = any(
                    heading['start'] <= position < heading['end']
                    for heading in headings
                )
                matches.append({
                    'position': position,
                    'end': match.end(),
                    'segmentIndex': segment_for_position(segments, position),
                    'priority': 0 if in_heading else (2 if rule.get('generic') else 1),
                    'inHeading': in_heading,
                })
        if matches:
            matches_by_label[rule['label']] = {
                'rule': rule,
                'taxonomyIndex': taxonomy_index,
                'matches': matches,
            }

    for suppression in INTEREST_TAXONOMY['genericSuppression']:
        generic_match = matches_by_label.get(suppression['generic'])
        if not generic_match:
            continue
        specific_matches = [
            match
            for label in suppression['specifics']
            for match in matches_by_label.get(label, {}).get('matches', [])
        ]

        def is_redundant(generic_evidence):
            for specific_evidence in specific_matches:
                if generic_evidence['segmentIndex'] != specific_evidence['segmentIndex']:
                    continue
                left, right = (
                    (generic_evidence, specific_evidence)
                    if generic_evidence['position'] <= specific_evidence['position']
                    else (specific_evidence, generic_evidence)
                )
                bridge = text[left['end']:right['position']]
                independent = re.search(
                    r'\b(?:and|or|also|plus|along with|as well as)\b', bridge, re.I
                )
                if len(bridge) <= 80 and not independent:
                    return True
            return False

        generic_match['matches'] = [
            match for match in generic_match['matches']
            if not is_redundant(match)
        ]
        if not generic_match['matches']:
            del matches_by_label[suppression['generic']]

    known = []
    for item in matches_by_label.values():
        available_matches = [
            match for match in item['matches']
            if not any(
                heading['start'] <= match['position'] < heading['end']
                for heading in protected_explicit_headings
            )
        ]
        if not available_matches:
            continue
        best = sorted(available_matches, key=lambda match: (match['priority'], match['position']))[0]
        known.append({
            'label': item['rule']['label'],
            'priority': best['priority'],
            'position': best['position'],
            'taxonomyIndex': item['taxonomyIndex'],
        })

    known_keys = {normalize_interest_key(item['label']) for item in known}
    custom = []
    for index, heading in enumerate(headings):
        key = normalize_interest_key(heading['text'])
        known_heading = is_known_heading(heading)
        contains_known_match = any(
            heading['start'] <= match['position'] < heading['end']
            and not any(
                protected_heading['start'] <= match['position'] < protected_heading['end']
                for protected_heading in protected_explicit_headings
            )
            for item in matches_by_label.values()
            for match in item['matches']
        )
        if (
            not heading['customEligible']
            or known_heading
            or contains_known_match
            or key in known_keys
            or not is_safe_custom_interest(heading['text'])
        ):
            continue
        label = title_custom_interest(heading['text'])
        normalized_label = normalize_interest_key(label)
        if normalized_label in known_keys or any(item['key'] == normalized_label for item in custom):
            continue
        custom.append({
            'label': label,
            'key': normalized_label,
            'priority': 0 if heading['explicit'] else 3,
            'position': heading['start'],
            'taxonomyIndex': len(INTEREST_TAXONOMY['rules']) + index,
        })

    candidates = sorted(
        [*known, *custom],
        key=lambda item: (
            item['priority'], item['position'], item['taxonomyIndex'], item['label'].lower(),
        ),
    )
    return [item['label'] for item in candidates[:INTEREST_TAXONOMY['maxInterests']]]


def is_negated_evidence(text, start):
    prefix = text[max(0, start - 140):start]
    sentence_start = max(
        prefix.rfind('.'), prefix.rfind('!'), prefix.rfind('?'),
        prefix.rfind(';'), prefix.rfind('\n'),
    ) + 1
    normalized = re.sub(r"[^a-z0-9']+", ' ', prefix[sentence_start:].replace('’', "'")).strip()
    return bool(NEGATION_PATTERN.search(normalized))


def overlaps_accepted_evidence(start, end, accepted):
    return any(start < span_end and end > span_start for span_start, span_end in accepted)


def score_vibe_evidence(fields=None):
    fields = fields if isinstance(fields, dict) else {}
    results = []
    for vibe_config in VIBE_SCORING['vibes']:
        score = 0
        evidence = []
        for field, field_weight in VIBE_SCORING['fieldWeights'].items():
            text = clean_text(fields.get(field, '')).lower()
            if not text:
                continue
            accepted = []
            seen_phrases = set()
            for level in ('strong', 'weak'):
                strength = VIBE_SCORING['strengths'][level]
                for rule, pattern in vibe_config[level]:
                    for match in re.finditer(pattern, text, flags=re.I):
                        phrase = match.group(0).lower()
                        start, end = match.span()
                        if (
                            phrase in seen_phrases
                            or overlaps_accepted_evidence(start, end, accepted)
                            or is_negated_evidence(text, start)
                        ):
                            continue
                        points = int(field_weight) * int(strength)
                        accepted.append((start, end))
                        seen_phrases.add(phrase)
                        score += points
                        evidence.append({
                            'field': field,
                            'rule': rule,
                            'strength': level,
                            'phrase': phrase,
                            'points': points,
                        })
        if score > 0:
            results.append({'vibe': vibe_config['name'], 'score': score, 'evidence': evidence})
    return sorted(results, key=lambda result: (-result['score'], VIBE_ORDER_INDEX[result['vibe']]))


def infer_vibes(*values):
    if len(values) == 1 and isinstance(values[0], dict):
        fields = values[0]
    else:
        fields = dict(zip(
            ('hobbies', 'music', 'movies', 'perfectDay', 'story'),
            values,
        ))
    return [
        result['vibe']
        for result in score_vibe_evidence(fields)
        if result['score'] >= VIBE_SCORE_THRESHOLD
    ][:MAX_INFERRED_VIBES]


def validate_workbook_schema(archive, shared, worksheet_paths=None, configs=None):
    expected = {
        'LITTLES': {
            'E': 'first', 'F': 'last', 'BD': 'instagram',
            'AU': 'social setting', 'AW': 'introvert',
        },
        'BIGS': {
            'E': 'first', 'F': 'last', 'BG': 'instagram',
            'AY': 'social setting', 'BA': 'introvert',
        },
        'FAMS': {
            'E': 'first', 'F': 'last', 'AK': 'instagram',
            'AH': 'social setting', 'BP': 'introvert',
        },
    }
    worksheet_paths = worksheet_paths or resolve_worksheet_paths(archive)
    configs = configs or select_sheet_configs(archive, shared, worksheet_paths)
    for sheet_name, config in configs.items():
        expected_fields = {
            'E': 'first', 'F': 'last',
            re.match(r'[A-Z]+', config['instagram'][0] if isinstance(config['instagram'], (tuple, list)) else config['instagram']).group(): 'instagram',
            re.match(r'[A-Z]+', config['socialLevel'][0] if isinstance(config['socialLevel'], (tuple, list)) else config['socialLevel']).group(): 'social setting',
            re.match(r'[A-Z]+', config['socialStyle'][0] if isinstance(config['socialStyle'], (tuple, list)) else config['socialStyle']).group(): ('introvert', 'mbti'),
        }
        root = ET.fromstring(archive.read(worksheet_paths[sheet_name]))
        header_row = root.find('.//m:sheetData/m:row', NS)
        headers = {}
        for cell in header_row.findall('m:c', NS) if header_row is not None else []:
            match = re.match(r'([A-Z]+)', cell.attrib.get('r', ''))
            if match:
                headers[match.group(1)] = cell_value(cell, shared).lower()
        for column, token in expected_fields.items():
            tokens = token if isinstance(token, (tuple, list)) else (token,)
            if not any(candidate in headers.get(column, '') for candidate in tokens):
                raise ValueError(
                    f'{sheet_name} schema mismatch: expected {token!r} in column {column} header.'
                )


def build_profiles(xlsx_path, allow_partial=False):
    profiles = []
    image_report = []
    seen = {}

    with zipfile.ZipFile(xlsx_path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            for shared_item in root.findall('m:si', NS):
                shared.append(''.join((node.text or '') for node in shared_item.iter(f'{{{MAIN}}}t')))

        worksheet_paths = resolve_worksheet_paths(archive, allow_partial=allow_partial)
        configs = select_sheet_configs(archive, shared, worksheet_paths)
        validate_workbook_schema(archive, shared, worksheet_paths, configs)

        for sheet_name, config in configs.items():
            for row_number, row in enumerate(read_sheet(archive, worksheet_paths[sheet_name], shared), start=2):
                hobby_details = ''
                passion = ''
                tagline = ''
                unique_things = ''
                bucket_list = ''
                hot_take = ''
                ideal_hangout = ''
                if sheet_name == 'BIGS' and is_legacy_big_compact_row(row):
                    # This response came from an older version of the form. Its
                    # name starts in B/C, while the current E/F cells contain
                    # email and phone values. Map only known-safe legacy fields.
                    first_name = row.get('B', '')
                    last_name = row.get('C', '')
                    year = row.get('J', '')
                    school = row.get('K', '')
                    major = row.get('L', '')
                    program = row.get('G', '')
                    family = row.get('M', '')
                    hobbies = row.get('S', '')
                    story = row.get('P', '')
                    perfect_day = ''
                    music = ''
                    movies = ''
                    instagram = ''
                    raw_image = ''
                    raw_deck = ''
                    social_level = None
                    social_style = ''
                elif sheet_name == 'BIGS' and is_legacy_big_expanded_row(row):
                    # This edited response used an older full-form layout. The
                    # profile-safe fields below were verified against that
                    # version of the form; organizer contact columns are never
                    # copied into the app.
                    first_name = row.get('E', '')
                    last_name = row.get('F', '')
                    year = row.get('M', '')
                    school = row.get('N', '')
                    major = row.get('O', '')
                    program = row.get('J', '')
                    family = row.get('P', '')
                    hobbies = row.get('Z', '')
                    story = row.get('AX', '')
                    perfect_day = row.get('AI', '')
                    music = row.get('AF', '')
                    movies = row.get('AG', '')
                    instagram = normalize_instagram(row.get('BA', ''))
                    raw_image = row.get('BB', '')
                    raw_deck = ''
                    social_level = parse_social_level(row.get('AS', ''))
                    social_style = normalize_social_style(row.get('AU', ''))
                else:
                    first_name = first(row, config['name'][0])
                    last_name = first(row, config['name'][1])
                    year = first(row, config['year'])
                    school = first(row, config['school'])
                    major = first(row, config['major'])
                    program = first(row, config['program'])
                    family = first(row, config['family'])
                    hobbies = first(row, config['hobbies'])
                    hobby_details = first(row, config.get('hobbyDetails'))
                    passion = first(row, config.get('passion'))
                    tagline = first(row, config.get('tagline'))
                    unique_things = first(row, config.get('uniqueThings'))
                    bucket_list = first(row, config.get('bucketList'))
                    hot_take = first(row, config.get('hotTake'))
                    ideal_hangout = first(row, config.get('idealHangout'))
                    story = first(row, config['story']) if config.get('story') else ''
                    perfect_day = first(row, config['perfectDay'])
                    music = first(row, config['music'])
                    movies = first(row, config['movies'])
                    instagram = first_instagram(row, config['instagram'])
                    raw_image = first(row, config['image'])
                    raw_deck = first(row, config['deck'])
                    social_level = first_parsed(row, config['socialLevel'], parse_social_level)
                    social_style = first_parsed(row, config['socialStyle'], normalize_social_style)

                name = redact_pii(f'{first_name} {last_name}')
                if not name or '[email removed]' in name or '[phone removed]' in name:
                    continue

                role = derive_profile_role(program, config['role'], config.get('f26', False))
                if config.get('passionByRole'):
                    passion = first(row, config['passionByRole'].get(role))

                base = slugify(name)
                seen[base] = seen.get(base, 0) + 1
                profile_id = base if seen[base] == 1 else f'{base}-{seen[base]}'

                bio = redact_pii(story or hobbies or perfect_day)
                image = parse_image_source(raw_image)
                interests = interest_tags(hobbies)

                profile = {
                    'id': profile_id,
                    'name': name,
                    'role': role,
                    'major': redact_pii(major) or 'Major not listed',
                    'majorGroup': normalize_major_group(major),
                    'year': redact_pii(year) or 'Year not listed',
                    'normalizedYear': normalize_year(year),
                    'socialLevel': social_level,
                    'socialStyle': social_style,
                    'school': redact_pii(school),
                    'program': redact_pii(program),
                    'family': redact_pii(family),
                    'bio': bio,
                    'interests': interests,
                    'vibes': infer_vibes({
                        'hobbies': hobbies,
                        'hobbyDetails': hobby_details,
                        'passion': passion,
                        'perfectDay': perfect_day,
                        'idealHangout': ideal_hangout,
                        'story': story,
                        'music': music,
                        'movies': movies,
                    }),
                    'hobbies': redact_multiline(hobbies),
                    'hobbyDetails': redact_multiline(hobby_details),
                    'music': redact_multiline(music),
                    'movies': redact_multiline(movies),
                    'perfectDay': redact_pii(perfect_day),
                    'tagline': redact_multiline(tagline),
                    'uniqueThings': redact_multiline(unique_things),
                    'passion': redact_multiline(passion),
                    'idealHangout': redact_multiline(ideal_hangout),
                    'bucketList': redact_multiline(bucket_list),
                    'hotTake': redact_multiline(hot_take),
                    'instagram': instagram,
                    'image': image['app_url'],
                    'imageCandidates': image_candidates(image),
                    'imageKind': image['kind'],
                    'imageIssue': image['issue'],
                    'imageSourceUrl': image['source'],
                    'driveFileId': image['drive_id'] if image['kind'] == 'drive-file' else '',
                    'driveFolderId': image['drive_id'] if image['kind'] == 'drive-folder' else '',
                    'slideDeckUrl': normalize_deck(raw_deck),
                    'sourceGroup': sheet_name,
                    'sourceRow': row_number,
                }
                profiles.append(profile)

                image_report.append({
                    'profile_id': profile_id,
                    'name': name,
                    'role': role,
                    'source_group': sheet_name,
                    'source_row': row_number,
                    'submitted_value': image['source'],
                    'image_kind': image['kind'],
                    'drive_id': image['drive_id'],
                    'app_image_url': image['app_url'],
                    'action_needed': image['issue'],
                })

    return profiles, image_report


def public_profiles(profiles):
    return [
        {key: value for key, value in profile.items() if key not in PUBLIC_EXCLUDED_KEYS}
        for profile in profiles
    ]


def validate_public_profile_privacy(profiles):
    """Reject a normalized payload if a private token/contact value survived redaction."""
    violations = []
    for profile in public_profiles(profiles):
        for key, value in profile.items():
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, str):
                    continue
                if (
                    EMAIL_RE.search(item)
                    or PHONE_RE.search(item)
                    or SCIENTIFIC_PHONE_RE.search(item)
                    or PRIVATE_KEY_RE.search(item)
                    or SENSITIVE_PARAMETER_RE.search(item)
                ):
                    violations.append({'profileId': profile.get('id', ''), 'field': key})
    if violations:
        raise ValueError(
            'Privacy validation blocked this import because sensitive data remained '
            f'in public fields: {violations[:5]}'
        )


def build_dataset_payload(profiles):
    """Build the sanitized staging payload used by the Admin semester importer."""
    validate_public_profile_privacy(profiles)
    health = build_import_health(profiles)
    by_id = {profile['id']: profile for profile in profiles}
    safe_issues = {
        key: [
            {
                'id': profile_id,
                'name': by_id[profile_id]['name'],
                'role': by_id[profile_id]['role'],
            }
            for profile_id in profile_ids
            if profile_id in by_id
        ]
        for key, profile_ids in health['issues'].items()
    }
    public_by_id = {profile['id']: profile for profile in public_profiles(profiles)}
    return {
        'profiles': [
            {
                'public': public_by_id[profile['id']],
                'driveFileId': profile.get('driveFileId', ''),
                'driveFolderId': profile.get('driveFolderId', ''),
                'imageKind': profile.get('imageKind', ''),
                'imageIssue': profile.get('imageIssue', ''),
            }
            for profile in profiles
        ],
        'health': health,
        'safeIssues': safe_issues,
        'criticalErrors': [],
    }


def write_profiles(output_path, profiles):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        'export const profiles = '
        + json.dumps(public_profiles(profiles), ensure_ascii=False, indent=2)
        + ';\n\nexport function getProfile(id) {\n'
        + '  return profiles.find((profile) => profile.id === id);\n}\n',
        encoding='utf-8',
    )


def write_profile_data(output_path, profiles):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(profiles, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_drive_allowlist(output_path, profiles):
    """Write the exact Drive sources the public proxy is allowed to serve."""
    file_ids = sorted({profile['driveFileId'] for profile in profiles if profile['driveFileId']})
    folder_ids = sorted({profile['driveFolderId'] for profile in profiles if profile['driveFolderId']})
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        '// Generated by scripts/import-master-apps.py. Do not edit manually.\n'
        + 'export const allowedDriveFileIds = new Set('
        + json.dumps(file_ids, indent=2)
        + ');\n\nexport const allowedDriveFolderIds = new Set('
        + json.dumps(folder_ids, indent=2)
        + ');\n',
        encoding='utf-8',
    )


def write_image_report(report_path, rows):
    report_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        'profile_id', 'name', 'role', 'source_group', 'source_row', 'submitted_value',
        'image_kind', 'drive_id', 'app_image_url', 'action_needed',
    ]
    with report_path.open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_image_summary(summary_path, profiles):
    image_counts = {}
    for profile in profiles:
        kind = profile['imageKind']
        image_counts[kind] = image_counts.get(kind, 0) + 1

    supported_kinds = {'drive-file', 'drive-folder', 'direct-image-url'}
    summary = {
        'total_profiles': len(profiles),
        'image_kinds': dict(sorted(image_counts.items())),
        'drive_file_links': image_counts.get('drive-file', 0),
        'drive_folder_links': image_counts.get('drive-folder', 0),
        'profiles_with_supported_sources': sum(
            count for kind, count in image_counts.items() if kind in supported_kinds
        ),
        'profiles_needing_link_replacement': sum(
            count for kind, count in image_counts.items() if kind not in supported_kinds
        ),
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return summary


def missing_value(value, placeholders):
    return clean_text(value).lower() in placeholders


def build_import_health(profiles):
    supported_images = {'drive-file', 'drive-folder', 'direct-image-url'}
    image_counts = {}
    role_counts = {'Little': 0, 'Big': 0, 'Family': 0}
    vibe_distribution = {vibe: 0 for vibe in VIBE_ORDER}
    major_group_distribution = {group: 0 for group in MAJOR_GROUP_ORDER}
    social_level_distribution = {str(level): 0 for level in range(1, 6)}
    social_level_distribution['Missing / invalid'] = 0
    social_style_distribution = {
        'Introvert': 0, 'Ambivert': 0, 'Extrovert': 0, 'Missing / unknown': 0,
    }
    issues = {
        'missingInstagram': [], 'missingMajor': [], 'missingYear': [],
        'missingMeaningfulText': [], 'missingOrInvalidImage': [],
        'missingSocialLevel': [], 'missingSocialStyle': [],
        'missingOrUnclassifiedMajorGroup': [],
    }
    for profile in profiles:
        role_counts[profile['role']] = role_counts.get(profile['role'], 0) + 1
        image_counts[profile['imageKind']] = image_counts.get(profile['imageKind'], 0) + 1
        for vibe in profile['vibes']:
            vibe_distribution[vibe] += 1
        major_group = profile.get('majorGroup', 'Other / Undeclared')
        major_group_distribution[major_group] += 1
        social_level = profile.get('socialLevel')
        if social_level in range(1, 6):
            social_level_distribution[str(social_level)] += 1
        else:
            social_level_distribution['Missing / invalid'] += 1
            issues['missingSocialLevel'].append(profile['id'])
        social_style = profile.get('socialStyle', '')
        if social_style in {'Introvert', 'Ambivert', 'Extrovert'}:
            social_style_distribution[social_style] += 1
        else:
            social_style_distribution['Missing / unknown'] += 1
            issues['missingSocialStyle'].append(profile['id'])
        if major_group == 'Other / Undeclared':
            issues['missingOrUnclassifiedMajorGroup'].append(profile['id'])
        if not profile['instagram']:
            issues['missingInstagram'].append(profile['id'])
        if missing_value(profile['major'], {'', 'n/a', 'na', 'none', 'major not listed'}):
            issues['missingMajor'].append(profile['id'])
        if missing_value(profile['year'], {'', 'n/a', 'na', 'none', 'year not listed'}):
            issues['missingYear'].append(profile['id'])
        meaningful = ' '.join(profile.get(field, '') for field in ('bio', 'hobbies', 'music', 'movies', 'perfectDay'))
        if len(clean_text(meaningful)) < 40:
            issues['missingMeaningfulText'].append(profile['id'])
        if profile['imageKind'] not in supported_images:
            issues['missingOrInvalidImage'].append(profile['id'])
    usable_images = sum(image_counts.get(kind, 0) for kind in supported_images)
    return {
        'schemaVersion': 2,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'totalProfiles': len(profiles),
        'roleCounts': role_counts,
        'instagramCount': sum(bool(profile['instagram']) for profile in profiles),
        'slideDeckCount': sum(bool(profile['slideDeckUrl']) for profile in profiles),
        'imageStatus': {
            'usable': usable_images,
            'missingOrInvalid': len(profiles) - usable_images,
            'byKind': dict(sorted(image_counts.items())),
        },
        'missingFieldCounts': {key: len(value) for key, value in issues.items()},
        'vibeDistribution': vibe_distribution,
        'majorGroupDistribution': major_group_distribution,
        'socialLevelDistribution': social_level_distribution,
        'socialStyleDistribution': social_style_distribution,
        'issues': issues,
    }


def write_import_health(report_path, module_path, profiles):
    health = build_import_health(profiles)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(health, indent=2) + '\n', encoding='utf-8')
    module_path.parent.mkdir(parents=True, exist_ok=True)
    module_path.write_text(
        '// Generated by scripts/import-master-apps.py. Do not edit manually.\n'
        + 'export const importHealth = '
        + json.dumps(health, ensure_ascii=False, indent=2)
        + ';\n',
        encoding='utf-8',
    )
    return health


def main():
    if len(sys.argv) < 3:
        print('Usage: import-master-apps.py INPUT.xlsx OUTPUT.js [IMAGE_REPORT.csv] [PROFILE_DATA.json]')
        sys.exit(2)

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    report_path = (
        Path(sys.argv[3])
        if len(sys.argv) >= 4
        else output_path.parent.parent / 'reports' / 'image-import-report.csv'
    )
    data_path = (
        Path(sys.argv[4])
        if len(sys.argv) >= 5
        else output_path.parent.parent / 'data' / 'profiles.json'
    )
    summary_path = report_path.with_name('image-import-summary.json')
    health_path = report_path.with_name('import-health.json')
    health_module_path = output_path.with_name('import-health.js')

    profiles, image_report = build_profiles(input_path)
    write_profiles(output_path, profiles)
    write_profile_data(data_path, profiles)
    allowlist_path = output_path.with_name('drive-image-allowlist.js')
    write_drive_allowlist(allowlist_path, profiles)
    write_image_report(report_path, image_report)
    summary = write_image_summary(summary_path, profiles)
    health = write_import_health(health_path, health_module_path, profiles)

    counts = {key: sum(1 for profile in profiles if profile['sourceGroup'] == key) for key in SHEETS}
    decks = sum(1 for profile in profiles if profile['slideDeckUrl'])

    print(f'Generated {len(profiles)} profiles: {counts}')
    print(f'Image classifications: {summary["image_kinds"]}')
    print(
        f'{summary["profiles_with_supported_sources"]} profiles have supported image sources; '
        f'{summary["profiles_needing_link_replacement"]} need link replacement; '
        f'{decks} have slide links.'
    )
    print(f'Image report: {report_path}')
    print(f'Image summary: {summary_path}')
    print(f'Drive proxy allowlist: {allowlist_path}')
    print(f'Import health: {health_path}')
    print('Vibe distribution: ' + json.dumps(health['vibeDistribution']))
    print('Major group distribution: ' + json.dumps(health['majorGroupDistribution']))
    print('Social level distribution: ' + json.dumps(health['socialLevelDistribution']))
    print('Social style distribution: ' + json.dumps(health['socialStyleDistribution']))
    print(f'Migration data: {data_path}')


if __name__ == '__main__':
    main()
