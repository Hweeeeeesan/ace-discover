#!/usr/bin/env python3
"""Validate generated public profile data without printing participant content."""

import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / 'data' / 'profiles.json'
PUBLIC_MODULE_PATH = ROOT / 'lib' / 'profiles.js'
ALLOWLIST_PATH = ROOT / 'lib' / 'drive-image-allowlist.js'

PRIVATE_KEYS = {
    'imageSourceUrl', 'driveFileId', 'driveFolderId', 'storagePath',
    'resolvedDriveFileId', 'imageIssue', 'imageKind', 'sourceGroup', 'sourceRow',
}
EMAIL_RE = re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.I)
PHONE_RE = re.compile(r'(?<!\w)(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}(?!\w)')
SCIENTIFIC_PHONE_RE = re.compile(r'(?<!\w)\d(?:\.\d{7,12})?[Ee]\+?9(?!\w)', re.I)
INSTAGRAM_URL_RE = re.compile(
    r'https://www\.instagram\.com/(?!\.)(?![^/]*\.\.)(?![^/]*\./)'
    r'[A-Za-z0-9._]{1,30}/'
)
SENSITIVE_PARAMETER_RE = re.compile(
    r'(?i)(?:^|[?&#;\s])(?:access_token|refresh_token|id_token|client_secret|'
    r'api_key|apikey|service_role_key|private_key)\s*=\s*[^&#;\s]+'
)
PRIVATE_KEY_RE = re.compile(r'-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----', re.I)
PUBLIC_TEXT_FIELDS = {
    'name', 'role', 'major', 'year', 'school', 'program', 'family', 'bio',
    'hobbies', 'music', 'movies', 'perfectDay', 'instagram', 'interests',
}


def drive_ids_from_allowlist(text):
    file_section, folder_section = text.split('export const allowedDriveFolderIds', 1)
    return set(re.findall(r'"([A-Za-z0-9_-]{10,200})"', file_section)), set(
        re.findall(r'"([A-Za-z0-9_-]{10,200})"', folder_section)
    )


def main():
    profiles = json.loads(DATA_PATH.read_text(encoding='utf-8'))
    assert isinstance(profiles, list) and profiles, 'Profile data must be a non-empty JSON array.'

    ids = [profile.get('id') for profile in profiles]
    assert len(ids) == len(set(ids)), 'Profile IDs must be unique.'

    violations = []
    for profile in profiles:
        for field in PUBLIC_TEXT_FIELDS:
            value = profile.get(field, '')
            values = value if isinstance(value, list) else [value]
            for item in values:
                text = str(item or '')
                if EMAIL_RE.search(text) or PHONE_RE.search(text) or SCIENTIFIC_PHONE_RE.search(text):
                    violations.append((profile.get('id'), field))
                if SENSITIVE_PARAMETER_RE.search(text) or PRIVATE_KEY_RE.search(text):
                    violations.append((profile.get('id'), f'{field}:credential'))

        assert profile.get('name'), f"Profile {profile.get('id')} has no name."
        assert profile.get('imageCandidates'), f"Profile {profile.get('id')} has no image fallback list."
        deck = profile.get('slideDeckUrl', '')
        assert not deck or deck.startswith(('http://', 'https://')), 'Invalid slide-deck URL.'
        instagram = profile.get('instagram', '')
        assert not instagram or INSTAGRAM_URL_RE.fullmatch(instagram), 'Invalid Instagram URL.'

    assert not violations, f'Public text contains possible email/phone values: {violations[:5]}'

    module_text = PUBLIC_MODULE_PATH.read_text(encoding='utf-8')
    for key in PRIVATE_KEYS:
        assert f'"{key}"' not in module_text, f'Private key leaked into public module: {key}'

    allowed_files, allowed_folders = drive_ids_from_allowlist(
        ALLOWLIST_PATH.read_text(encoding='utf-8')
    )
    expected_files = {p.get('driveFileId') for p in profiles if p.get('driveFileId')}
    expected_folders = {p.get('driveFolderId') for p in profiles if p.get('driveFolderId')}
    assert allowed_files == expected_files, 'Drive-file allowlist does not match imported profiles.'
    assert allowed_folders == expected_folders, 'Drive-folder allowlist does not match imported profiles.'

    for profile in profiles:
        for source in profile.get('imageCandidates', []):
            if not str(source).startswith('/api/drive-image?'):
                continue
            query = parse_qs(urlparse(source).query)
            file_id = (query.get('fileId') or [''])[0]
            folder_id = (query.get('folderId') or [''])[0]
            assert (file_id in allowed_files) or (folder_id in allowed_folders), (
                f"Profile {profile.get('id')} references an unlisted Drive source."
            )

    deck_count = sum(bool(profile.get('slideDeckUrl')) for profile in profiles)
    print(
        f'Public data validation passed: {len(profiles)} profiles, '
        f'{len(allowed_files)} Drive files, {len(allowed_folders)} Drive folders, '
        f'{deck_count} slide decks.'
    )


if __name__ == '__main__':
    main()
