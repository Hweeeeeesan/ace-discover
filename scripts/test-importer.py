#!/usr/bin/env python3
import importlib.util
import tempfile
import pathlib
import unittest
import zipfile
import xml.etree.ElementTree as ET

MODULE_PATH = pathlib.Path(__file__).with_name('import-master-apps.py')
SPEC = importlib.util.spec_from_file_location('profile_importer', MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class ImageClassificationTests(unittest.TestCase):
    def test_drive_file_link(self):
        result = IMPORTER.parse_image_source(
            'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing'
        )
        self.assertEqual(result['kind'], 'drive-file')
        self.assertEqual(
            result['app_url'],
            '/api/drive-image?fileId=1AbCdEfGhIjKlMnOpQrStUv',
        )

    def test_drive_open_link(self):
        result = IMPORTER.parse_image_source(
            'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUv'
        )
        self.assertEqual(result['kind'], 'drive-file')

    def test_drive_folder_variants(self):
        urls = [
            'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv',
            'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUv',
            'https://drive.google.com/folder/d/1AbCdEfGhIjKlMnOpQrStUv/view',
        ]
        for url in urls:
            with self.subTest(url=url):
                result = IMPORTER.parse_image_source(url)
                self.assertEqual(result['kind'], 'drive-folder')
                self.assertEqual(
                    result['app_url'],
                    '/api/drive-image?folderId=1AbCdEfGhIjKlMnOpQrStUv',
                )

    def test_google_document_is_not_an_image(self):
        result = IMPORTER.parse_image_source(
            'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit'
        )
        self.assertEqual(result['kind'], 'google-document')
        self.assertEqual(result['app_url'], '/profile-placeholder.svg')

    def test_google_photos_share_is_not_loaded_as_image(self):
        result = IMPORTER.parse_image_source('https://photos.app.goo.gl/ExampleShareId')
        self.assertEqual(result['kind'], 'google-photos-share')
        self.assertEqual(result['app_url'], '/profile-placeholder.svg')

    def test_direct_image(self):
        result = IMPORTER.parse_image_source('https://example.com/photo.webp')
        self.assertEqual(result['kind'], 'direct-image-url')
        self.assertEqual(result['app_url'], 'https://example.com/photo.webp')

    def test_embedded_drive_link(self):
        result = IMPORTER.parse_image_source(
            'Here is my photo: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view'
        )
        self.assertEqual(result['kind'], 'drive-file')

    def test_local_file_is_rejected(self):
        result = IMPORTER.parse_image_source('file:///Users/example/Pictures/photo.jpeg')
        self.assertEqual(result['kind'], 'local-file')

    def test_drive_placeholder_id_is_rejected(self):
        result = IMPORTER.parse_image_source(
            'https://drive.google.com/folder/d/RESTRICTED_FOLDER_ID/view'
        )
        self.assertEqual(result['kind'], 'invalid-drive-link')
        self.assertEqual(result['app_url'], '/profile-placeholder.svg')

    def test_plain_text_is_invalid(self):
        result = IMPORTER.parse_image_source('please use my Instagram photo')
        self.assertEqual(result['kind'], 'invalid-value')


class PublicProfileTests(unittest.TestCase):
    @staticmethod
    def _workbook(sheet_definitions):
        workbook_sheets = []
        relationships = []
        files = {}
        for index, (name, path) in enumerate(sheet_definitions, start=1):
            relationship_id = f'rId{index}'
            workbook_sheets.append(
                f'<sheet name="{name}" sheetId="{index}" r:id="{relationship_id}"/>'
            )
            relationships.append(
                f'<Relationship Id="{relationship_id}" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                f'Target="{path.removeprefix("xl/")}"/>'
            )
            files[path] = b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
        files['xl/workbook.xml'] = (
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            + ''.join(workbook_sheets) + '</sheets></workbook>'
        ).encode()
        files['xl/_rels/workbook.xml.rels'] = (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + ''.join(relationships) + '</Relationships>'
        ).encode()
        return files

    def test_resolves_fall_workbook_style_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'fall.xlsx'
            with zipfile.ZipFile(path, 'w') as archive:
                for name, content in self._workbook([
                    ('LITTLES', 'xl/worksheets/sheet1.xml'),
                    ('BIGS', 'xl/worksheets/sheet2.xml'),
                    ('FAMS', 'xl/worksheets/sheet3.xml'),
                ]).items():
                    archive.writestr(name, content)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(
                    IMPORTER.resolve_worksheet_paths(archive),
                    {
                        'LITTLES': 'xl/worksheets/sheet1.xml',
                        'BIGS': 'xl/worksheets/sheet2.xml',
                        'FAMS': 'xl/worksheets/sheet3.xml',
                    },
                )

    def test_resolves_spring_aliases_to_nonstandard_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'spring.xlsx'
            with zipfile.ZipFile(path, 'w') as archive:
                for name, content in self._workbook([
                    ('Family Applications', 'xl/worksheets/sheet7.xml'),
                    ('Little Applications', 'xl/worksheets/sheet4.xml'),
                    ('Big Applications', 'xl/worksheets/sheet9.xml'),
                ]).items():
                    archive.writestr(name, content)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(
                    IMPORTER.resolve_worksheet_paths(archive),
                    {
                        'LITTLES': 'xl/worksheets/sheet4.xml',
                        'BIGS': 'xl/worksheets/sheet9.xml',
                        'FAMS': 'xl/worksheets/sheet7.xml',
                    },
                )

    def test_missing_logical_sheet_reports_detected_names(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'missing.xlsx'
            with zipfile.ZipFile(path, 'w') as archive:
                for name, content in self._workbook([
                    ('LITTLES', 'xl/worksheets/sheet1.xml'),
                ]).items():
                    archive.writestr(name, content)
            with zipfile.ZipFile(path) as archive:
                with self.assertRaisesRegex(ValueError, 'BIGS.*Detected logical sheets'):
                    IMPORTER.resolve_worksheet_paths(archive)

    def test_real_spring_workbook_uses_spring_layout_when_available(self):
        spring = pathlib.Path(__file__).parents[1] / 'Spring 26 Master Apps.xlsx'
        if not spring.exists():
            self.skipTest('Spring 2026 workbook is not present in this checkout')
        with zipfile.ZipFile(spring) as archive:
            paths = IMPORTER.resolve_worksheet_paths(archive)
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared = [
                ''.join(node.text or '' for node in item.iter('{%s}t' % IMPORTER.MAIN))
                for item in root.findall('{%s}si' % IMPORTER.MAIN)
            ]
            configs = IMPORTER.select_sheet_configs(archive, shared, paths)
            self.assertNotIn('FAMS', paths)
            self.assertEqual(configs['LITTLES']['instagram'], 'BC')
            self.assertEqual(configs['LITTLES']['image'], 'BD')
            self.assertEqual(configs['BIGS']['instagram'], 'DN')
            self.assertEqual(configs['BIGS']['image'], 'DO')
            self.assertEqual(configs['BIGS']['deck'], 'DQ')

    def test_invalid_workbook_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'invalid.xlsx'
            path.write_text('not an xlsx', encoding='utf-8')
            with self.assertRaises(Exception):
                IMPORTER.build_profiles(path)

    def test_normalizes_representative_year_values(self):
        cases = {
            '1st year': 'First year', 'first': 'First year', 'Freshman': 'First year',
            'Second': 'Second year', '2nd Year': 'Second year',
            'Third': 'Third year', 'junior': 'Third year',
            'Fourth': 'Fourth year+', '5th year': 'Fourth year+',
            'Grad student': 'Graduate / Other',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.normalize_year(raw), expected)
        self.assertEqual(IMPORTER.normalize_year('Year not listed'), '')

    def test_normalizes_major_groups_with_business_mis_precedence(self):
        cases = {
            'Computer Science': 'Computing & Data',
            'Data Science': 'Computing & Data',
            'Software Engineering': 'Computing & Data',
            'MIS': 'Business',
            'Management Information Systems': 'Business',
            'Business Management Information Systems': 'Business',
            'Mechanical Engineering': 'Engineering',
            'Public Health': 'Health & Life Sciences',
            'Psychology': 'Social Sciences',
            'Graphic Design': 'Arts, Media & Design',
            'English': 'Education & Humanities',
            'Unmapped Interdisciplinary Major': 'Other / Undeclared',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.normalize_major_group(raw), expected)

    def test_parses_social_level_conservatively(self):
        for raw, expected in [('1', 1), ('2.0', 2), (' 5.0 ', 5)]:
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.parse_social_level(raw), expected)
        for raw in ['', '0', '6', '3 out of 5', 'very social']:
            with self.subTest(raw=raw):
                self.assertIsNone(IMPORTER.parse_social_level(raw))

    def test_normalizes_social_style_conservatively(self):
        cases = {
            'introvert': 'Introvert',
            'mostly introverted': 'Introvert',
            'very extroverted': 'Extrovert',
            'ambivert': 'Ambivert',
            'ambivert leaning introvert': 'Ambivert',
            'ambivert leaning extrovert': 'Ambivert',
            'introverted extrovert': 'Ambivert',
            'depends on the situation, both introverted and extroverted': 'Ambivert',
            'depends on the day': '',
            'social sometimes': '',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.normalize_social_style(raw), expected)

    def test_shifted_social_columns_use_first_valid_normalized_value(self):
        little = {'AU': 'an unrelated activity answer', 'BN': '4.0', 'AW': 'N/A', 'BP': 'extrovert'}
        self.assertEqual(IMPORTER.first_parsed(little, ('AU', 'BN'), IMPORTER.parse_social_level), 4)
        self.assertEqual(IMPORTER.first_parsed(little, ('AW', 'BP'), IMPORTER.normalize_social_style), 'Extrovert')

    def test_vibe_inference_is_deterministic_and_ordered(self):
        values = ('I enjoy hiking, Valorant, matcha cafes, and taking photos.',)
        expected = ['Outdoors', 'Gaming', 'Coffee & Cafes', 'Photography']
        self.assertEqual(IMPORTER.infer_vibes(*values), expected)
        self.assertEqual(IMPORTER.infer_vibes(*values), expected)

    def test_vibe_rules_avoid_broad_false_positives(self):
        self.assertEqual(IMPORTER.infer_vibes('I like good vibes and meeting people.'), [])

    def test_import_health_contains_safe_aggregate_issues(self):
        profile = {
            'id': 'example', 'role': 'Little', 'instagram': '', 'major': 'Major not listed',
            'year': 'Year not listed', 'bio': 'short', 'hobbies': '', 'music': '',
            'movies': '', 'perfectDay': '', 'imageKind': 'missing', 'vibes': ['Gaming'],
            'slideDeckUrl': '', 'majorGroup': 'Other / Undeclared',
            'socialLevel': None, 'socialStyle': '',
        }
        health = IMPORTER.build_import_health([profile])
        self.assertEqual(health['totalProfiles'], 1)
        self.assertEqual(health['vibeDistribution']['Gaming'], 1)
        self.assertEqual(health['issues']['missingInstagram'], ['example'])
        self.assertEqual(health['majorGroupDistribution']['Other / Undeclared'], 1)
        self.assertEqual(health['socialLevelDistribution']['Missing / invalid'], 1)
        self.assertEqual(health['socialStyleDistribution']['Missing / unknown'], 1)
        self.assertEqual(health['issues']['missingSocialLevel'], ['example'])
        self.assertNotIn('name', health['issues'])

    def test_normalizes_instagram_handles_and_urls(self):
        expected = 'https://www.instagram.com/example.user_1/'
        values = [
            '@example.user_1',
            'example.user_1',
            'instagram.com/example.user_1',
            'https://instagram.com/example.user_1/',
            'https://www.instagram.com/example.user_1/',
        ]
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(IMPORTER.normalize_instagram(value), expected)

    def test_normalizes_one_unambiguous_instagram_handle_in_explanatory_text(self):
        self.assertEqual(
            IMPORTER.normalize_instagram('Facebook link unavailable; @example_user on Instagram'),
            'https://www.instagram.com/example_user/',
        )

    def test_rejects_invalid_or_ambiguous_instagram_values(self):
        values = [
            '', 'N/A', 'none', "I don't have Instagram.",
            'https://facebook.com/example',
            'https://instagram.com/p/example-post/',
            'bad handle', '.leadingdot', 'trailingdot.', 'two..dots',
            '@first_handle @second_handle',
        ]
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(IMPORTER.normalize_instagram(value), '')

    def test_long_profile_text_is_not_truncated(self):
        value = 'A long profile description. ' * 100
        self.assertEqual(IMPORTER.redact_pii(value), value.strip())

    def test_redacts_email_phone_and_scientific_notation_phone(self):
        value = 'Email jane@example.com or call (408) 555-1212 / 9.164309097E9.'
        redacted = IMPORTER.redact_pii(value)
        self.assertNotIn('jane@example.com', redacted)
        self.assertNotIn('(408) 555-1212', redacted)
        self.assertNotIn('9.164309097E9', redacted)

    def test_redacts_urls_with_embedded_credentials(self):
        value = 'https://example.com/report#access_token=secret&refresh_token=also-secret'
        redacted = IMPORTER.redact_pii(value)
        self.assertEqual(redacted, '[link with embedded credentials removed]')

    def test_redacts_private_keys(self):
        value = '-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----'
        self.assertEqual(IMPORTER.redact_pii(value), '[private credential removed]')

    def test_detects_compact_legacy_big_row(self):
        row = {
            'B': 'Phillip',
            'C': 'Tran',
            'E': 'person@example.com',
            'F': '9.164309097E9',
        }
        self.assertTrue(IMPORTER.is_legacy_big_compact_row(row))

    def test_detects_expanded_legacy_big_row(self):
        row = {
            'A': '(edit)',
            'B': 'person@example.com',
            'E': 'Eileen',
            'F': 'Tran',
            'BB': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view',
            'BH': '',
        }
        self.assertTrue(IMPORTER.is_legacy_big_expanded_row(row))

    def test_organizer_fields_are_removed(self):
        profile = {
            'id': 'example',
            'name': 'Example',
            'storageImagePath': 'spring-2026/example/primary.webp',
            'imageSourceUrl': 'https://private.example',
            'driveFileId': 'private-id',
            'driveFolderId': '',
            'imageIssue': 'internal note',
            'sourceGroup': 'LITTLES',
            'sourceRow': 2,
        }
        public = IMPORTER.public_profiles([profile])[0]
        self.assertEqual(public['name'], 'Example')
        self.assertEqual(public['storageImagePath'], 'spring-2026/example/primary.webp')
        self.assertNotIn('imageSourceUrl', public)
        self.assertNotIn('driveFileId', public)
        self.assertNotIn('imageIssue', public)
        self.assertNotIn('sourceRow', public)

    def test_dataset_payload_contains_only_safe_profile_and_drive_ids(self):
        profile = {
            'id': 'example', 'name': 'Example Person', 'role': 'Little',
            'major': 'MIS', 'majorGroup': 'Business', 'year': 'Second',
            'normalizedYear': 'Second year', 'socialLevel': 3, 'socialStyle': 'Ambivert',
            'school': 'SJSU', 'program': '', 'family': '', 'bio': 'A safe public bio ' * 4,
            'interests': ['Gaming'], 'vibes': ['Gaming'], 'hobbies': 'Gaming',
            'music': '', 'movies': '', 'perfectDay': '', 'instagram': '',
            'image': '/api/drive-image?fileId=1AbCdEfGhIjKlMnOpQrStUv',
            'imageCandidates': ['/api/drive-image?fileId=1AbCdEfGhIjKlMnOpQrStUv'],
            'imageKind': 'drive-file', 'imageIssue': '',
            'imageSourceUrl': 'https://private.example/source',
            'driveFileId': '1AbCdEfGhIjKlMnOpQrStUv', 'driveFolderId': '',
            'slideDeckUrl': '', 'sourceGroup': 'LITTLES', 'sourceRow': 2,
        }
        payload = IMPORTER.build_dataset_payload([profile])
        staged = payload['profiles'][0]
        self.assertEqual(staged['driveFileId'], profile['driveFileId'])
        self.assertEqual(staged['imageKind'], 'drive-file')
        self.assertNotIn('imageSourceUrl', staged['public'])
        self.assertNotIn('sourceRow', staged['public'])
        self.assertEqual(payload['safeIssues']['missingInstagram'][0]['name'], 'Example Person')

    def test_dataset_payload_blocks_surviving_private_values(self):
        profile = {
            'id': 'example', 'name': 'Example', 'role': 'Little',
            'instagram': '', 'major': 'Computer Science', 'majorGroup': 'Computing & Data',
            'year': 'First', 'normalizedYear': 'First year', 'socialLevel': 2,
            'socialStyle': 'Introvert', 'bio': 'Contact leaked@example.com',
            'hobbies': '', 'music': '', 'movies': '', 'perfectDay': '',
            'imageKind': 'missing', 'vibes': [], 'slideDeckUrl': '',
        }
        with self.assertRaisesRegex(ValueError, 'Privacy validation blocked'):
            IMPORTER.build_dataset_payload([profile])


if __name__ == '__main__':
    unittest.main()
