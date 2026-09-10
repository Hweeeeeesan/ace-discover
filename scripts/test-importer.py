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
SHEET_ANALYZER_PATH = pathlib.Path(__file__).with_name('analyze-sheet-values.py')
SHEET_SPEC = importlib.util.spec_from_file_location('sheet_values_analyzer', SHEET_ANALYZER_PATH)
SHEET_ANALYZER = importlib.util.module_from_spec(SHEET_SPEC)
SHEET_SPEC.loader.exec_module(SHEET_ANALYZER)


def logical_sheet_values(workbook, logical_name):
    with zipfile.ZipFile(workbook) as archive:
        root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
        shared = [
            ''.join(node.text or '' for node in item.iter('{%s}t' % IMPORTER.MAIN))
            for item in root.findall('{%s}si' % IMPORTER.MAIN)
        ]
        paths = IMPORTER.resolve_worksheet_paths(archive)
        sheet_root = ET.fromstring(archive.read(paths[logical_name]))
        values = []
        for row in sheet_root.findall('.//m:sheetData/m:row', IMPORTER.NS):
            indexed = {}
            for cell in row.findall('m:c', IMPORTER.NS):
                letters = ''.join(character for character in cell.attrib.get('r', '') if character.isalpha())
                index = 0
                for character in letters:
                    index = index * 26 + ord(character) - 64
                indexed[index - 1] = IMPORTER.cell_value(cell, shared)
            dense = [''] * (max(indexed, default=-1) + 1)
            for index, value in indexed.items():
                dense[index] = value
            values.append(dense)
        return values


