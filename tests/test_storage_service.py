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
            self.assertEqual(5, item['thumbSizeBytes'])
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

    def test_actual_media_usage_counts_one_shared_physical_original(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'shared-image', 'image/png', 'workflow-node', 'workflow-a:node-a')
            service.add_media_reference('history', '100', shared['asset_key'])
            service.put_asset('legacy-node-a', b'shared-image', 'image/png', 'node')

            stats = service.get_stats()

            self.assertEqual(len(b'shared-image'), stats['actualMediaBytes'])

    def test_actual_media_usage_includes_a_legacy_image_original(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_asset('legacy-node-a', b'legacy-image', 'image/png', 'node')

            self.assertEqual(len(b'legacy-image'), service.get_stats()['actualMediaBytes'])

    def test_actual_media_usage_includes_a_thumbnail_physical_file(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_asset('thumb:one', b'thumbnail', 'image/png', 'thumbnail')

            self.assertEqual(len(b'thumbnail'), service.get_stats()['actualMediaBytes'])

    def test_media_reference_distribution_counts_unique_originals_per_owner_type(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'shared-image', 'image/png', 'workflow-node', 'wf:preview')
            other = service.put_media_asset(b'other-image', 'image/png', 'workflow-import', 'wf:import')
            service.add_media_reference('history', '1', shared['asset_key'])
            service.add_media_reference('history', '2', shared['asset_key'])

            distribution = service.get_stats()['mediaReferenceDistribution']

            self.assertEqual({'assets': 1, 'bytes': len(b'shared-image')}, distribution['workflow-node'])
            self.assertEqual({'assets': 1, 'bytes': len(b'other-image')}, distribution['workflow-import'])
            self.assertEqual({'assets': 1, 'bytes': len(b'shared-image')}, distribution['history'])

    def test_media_reference_distribution_filters_workflow_node_owners_by_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_media_asset(b'a', 'image/png', 'workflow-node', 'workflow-a:node')
            service.put_media_asset(b'b', 'image/png', 'workflow-node', 'workflow-b:node')

            distribution = service.get_stats('workflow-a')['mediaReferenceDistribution']

            self.assertEqual({'assets': 1, 'bytes': 1}, distribution['workflow-node'])

    def test_media_reference_distribution_filters_workflow_import_owners_by_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_media_asset(b'a', 'image/png', 'workflow-import', 'workflow-a:node')
            service.put_media_asset(b'b', 'image/png', 'workflow-import', 'workflow-b:node')

            distribution = service.get_stats('workflow-a')['mediaReferenceDistribution']

            self.assertEqual({'assets': 1, 'bytes': 1}, distribution['workflow-import'])

    def test_releasing_workflow_media_keeps_history_shared_original(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'shared', 'image/png', 'workflow-import', 'workflow-a:import')
            stale = service.put_media_asset(b'stale', 'image/png', 'workflow-node', 'workflow-a:node')
            service.add_media_reference('history', '1', shared['asset_key'])

            result = service.release_workflow_media_references('workflow-a')

            self.assertEqual(2, result['referencesDeleted'])
            self.assertIsNotNone(service.get_asset_info(shared['asset_key']))
            self.assertIsNone(service.get_asset_info(stale['asset_key']))

    def test_node_orphan_cleanup_removes_stale_node_media_but_keeps_retained_and_history_media(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            stale = service.put_media_asset(b'stale-node-media', 'image/png', 'node', 'stale-node')
            retained = service.put_media_asset(b'retained-node-media', 'image/png', 'node', 'active-node')
            historical = service.put_media_asset(b'historical-media', 'image/png', 'node', 'stale-node')
            service.add_media_reference('history', '1', historical['asset_key'])

            result = service.cleanup_assets('node-orphans', ['active-node'])

            self.assertEqual(1, result['assetsDeleted'])
            self.assertIsNone(service.get_asset_info(stale['asset_key']))
            self.assertIsNotNone(service.get_asset_info(retained['asset_key']))
            self.assertIsNotNone(service.get_asset_info(historical['asset_key']))

    def test_node_orphan_cleanup_preserves_closed_workflow_node_references(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            stale = service.put_media_asset(b'stale-image', 'image/png', 'workflow-node', 'workflow-a:node-a')
            retained = service.put_media_asset(b'retained-image', 'image/png', 'workflow-node', 'workflow-a:node-b')
            service.add_media_reference('history', '1', stale['asset_key'])

            service.cleanup_assets('node-orphans', ['workflow-a:node-b'])

            self.assertIsNotNone(service.get_asset_info(stale['asset_key']))
            service.remove_media_reference('history', '1', stale['asset_key'])
            self.assertIsNotNone(service.get_asset_info(stale['asset_key']))
            service.release_workflow_media_references('workflow-a')
            self.assertIsNone(service.get_asset_info(stale['asset_key']))
            self.assertIsNone(service.get_asset_info(retained['asset_key']))

    def test_shared_media_survives_each_owner_removal_until_the_last_workflow_or_history_owner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'shared-derived-image', 'image/png', 'workflow-node', 'workflow-a:resize')
            service.add_media_reference('workflow-node', 'workflow-b:preview', shared['asset_key'])
            service.add_media_reference('history', '42', shared['asset_key'])

            service.cleanup_assets('node-orphans', ['workflow-b:preview'])
            self.assertIsNotNone(service.get_asset_info(shared['asset_key']))

            service.remove_media_reference('workflow-node', 'workflow-b:preview', shared['asset_key'])
            self.assertIsNotNone(service.get_asset_info(shared['asset_key']))

            service.remove_media_reference('history', '42', shared['asset_key'])
            self.assertIsNotNone(service.get_asset_info(shared['asset_key']))
            service.release_workflow_media_references('workflow-a')
            self.assertIsNone(service.get_asset_info(shared['asset_key']))

    def test_clearing_image_imports_releases_only_workflow_import_references(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'imported-image', 'image/png', 'workflow-import', 'workflow-a:import-a')
            service.add_media_reference('history', '1', shared['asset_key'])

            service.cleanup_assets('image-import')

            self.assertIsNotNone(service.get_asset_info(shared['asset_key']))
            service.remove_media_reference('history', '1', shared['asset_key'])
            self.assertIsNone(service.get_asset_info(shared['asset_key']))

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
