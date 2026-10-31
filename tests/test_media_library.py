import os
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from pathlib import Path

from backend.services.storage_service import StorageService
from backend.services.media_library import MediaLibrary


class MediaLibraryTests(unittest.TestCase):
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
            self.assertTrue(library.delete(123))
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
            library.delete(7)
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
                library.delete(8)
            self.assertEqual(b'external replacement', output.read_bytes())
            self.assertNotIn('prompt', library.list()[0])
            outside = Path(root, 'outside'); outside.mkdir(); (outside / 'untouched.png').write_bytes(b'private')
            link = Path(root, 'exports', 'link')
            try:
                if os.name == 'nt':
                    # Fixed test-owned paths; junction avoids requiring Windows symlink privileges.
                    subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], check=True, capture_output=True)
                else:
                    link.symlink_to(outside, target_is_directory=True)
                self.assertEqual(1, len(library.list()))
                library.delete(8)
                self.assertEqual(b'private', (outside / 'untouched.png').read_bytes())
            finally:
                if link.exists():
                    if os.name == 'nt': os.rmdir(link)
                    else: link.unlink()

if __name__ == '__main__':
    unittest.main()
