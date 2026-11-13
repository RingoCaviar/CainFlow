import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import subprocess
from pathlib import Path

from backend.services.storage_service import StorageService
from backend.services.media_library import MediaLibrary


class MediaLibraryTests(unittest.TestCase):
    def test_new_saves_allocate_distinct_ids_across_clients_and_clock_rollback(self):
        with tempfile.TemporaryDirectory() as root:
            stores = [self.make_store(root) for _ in range(3)]
            for store in stores:
                store.initialize()
            payloads = [f'original-{index}'.encode() for index in range(3)]
            with patch('backend.services.media_library.time.time', return_value=1793680000):
                with ThreadPoolExecutor(max_workers=3) as pool:
                    items = list(pool.map(lambda index: MediaLibrary(stores[index]).save(
                        {'mimeType': 'image/png'}, payloads[index]), range(3)))
            self.assertEqual(3, len({item['id'] for item in items}))
            library = MediaLibrary(self.make_store(root))
            with patch('backend.services.media_library.time.time', return_value=1793679999):
                later = library.save({'mimeType': 'image/png'}, b'after restart')
            self.assertNotIn(later['id'], [item['id'] for item in items])
            for item, payload in zip(items, payloads):
                self.assertLessEqual(item['id'], 2**53 - 1)
                self.assertEqual(payload, library.read(item['id'])[1])
                replay = library.save({'id': item['id'], 'mimeType': 'image/png'}, payload)
                self.assertEqual(item['id'], replay['id'])
                with self.assertRaisesRegex(ValueError, '保存请求已失效'):
                    library.save({'id': item['id'], 'mimeType': 'image/png'}, b'different')

    def test_directory_history_roundtrip_switch_and_physical_delete(self):
        with tempfile.TemporaryDirectory() as root:
            store = StorageService(database_path=os.path.join(root, 'db.sqlite'), assets_dir=os.path.join(root, 'assets'), temp_dir=os.path.join(root, 'tmp'), exports_dir=os.path.join(root, 'exports'))
            library = MediaLibrary(store)
            item = library.save({'id': 123, 'prompt': 'a cat', 'mimeType': 'image/png'}, b'original-image')
            self.assertEqual('a cat', library.get(123)['prompt'])
            self.assertEqual(b'original-image', library.read(123)[1])
            files = list(Path(root, 'exports').rglob('*.png'))
            self.assertEqual(1, len(files))
            external = Path(root, 'exports', 'nested', 'manual.jpg')
            external.parent.mkdir()
            external.write_bytes(b'manual-image')
            self.assertEqual(2, len(library.list()))
            store.set_export_directory(os.path.join(root, 'other'))
            self.assertEqual([], library.list())
            self.assertTrue(files[0].exists())
            store.set_export_directory(os.path.join(root, 'exports'))
            self.assertEqual(2, len(library.list()))
            self.assertTrue(library.delete(123, item['fileVersion']))
            self.assertFalse(files[0].exists())
            self.assertTrue(external.exists())
            self.assertIsNone(library.get(123))

    def make_store(self, root):
        return StorageService(database_path=os.path.join(root, 'db.sqlite'), assets_dir=os.path.join(root, 'assets'), temp_dir=os.path.join(root, 'tmp'), exports_dir=os.path.join(root, 'exports'))

    def test_upgrade_resumes_failed_write_without_overwrite_or_resurrection(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.make_store(root)
            store.put_asset('legacy', b'video-original', 'video/mp4', 'history')
            store.save_history({'id': 7, 'videoAssetKey': 'legacy', 'mediaType': 'video', 'prompt': 'old movie'})
            library = MediaLibrary(store)
            collision = Path(root, 'exports', 'CainFlow-7.mp4')
            collision.write_bytes(b'user-file')
            with patch('backend.services.media_library.tempfile.mkstemp', side_effect=OSError('disk full')):
                self.assertEqual(1, len(library.migrate_legacy()))
            self.assertEqual(b'video-original', store.get_asset('legacy')[1])
            self.assertEqual(0, store.trim_history(max_entries=0))
            self.assertEqual([], MediaLibrary(store).migrate_legacy())
            item = library.get(7)
            self.assertEqual('old movie', item['prompt'])
            self.assertNotEqual(collision.name, item['relativePath'])
            self.assertEqual(b'user-file', collision.read_bytes())
            self.assertEqual(b'video-original', library.read(7)[1])
            self.assertEqual([], MediaLibrary(store).migrate_legacy())
            self.assertEqual(2, len(library.list()))
            library.delete(7, item['fileVersion'])
            self.assertEqual([], MediaLibrary(store).migrate_legacy())
            self.assertEqual(1, len(library.list()))

    def test_directory_links_are_excluded_and_replaced_files_cannot_be_deleted_stale(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.make_store(root)
            library = MediaLibrary(store)
            item = library.save({'id': 8, 'mimeType': 'image/png'}, b'generated')
            output = Path(item['directory'], item['relativePath'])
            output.write_bytes(b'external replacement')
            with self.assertRaisesRegex(ValueError, '文件已变化'):
                library.delete(8, item['fileVersion'])
            self.assertEqual(b'external replacement', output.read_bytes())
            self.assertNotIn('prompt', library.list()[0])
            item = library.get(8)
            outside = Path(root, 'outside'); outside.mkdir(); (outside / 'untouched.png').write_bytes(b'private')
            link = Path(root, 'exports', 'link')
            try:
                if os.name == 'nt':
                    # Fixed test-owned paths; junction avoids requiring Windows symlink privileges.
                    subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], check=True, capture_output=True)
                else:
                    link.symlink_to(outside, target_is_directory=True)
                self.assertEqual(1, len(library.list()))
                library.delete(8, item['fileVersion'])
                self.assertEqual(b'private', (outside / 'untouched.png').read_bytes())
            finally:
                if link.exists():
                    if os.name == 'nt': os.rmdir(link)
                    else: link.unlink()

    def test_stale_file_version_rejected_even_after_another_scan(self):
        with tempfile.TemporaryDirectory() as root:
            library = MediaLibrary(self.make_store(root))
            old = library.save({'id': 9, 'mimeType': 'image/png'}, b'old')
            path = Path(old['directory'], old['relativePath'])
            path.write_bytes(b'new replacement')
            current = library.list()[0]
            with self.assertRaisesRegex(ValueError, '文件已变化'):
                library.delete(9, old['fileVersion'])
            with self.assertRaisesRegex(ValueError, '文件已变化'):
                library.update_thumbnail(9, 'data:image/png;base64,b2xk', old['fileVersion'])
            self.assertEqual(b'new replacement', path.read_bytes())
            self.assertFalse(library.get(9)['thumb'])
            self.assertTrue(library.delete(9, current['fileVersion']))

    def test_versioned_original_read_rejects_a_replaced_file_before_and_after_scan(self):
        with tempfile.TemporaryDirectory() as root:
            library = MediaLibrary(self.make_store(root))
            item = library.save({'mimeType': 'image/png'}, b'old reference')
            path = Path(item['directory'], item['relativePath'])
            self.assertEqual(b'old reference', library.read(item['id'], item['fileVersion'])[1])
            path.write_bytes(b'new reference image')
            with self.assertRaisesRegex(ValueError, '文件已变化'):
                library.read(item['id'], item['fileVersion'])
            current = library.list()[0]
            with self.assertRaisesRegex(ValueError, '文件已变化'):
                library.read(item['id'], item['fileVersion'])
            self.assertEqual(b'new reference image', library.read(item['id'], current['fileVersion'])[1])

    def test_thumbnail_urls_preserve_search_metadata_and_serve_only_the_selected_file_version(self):
        with tempfile.TemporaryDirectory() as root:
            library = MediaLibrary(self.make_store(root))
            item = library.save({'mimeType': 'image/png', 'prompt': 'blue studio'}, b'original')
            version = item['fileVersion']
            thumbnail = 'data:image/webp;base64,dGh1bWJuYWls'
            library.update_thumbnail(item['id'], thumbnail, version)
            summary = library.list_page(thumbnail_urls=True)['items'][0]
            self.assertNotIn('thumb', summary)
            self.assertEqual(summary['prompt'], 'blue studio')
            self.assertEqual(summary['thumbUrl'], f"/api/storage/library/{item['id']}/thumbnail?v={version}")
            self.assertEqual(library.read_thumbnail(item['id'], version), ('image/webp', b'thumbnail'))
            self.assertEqual(library.list()[0]['thumb'], thumbnail)

            path = Path(item['directory'], item['relativePath'])
            path.write_bytes(b'changed original')
            self.assertIsNone(library.read_thumbnail(item['id'], version))
            self.assertNotIn('thumbUrl', library.list_page(thumbnail_urls=True)['items'][0])

    def test_archive_directory_cannot_overlap_cache_maintenance_roots(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.make_store(root)
            for directory in (store.assets_dir, store.temp_dir, store.assets_dir + '.quarantine'):
                with self.assertRaisesRegex(Exception, '缓存'):
                    store.set_export_directory(str(Path(directory, 'saved')))
            store.put_document('export_settings', {'directory': str(Path(store.assets_dir, 'legacy-config'))})
            with self.assertRaisesRegex(Exception, '缓存'):
                MediaLibrary(store).save({'id': 1, 'mimeType': 'image/png'}, b'original')

    def test_paged_directory_history_tracks_external_changes_and_switches(self):
        with tempfile.TemporaryDirectory() as root:
            store = self.make_store(root)
            store.initialize()
            folder = Path(root, 'exports')
            for i in range(25):
                (folder / f'{i}.png').write_bytes(b'original')
            library = MediaLibrary(store)
            page = library.list_page(limit=10)
            self.assertEqual(25, page['count'])
            self.assertEqual(10, len(page['items']))
            item = page['items'][0]
            changed = folder / item['relativePath']
            changed.write_bytes(b'changed original')
            (folder / 'new.png').write_bytes(b'new')
            other = next(p for p in folder.iterdir() if p != changed and p.name != 'new.png')
            other.unlink()
            current = library.list_page()
            self.assertEqual(25, current['count'])
            updated = next(i for i in current['items'] if i['id'] == item['id'])
            self.assertNotEqual(item['fileVersion'], updated['fileVersion'])
            self.assertNotIn(other.name, [i['relativePath'] for i in current['items']])
            store.set_export_directory(str(Path(root, 'other')))
            self.assertEqual(0, library.list_page()['count'])
            store.set_export_directory(str(folder))
            self.assertEqual(25, library.list_page()['count'])

if __name__ == '__main__':
    unittest.main()