def set_cell(row, column, value):
    index = 0
    for character in column:
        index = index * 26 + ord(character) - 64
    index -= 1
    if len(row) <= index:
        row.extend([''] * (index + 1 - len(row)))
    row[index] = value


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
        self.assertEqual(
            IMPORTER.parse_drive_source('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view'),
            {'type': 'file', 'id': '1AbCdEfGhIjKlMnOpQrStUv'},
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
                self.assertEqual(
                    IMPORTER.parse_drive_source(url),
                    {'type': 'folder', 'id': '1AbCdEfGhIjKlMnOpQrStUv'},
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
        self.assertIsNone(IMPORTER.parse_drive_source('https://example.com/file/d/1AbCdEfGhIjKlMnOpQrStUv'))


class PublicProfileTests(unittest.TestCase):
    def test_interest_extraction_is_specific_ordered_and_has_no_role_fallback(self):
        cases = {
            'Gym, dance, volleyball': ['Gym', 'Dance', 'Volleyball'],
            'Photography, hiking, gaming': ['Photography', 'Hiking', 'Gaming'],
            'I love volleyball and basketball': ['Volleyball', 'Basketball'],
            'I like playing board games': ['Board Games'],
            'I enjoy coding': ['Coding'],
            'The codpiece exhibit was unusual': [],
            'Floral design: I make bouquets...': ['Floral Design'],
            'Lion Dance: I perform with a team': ['Lion Dance'],
            'Beach Volleyball: I play every weekend': ['Beach Volleyball'],
            'Exploring new places\nLion Dance\nVolleyball\nGoing to the beach\nGoing to the gym': [
                'Exploring New Places', 'Lion Dance', 'Volleyball',
            ],
            "I don't like pickleball": [],
            'Whenever I have time, traveling is fun': ['Travel'],
            'I listen to Laufey, Beach Bunny, and Good Kid.': [],
            'Floral design, pottery': ['Floral Design', 'Pottery'],
            '1. Content Creation - filming tutorials 2. Doing nails - nail art 3. Going to the gym': [
                'Content Creation', 'Nails', 'Gym',
            ],
            'Volleyball is my favorite sport': ['Volleyball'],
            'Music: I play guitar': ['Guitar'],
            'Music, guitar': ['Music', 'Guitar'],
            'I play guitar and listen to music': ['Guitar', 'Music'],
            'Anime and movies': ['Anime', 'Movies'],
            'Floral design<br>hiking<br>gaming': ['Floral Design', 'Hiking', 'Gaming'],
            'Floral design\nperson@example.com\n408-555-1234': ['Floral Design'],
            '': [],
            'N/A': [],
            'Little': [],
            'FAM/ACE LITTLE Program': [],
        }
        for hobbies, expected in cases.items():
            with self.subTest(hobbies=hobbies):
                self.assertEqual(IMPORTER.interest_tags(hobbies), expected)

    def test_interest_extraction_deduplicates_equivalent_forms_and_caps_at_three(self):
        self.assertEqual(
            IMPORTER.interest_tags('photo, Photography, traveling, travelling, cooking'),
            ['Photography', 'Travel', 'Cooking'],
        )
        self.assertEqual(
            IMPORTER.interest_tags('1. Volleyball\n2. Sports\n3. Basketball'),
            ['Volleyball', 'Sports', 'Basketball'],
            'an independently listed generic interest remains grounded',
        )

    def test_fall_2026_program_choices_map_to_roles_explicitly(self):
        cases = {
            'FAM/ACE LITTLE Program': 'Little',
            'FAMILY + ACE LITTLE PROGRAM': 'Little',
            'ACE BIG ONLY PROGRAM': 'Big',
            'ACE BIGs ONLY': 'Big',
            'FAMILY PROGRAM / FAMILY ONLY': 'Family',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.normalize_program_role(raw), expected)

    def test_fall_2026_program_choice_normalizes_case_and_spacing(self):
        variants = [
            '  fam / ace   little   PROGRAM  ',
            'Family + Ace Little Program',
            'FAMILY+ACE LITTLE PROGRAM',
        ]
        for raw in variants:
            with self.subTest(raw=raw):
                self.assertEqual(IMPORTER.normalize_program_role(raw), 'Little')

    def test_ambiguous_program_choice_does_not_default_to_big(self):
        for raw in ('', 'ACE PROGRAM', 'FAMILY OR ACE', 'Interested in ACE'):
            with self.subTest(raw=raw):
                self.assertIsNone(IMPORTER.normalize_program_role(raw))
                with self.assertRaisesRegex(ValueError, 'role was not inferred'):
                    IMPORTER.derive_profile_role(raw, 'Big', program_is_authoritative=True)

    def test_hazel_tran_representative_fall_2026_row_maps_to_little(self):
        workbook = pathlib.Path(__file__).parents[1] / 'FALL 26 MASTER APPS TEST.xlsx'
        values = logical_sheet_values(workbook, 'BIGS')
        row = values[1]
        for column in ('BY', 'BZ', 'CA', 'CB', 'CD', 'CE', 'CF', 'CG', 'CH', 'CV', 'CX'):
            set_cell(row, column, '')
        little_public_values = {
            'E': 'Hazel',
            'F': 'Tran',
            'R': 'FAM/ACE LITTLE Program',
            'S': 'Baking\nCrocheting\nConcerts\nMovies\nTraveling',
            'T': 'Baking: I make treats for friends.\nCrocheting: I make gifts for people.',
            'U': 'R&B and pop; SZA, Wave to Earth, and Laufey.',
            'V': 'Criminal Minds, One Piece, and Legally Blonde.',
            'W': '1. I make handmade gifts\n2. I collect blind boxes\n3. I love creative nails',
            'X': 'Creative, caring, and always curious.',
            'Y': 'A beach picnic, crafts, and dinner with friends.',
            'Z': 'Cake pops are better than cupcakes.',
            'AA': 'Trying a new cafe and doing crafts together.',
            'AB': 'Visit Japan to explore the food and art.',
            'AH': 'I could talk about crafts and concert memories for hours.',
            'AL': '3',
            'AN': 'Ambivert',
            'AQ': 'https://drive.google.com/file/d/1HazelTranProfileImage2026/view',
            'BL': 'I am a creative person who loves making thoughtful gifts.',
        }
        for column, value in little_public_values.items():
            set_cell(row, column, value)
        private_values = {
            'AE': 'PRIVATE DISLIKED ACTIVITY',
            'AF': 'PRIVATE PET PEEVE',
            'AG': 'PRIVATE NEARBY FRIEND QUALITIES',
            'AI': 'PRIVATE NEARBY LIFE GOALS',
            'AT': 'PRIVATE PAIRING PREFERENCE',
            'BI': 'PRIVATE CURFEW',
            'BJ': 'PRIVATE CONFIDENTIAL RESPONSE',
            'CC': 'PRIVATE BIG BLOCK PASSION',
        }
        for column, value in private_values.items():
            set_cell(row, column, value)
        with tempfile.TemporaryDirectory() as directory:
            adapted = pathlib.Path(directory) / 'hazel-f26.xlsx'
            SHEET_ANALYZER.write_tabular_xlsx(adapted, 'Form Responses 1', values)
            profiles, _ = IMPORTER.build_profiles(adapted)
        profile = profiles[0]
        self.assertEqual(profile['name'], 'Hazel Tran')
        self.assertEqual(profile['program'], 'FAM/ACE LITTLE Program')
        self.assertEqual(profile['role'], 'Little')
        self.assertEqual(profile['hobbies'], little_public_values['S'])
        self.assertEqual(profile['hobbyDetails'], little_public_values['T'])
        self.assertEqual(profile['music'], little_public_values['U'])
        self.assertEqual(profile['movies'], little_public_values['V'])
        self.assertEqual(profile['uniqueThings'], little_public_values['W'])
        self.assertEqual(profile['tagline'], little_public_values['X'])
        self.assertEqual(profile['perfectDay'], little_public_values['Y'])
        self.assertEqual(profile['hotTake'], little_public_values['Z'])
        self.assertEqual(profile['idealHangout'], little_public_values['AA'])
        self.assertEqual(profile['bucketList'], little_public_values['AB'])
        self.assertEqual(profile['passion'], little_public_values['AH'])
        self.assertEqual(profile['bio'], little_public_values['BL'])
        self.assertEqual(profile['interests'], ['Baking', 'Crochet', 'Concerts'])
        self.assertEqual(profile['imageKind'], 'drive-file')
        self.assertEqual(profile['driveFileId'], '1HazelTranProfileImage2026')
        staged = IMPORTER.build_dataset_payload(profiles)['profiles'][0]
        public_data = staged['public']
        for field in (
            'hobbies', 'hobbyDetails', 'music', 'movies', 'uniqueThings', 'tagline',
            'perfectDay', 'hotTake', 'idealHangout', 'bucketList', 'passion', 'bio',
        ):
            self.assertEqual(public_data[field], profile[field])
        self.assertEqual(staged['driveFileId'], '1HazelTranProfileImage2026')
        public_text = repr(public_data)
        for private_value in private_values.values():
            self.assertNotIn(private_value, public_text)

    def test_fall_2026_little_empty_passion_does_not_fall_through_to_big_block(self):
        workbook = pathlib.Path(__file__).parents[1] / 'FALL 26 MASTER APPS TEST.xlsx'
        values = logical_sheet_values(workbook, 'BIGS')
        row = values[1]
        set_cell(row, 'R', 'FAM/ACE LITTLE Program')
        set_cell(row, 'AH', '')
        set_cell(row, 'CC', 'PRIVATE BIG BLOCK PASSION MUST NOT FALL BACK')
        with tempfile.TemporaryDirectory() as directory:
            adapted = pathlib.Path(directory) / 'empty-little-passion-f26.xlsx'
            SHEET_ANALYZER.write_tabular_xlsx(adapted, 'Form Responses 1', values)
            profiles, _ = IMPORTER.build_profiles(adapted)
        profile = profiles[0]
        self.assertEqual(profile['role'], 'Little')
        self.assertEqual(profile['passion'], '')
        self.assertNotIn(
            'PRIVATE BIG BLOCK PASSION MUST NOT FALL BACK',
            repr(IMPORTER.public_profiles(profiles)),
        )

    def test_legacy_sheet_roles_remain_authoritative(self):
        self.assertEqual(IMPORTER.derive_profile_role('', 'Little'), 'Little')
        self.assertEqual(IMPORTER.derive_profile_role('FAM/ACE LITTLE Program', 'Big'), 'Big')
        self.assertEqual(IMPORTER.derive_profile_role('ACE BIG ONLY PROGRAM', 'Family'), 'Family')

    def test_fall_2026_test_response_maps_public_story_fields_only(self):
        workbook = pathlib.Path(__file__).parents[1] / 'FALL 26 MASTER APPS TEST.xlsx'
        profiles, _ = IMPORTER.build_profiles(workbook)
        self.assertEqual(len(profiles), 1)
        profile = profiles[0]
        self.assertEqual(profile['name'], 'Logan Ho')
        self.assertEqual(profile['role'], 'Big')
        self.assertEqual(
            profile['interests'],
            ['Exploring New Places', 'Lion Dance', 'Volleyball'],
        )
        self.assertEqual(profile['tagline'], 'Be the change you want to see.')
        self.assertIn('1. I am both a morning and a night person', profile['uniqueThings'])
        self.assertIn('Psychology', profile['passion'])
        self.assertIn('Exploring new places:', profile['hobbyDetails'])
        self.assertEqual(profile['hotTake'], 'Putting too many toppings on pizza ruins it.')
        self.assertEqual(profile['imageKind'], 'drive-folder')
        self.assertEqual(profile['driveFileId'], '')
        self.assertTrue(IMPORTER.valid_drive_id(profile['driveFolderId']))
        with zipfile.ZipFile(workbook) as archive:
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            shared = [
                ''.join(node.text or '' for node in item.iter('{%s}t' % IMPORTER.MAIN))
                for item in root.findall('{%s}si' % IMPORTER.MAIN)
            ]
            paths = IMPORTER.resolve_worksheet_paths(archive)
            configs = IMPORTER.select_sheet_configs(archive, shared, paths)
            headers = IMPORTER._header_values(archive, paths['BIGS'], shared)
        self.assertEqual(
            configs['BIGS']['passionByRole'],
            {'Little': 'AH', 'Family': 'AH', 'Big': 'CC'},
        )
        self.assertEqual(configs['BIGS']['image'], ('AQ', 'CX'))
        self.assertIn('upload a picture', headers['AQ'])
        self.assertEqual(headers['CX'], 'upload picture(s) of yourself! (max 4)')
        public = IMPORTER.public_profiles(profiles)[0]
        for private_key in ('phone', 'email', 'birthday', 'facebook', 'conflicts', 'curfew'):
            self.assertNotIn(private_key, public)

    def test_google_sheet_rows_match_excel_normalization(self):
        workbook = pathlib.Path(__file__).parents[1] / 'FALL 26 MASTER APPS TEST.xlsx'
        excel_profiles, _ = IMPORTER.build_profiles(workbook)
        values = logical_sheet_values(workbook, 'BIGS')

        with tempfile.TemporaryDirectory() as directory:
            adapted = pathlib.Path(directory) / 'sheet.xlsx'
            SHEET_ANALYZER.write_tabular_xlsx(adapted, 'Form Responses 1', values)
            sheet_profiles, _ = IMPORTER.build_profiles(adapted)
        self.assertEqual(sheet_profiles, excel_profiles)
        self.assertNotIn('email', IMPORTER.public_profiles(sheet_profiles)[0])

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

    def test_sheet_adapter_can_use_one_recognized_logical_tab(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'partial.xlsx'
            with zipfile.ZipFile(path, 'w') as archive:
                for name, content in self._workbook([
                    ('BIGS', 'xl/worksheets/sheet1.xml'),
                ]).items():
                    archive.writestr(name, content)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(
                    IMPORTER.resolve_worksheet_paths(archive, allow_partial=True),
                    {'BIGS': 'xl/worksheets/sheet1.xml'},
                )

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
        expected = ['Outdoors', 'Gaming', 'Photography', 'Coffee & Cafes']
        self.assertEqual(IMPORTER.infer_vibes(*values), expected)
        self.assertEqual(IMPORTER.infer_vibes(*values), expected)

    def test_vibe_rules_avoid_broad_false_positives(self):
        self.assertEqual(IMPORTER.infer_vibes('I like good vibes and meeting people.'), [])

    def test_weighted_vibe_regression_examples(self):
        cases = [
            ({'hobbies': 'I love going to concerts and play guitar.'}, ['Music']),
            ({'music': 'I listen to music while studying.'}, []),
            ({'hobbies': "I don't like parties or clubs."}, []),
            ({'hobbies': 'I hate hiking.'}, []),
            ({'hobbies': "I don't play video games."}, []),
            ({'hobbies': 'I love hiking, camping, and going to the beach.'}, ['Outdoors']),
            ({'hobbies': 'I have a camera and love photography.'}, ['Photography']),
            ({'movies': 'I watch a movie sometimes.'}, []),
            ({'movies': 'I have Letterboxd and watch movies every week.'}, ['Movies & TV']),
            ({'hobbies': 'I love matcha.'}, []),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                self.assertEqual(IMPORTER.infer_vibes(fields), expected)

    def test_vibe_scoring_caps_at_five_and_uses_taxonomy_tie_order(self):
        fields = {
            'hobbies': (
                'cooking baking hiking camping video games valorant concerts guitar '
                'anime manga fashion thrifting photography camera'
            ),
        }
        self.assertEqual(
            IMPORTER.infer_vibes(fields),
            ['Foodie', 'Outdoors', 'Gaming', 'Music', 'Anime'],
        )
        self.assertEqual(
            IMPORTER.infer_vibes({'hobbies': 'hiking gaming'}),
            ['Outdoors', 'Gaming'],
        )

    def test_vibe_scores_are_field_aware_and_deduplicate_repeated_evidence(self):
        hobby_music = next(
            result for result in IMPORTER.score_vibe_evidence({'hobbies': 'concert concert concert'})
            if result['vibe'] == 'Music'
        )
        dedicated_music = next(
            result for result in IMPORTER.score_vibe_evidence({'music': 'concert concert concert'})
            if result['vibe'] == 'Music'
        )
        self.assertEqual(hobby_music['score'], 9)
        self.assertEqual(dedicated_music['score'], 3)
        self.assertEqual(len(hobby_music['evidence']), 1)
        self.assertEqual(IMPORTER.VIBE_SCORE_THRESHOLD, 5)
        self.assertEqual(IMPORTER.MAX_INFERRED_VIBES, 5)
        self.assertEqual(IMPORTER.VIBE_FIELD_WEIGHTS, {
            'hobbies': 3,
            'hobbyDetails': 3,
            'passion': 3,
            'perfectDay': 2,
            'idealHangout': 2,
            'story': 1,
            'music': 1,
            'movies': 1,
        })

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
