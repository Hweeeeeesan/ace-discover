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
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
NS = {'m': MAIN}
PLACEHOLDER_IMAGE = '/profile-placeholder.svg'

SHEETS = {
    'LITTLES': {
        'sheet': 'xl/worksheets/sheet1.xml', 'role': 'Little',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('AA', 'S'), 'music': 'AG', 'movies': 'AH', 'perfectDay': 'AJ', 'story': 'BA',
        'instagram': 'BD', 'image': 'BE', 'deck': 'BG', 'family': ('BH', 'U'),
    },
    'BIGS': {
        'sheet': 'xl/worksheets/sheet2.xml', 'role': 'Big',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('AE', 'S'), 'music': 'AK', 'movies': 'AL', 'perfectDay': 'AN', 'story': 'BD',
        'instagram': 'BG', 'image': 'BH', 'deck': 'BJ', 'family': ('T',),
    },
    'FAMS': {
        'sheet': 'xl/worksheets/sheet3.xml', 'role': 'Family',
        'name': ('E', 'F'), 'year': 'M', 'school': 'O', 'major': 'P', 'program': 'R',
        'hobbies': ('S', 'AT'), 'music': 'U', 'movies': 'V', 'perfectDay': 'W', 'story': None,
        'instagram': 'AK', 'image': ('AL', 'BX', 'DO'), 'deck': ('BZ', 'DQ'), 'family': ('AN', 'CA'),
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


def excerpt(value, limit=230):
    value = redact_pii(value)
    if len(value) <= limit:
        return value
    cut = value[:limit].rsplit(' ', 1)[0]
    return cut + '…'


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

        for sheet_name, config in SHEETS.items():
            for row_number, row in enumerate(read_sheet(archive, config['sheet'], shared), start=2):
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
                    instagram = row.get('BA', '')
                    raw_image = row.get('BB', '')
                    raw_deck = ''
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
                    instagram = first(row, config['instagram'])
                    raw_image = first(row, config['image'])
                    raw_deck = first(row, config['deck'])

                name = redact_pii(f'{first_name} {last_name}')
                if not name or '[email removed]' in name or '[phone removed]' in name:
                    continue

                base = slugify(name)
                seen[base] = seen.get(base, 0) + 1
                profile_id = base if seen[base] == 1 else f'{base}-{seen[base]}'

                bio = excerpt(story or hobbies or perfect_day or f'{config["role"]} applicant', 260)
                image = parse_image_source(raw_image)

                profile = {
                    'id': profile_id,
                    'name': name,
                    'role': config['role'],
                    'major': redact_pii(major) or 'Major not listed',
                    'year': redact_pii(year) or 'Year not listed',
                    'school': redact_pii(school),
                    'program': redact_pii(program),
                    'family': redact_pii(family),
                    'bio': bio,
                    'interests': interest_tags(hobbies, config['role'], program),
                    'hobbies': excerpt(hobbies, 700),
                    'music': excerpt(music, 500),
                    'movies': excerpt(movies, 500),
                    'perfectDay': excerpt(perfect_day, 700),
                    'instagram': redact_pii(instagram),
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

    profiles, image_report = build_profiles(input_path)
    write_profiles(output_path, profiles)
    write_profile_data(data_path, profiles)
    allowlist_path = output_path.with_name('drive-image-allowlist.js')
    write_drive_allowlist(allowlist_path, profiles)
    write_image_report(report_path, image_report)
    summary = write_image_summary(summary_path, profiles)

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
    print(f'Migration data: {data_path}')


if __name__ == '__main__':
    main()
