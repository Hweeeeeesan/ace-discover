#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest

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
            'imageSourceUrl': 'https://private.example',
            'driveFileId': 'private-id',
            'driveFolderId': '',
            'imageIssue': 'internal note',
            'sourceGroup': 'LITTLES',
            'sourceRow': 2,
        }
        public = IMPORTER.public_profiles([profile])[0]
        self.assertEqual(public['name'], 'Example')
        self.assertNotIn('imageSourceUrl', public)
        self.assertNotIn('driveFileId', public)
        self.assertNotIn('imageIssue', public)
        self.assertNotIn('sourceRow', public)


if __name__ == '__main__':
    unittest.main()
