#!/usr/bin/env python3
"""Import the Fall 2025 application workbook into the profile gallery.

The importer deliberately writes only profile-facing fields to lib/profiles.js.
A separate data/profiles.json file retains image-source metadata for the optional
Google Drive -> Supabase migration script.
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
VIBE_ORDER = [
    'Foodie', 'Outdoors', 'Gaming', 'Music', 'Creative', 'Fitness', 'Sports',
    'Travel', 'Movies & TV', 'Anime', 'Nightlife', 'Coffee & Cafes', 'Studying',
    'Fashion', 'Photography', 'Volunteering',
]
VIBE_RULES = {
    'Foodie': (r'\bfoodie\b', r'\btrying (?:new )?food\b', r'\beating out\b', r'\bcook(?:ing)?\b', r'\bbak(?:e|ing)\b', r'\brestaurant'),
    'Outdoors': (r'\bhik(?:e|ing)\b', r'\bcamp(?:ing)?\b', r'\bnature\b', r'\bbeach\b', r'\btrail\b', r'\bbackpack(?:ing)?\b'),
    'Gaming': (r'\bvideo games?\b', r'\bgaming\b', r'\bvalorant\b', r'\bleague of legends\b', r'\bfortnite\b', r'\broblox\b', r'\btft\b'),
    'Music': (r'\bmusic\b', r'\bconcerts?\b', r'\bsing(?:ing)?\b', r'\bguitar\b', r'\bpiano\b', r'\bdj(?:ing)?\b', r'\braves?\b'),
    'Creative': (r'\bdraw(?:ing)?\b', r'\bpaint(?:ing)?\b', r'\bcraft(?:s|ing)?\b', r'\bcreative writing\b', r'\bscrapbook(?:ing)?\b', r'\bdesign(?:ing)?\b'),
    'Fitness': (r'\bgym\b', r'\bwork(?:ing)? out\b', r'\bweightlift(?:ing)?\b', r'\bfitness\b', r'\bbodybuilding\b', r'\brunning\b'),
    'Sports': (r'\bvolleyball\b', r'\bbasketball\b', r'\bsoccer\b', r'\bbadminton\b', r'\bpickleball\b', r'\bfootball\b', r'\btennis\b', r'\bsports?\b'),
    'Travel': (r'\btravel(?:ing|ling)?\b', r'\broad trips?\b', r'\bexplor(?:e|ing) new (?:cities|places)\b', r'\bvisit(?:ing)? (?:new )?(?:countries|places)\b'),
    'Movies & TV': (r'\bmovies?\b', r'\bfilms?\b', r'\btv shows?\b', r'\bk-?dramas?\b', r'\bsitcoms?\b', r'\bnetflix\b'),
    'Anime': (r'\banime\b', r'\bmanga\b', r'\bmanhwa\b', r'\bjujutsu kaisen\b', r'\bdemon slayer\b'),
    'Nightlife': (r'\bnightlife\b', r'\bclub(?:bing)?\b', r'\bbars?\b', r'\braves?\b', r'\bpart(?:y|ies|ying)\b'),
    'Coffee & Cafes': (r'\bcaf[eé]s?\b', r'\bcafe hopping\b', r'\bcoffee shops?\b', r'\bmatcha\b', r'\bboba\b'),
    'Studying': (r'\bstudy(?:ing)?\b', r'\bstudy sessions?\b', r'\blibrary\b', r'\bacademic(?:s)?\b'),
    'Fashion': (r'\bfashion\b', r'\bthrift(?:ing)?\b', r'\bshopping\b', r'\bstreetwear\b', r'\bclothes?\b', r'\boutfits?\b'),
    'Photography': (r'\bphotograph(?:y|er|ing)?\b', r'\btaking photos?\b', r'\bdigicam\b', r'\bcamera\b'),
    'Volunteering': (r'\bvolunteer(?:ing)?\b', r'\bcommunity service\b', r'\bgiving back\b', r'\bnonprofit\b', r'\bcharity\b'),
}

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


def resolve_worksheet_paths(archive):
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
    if missing:
        detected = sorted(name for name in resolved if name)
        raise ValueError(
            'Workbook is missing required logical worksheet(s): '
            f"{missing}. Detected logical sheets: {detected}"
        )
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

    # Current and legacy Google Drive folder formats.
    folder_match = re.search(
        r'/(?:folders|folder/d)/([A-Za-z0-9_-]{10,200})',
        path,
    )
    if host.endswith('drive.google.com') and folder_match:
        folder_id = folder_match.group(1)
        if not valid_drive_id(folder_id):
            result.update({
                'kind': 'invalid-drive-link',
                'issue': 'The submitted Drive folder link contains a placeholder or invalid file ID.',
            })
            return result
        result.update({
            'kind': 'drive-folder',
            'drive_id': folder_id,
            'app_url': f'/api/drive-image?folderId={quote(folder_id)}',
            'issue': (
                'Folder link detected. Configure Google Drive credentials and share '
                'the folder with the app, or replace it with one image file link.'
            ),
        })
        return result

    # Standard Drive file links plus open?id=, uc?id=, and thumbnail?id=.
    file_patterns = [
        r'/file/d/([A-Za-z0-9_-]{10,200})',
        r'/d/([A-Za-z0-9_-]{10,200})(?:[=/]|$)',
    ]
    file_id = ''
    if host.endswith('drive.google.com') or host.endswith('googleusercontent.com'):
        for pattern in file_patterns:
            match = re.search(pattern, path)
            if match and valid_drive_id(match.group(1)):
                file_id = match.group(1)
                break
        if not file_id:
            file_id = drive_id_from_query(parsed)

    if file_id:
        result.update({
            'kind': 'drive-file',
            'drive_id': file_id,
            'app_url': f'/api/drive-image?fileId={quote(file_id)}',
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


def interest_tags(hobbies, role, program):
    text = redact_pii(hobbies)
    candidates = []
    keyword_map = [
        ('Gym', 'gym'), ('Gaming', 'game'), ('Music', 'music'), ('Concerts', 'concert'),
        ('Dance', 'danc'), ('Cooking', 'cook'), ('Baking', 'bak'), ('Reading', 'read'),
        ('Anime', 'anime'), ('K-pop', 'kpop'), ('Cars', 'car'), ('Hiking', 'hik'),
        ('Sports', 'sport'), ('Basketball', 'basketball'), ('Volleyball', 'volleyball'),
        ('Art', 'draw'), ('Photography', 'photo'), ('Coding', 'cod'), ('Travel', 'travel'),
        ('Cafes', 'cafe'), ('Fashion', 'fashion'), ('Movies', 'movie'), ('Fitness', 'fitness'),
        ('Guitar', 'guitar'), ('Singing', 'sing'),
    ]

    lower = text.lower()
    for label, keyword in keyword_map:
        if keyword in lower and label not in candidates:
            candidates.append(label)
        if len(candidates) >= 3:
            break

    if not candidates:
        parts = re.split(r'[,;•\n]|\s+-\s+', text)
        for part in parts:
            part = clean_text(re.sub(r'^[-–—\d.)\s]+', '', part))
            part = re.split(r'\bbecause\b|\bI like\b|\bI love\b', part, flags=re.I)[0].strip(' .:-')
            if 2 <= len(part) <= 26 and part.lower() not in {'n/a', 'none'}:
                candidates.append(part[:26])
            if len(candidates) >= 3:
                break

    return (candidates or [role])[:3]


def infer_vibes(*values):
    text = clean_text(' '.join(str(value or '') for value in values)).lower()
    return [
        vibe for vibe in VIBE_ORDER
        if any(re.search(pattern, text, flags=re.I) for pattern in VIBE_RULES[vibe])
    ]


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


def build_profiles(xlsx_path):
    profiles = []
    image_report = []
    seen = {}

    with zipfile.ZipFile(xlsx_path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            for shared_item in root.findall('m:si', NS):
                shared.append(''.join((node.text or '') for node in shared_item.iter(f'{{{MAIN}}}t')))

        worksheet_paths = resolve_worksheet_paths(archive)
        configs = select_sheet_configs(archive, shared, worksheet_paths)
        validate_workbook_schema(archive, shared, worksheet_paths, configs)

        for sheet_name, config in configs.items():
            for row_number, row in enumerate(read_sheet(archive, worksheet_paths[sheet_name], shared), start=2):
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

                base = slugify(name)
                seen[base] = seen.get(base, 0) + 1
                profile_id = base if seen[base] == 1 else f'{base}-{seen[base]}'

                bio = redact_pii(story or hobbies or perfect_day or f'{config["role"]} applicant')
                image = parse_image_source(raw_image)

                profile = {
                    'id': profile_id,
                    'name': name,
                    'role': config['role'],
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
                    'interests': interest_tags(hobbies, config['role'], program),
                    'vibes': infer_vibes(hobbies, music, movies, perfect_day, story),
                    'hobbies': redact_pii(hobbies),
                    'music': redact_pii(music),
                    'movies': redact_pii(movies),
                    'perfectDay': redact_pii(perfect_day),
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
                    'role': config['role'],
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
