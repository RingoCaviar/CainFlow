import os
import tempfile
import time
import unittest

from backend.services.storage_service import StorageError, StorageService


class StorageServiceTests(unittest.TestCase):
    def make_service(self, root):
        return StorageService(
            database_path=os.path.join(root, 'data', 'cainflow.db'),
            assets_dir=os.path.join(root, 'data', 'assets'),
            temp_dir=os.path.join(root, 'data', 'temp'),
            exports_dir=os.path.join(root, 'exports'),
        )

    def test_documents_are_atomic_json_records(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_document('session', {'nodes': [{'id': 'n1'}], 'apikey': 'plain-test-key'})
            restored = service.get_document('session')['value']
            self.assertEqual('n1', restored['nodes'][0]['id'])
            self.assertEqual('plain-test-key', restored['apikey'])
            with self.assertRaises(StorageError):
                service.put_document('unknown', {})

    def test_assets_are_content_addressed_and_deduplicated_on_disk(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            first = service.put_asset('node:1', b'same-content', 'image/png', 'node')
            second = service.put_asset('node:2', b'same-content', 'image/png', 'node')
            self.assertEqual(first['sha256'], second['sha256'])
            self.assertEqual(first['relative_path'], second['relative_path'])
            asset_files = [
                os.path.join(path, filename)
                for path, _, filenames in os.walk(service.assets_dir)
                for filename in filenames
            ]
            self.assertEqual(1, len(asset_files))
            service.delete_asset('node:1')
            self.assertTrue(os.path.exists(asset_files[0]))
            service.delete_asset('node:2')
            self.assertFalse(os.path.exists(asset_files[0]))

    def test_history_references_media_and_cleans_it_on_delete(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_asset('history:10', b'image', 'image/png', 'history')
            service.put_asset('thumb:history:10', b'thumb', 'image/webp', 'thumbnail')
            service.save_history({
                'id': 10, 'timestamp': int(time.time() * 1000), 'mediaType': 'image',
                'imageAssetKey': 'history:10', 'thumbAssetKey': 'thumb:history:10', 'prompt': 'test'
            })
            item = service.get_history(10)
            self.assertEqual('test', item['prompt'])
            self.assertIn('/api/storage/assets/', item['thumb'])
            self.assertTrue(service.delete_history(10))
            self.assertIsNone(service.get_asset_info('history:10'))
            self.assertIsNone(service.get_asset_info('thumb:history:10'))

    def test_media_asset_keeps_content_until_its_last_reference_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'shared-video', 'video/mp4', 'node', 'video-1')
            key = asset['asset_key']
            service.add_media_reference('history', '100', key)
            self.assertFalse(service.delete_asset(key))
            service.remove_media_reference('history', '100', key)
            self.assertIsNotNone(service.get_asset_info(key))
            service.remove_media_reference('node', 'video-1', key)
            self.assertIsNone(service.get_asset_info(key))

    def test_media_asset_deduplicates_by_digest_and_enforces_cache_limit(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.set_media_cache_limit(12)
            first = service.put_media_asset(b'same-content', 'video/mp4', 'node', 'one')
            second = service.put_media_asset(b'same-content', 'video/mp4', 'history', 'two')
            self.assertEqual(first['asset_key'], second['asset_key'])
            self.assertEqual(12, service.get_stats()['mediaBytes'])
            with self.assertRaises(StorageError):
                service.put_media_asset(b'new-content', 'video/mp4', 'node', 'three')

    def test_export_directory_requires_absolute_writable_path_and_avoids_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            with self.assertRaises(StorageError):
                service.set_export_directory('relative/path')
            destination = os.path.join(root, 'custom-exports')
            self.assertEqual(destination, service.set_export_directory(destination))
            first = service.export_media('result.png', b'one')
            second = service.export_media('result.png', b'two')
            self.assertNotEqual(first, second)
            with open(first, 'rb') as file:
                self.assertEqual(b'one', file.read())
            with open(second, 'rb') as file:
                self.assertEqual(b'two', file.read())

    def test_factory_reset_preserves_exports(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_document('session', {'nodes': []})
            exported = service.export_media('keep.bin', b'keep')
            service.put_asset('node:1', b'data')
            service.factory_reset()
            self.assertFalse(service.has_user_data())
            self.assertTrue(os.path.exists(exported))

    def test_corrupt_database_is_quarantined(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            os.makedirs(os.path.dirname(service.database_path), exist_ok=True)
            with open(service.database_path, 'wb') as file:
                file.write(b'not-a-sqlite-database')
            service.initialize()
            quarantined = [name for name in os.listdir(os.path.dirname(service.database_path)) if '.corrupt-' in name]
            self.assertEqual(1, len(quarantined))
            self.assertEqual(0, service.get_stats()['documents'])


if __name__ == '__main__':
    unittest.main()
