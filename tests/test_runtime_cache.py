import hashlib
import os
import tempfile
import time
import unittest
from unittest import mock

from backend.services.storage_service import StorageError
from tests import test_storage_service as storage_tests


class RuntimeCacheTests(unittest.TestCase):
    def make_service(self, root, formal=False):
        helper = storage_tests.StorageServiceTests()
        service = helper.make_service(root, verified=False)
        service.initialize()
        if formal:
            backup = service.create_media_migration_backup()
            service.migrate_legacy_media_workflows_page([], service.get_storage_safety_status()['storageEpoch'])
            helper.finish_integrity_scan(service, [])
            service.activate_formal_media_authority(backup['backupId'])
        helper.finish_integrity_scan(service, [])
        return service

    def test_thumbnail_writes_cannot_bypass_cache_quota(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.set_media_cache_limit(3)
            service.put_asset('thumb:1', b'123', 'image/png', 'thumbnail')
            with self.assertRaisesRegex(StorageError, 'cache limit'):
                service.put_asset('thumb:2', b'456', 'image/png', 'thumbnail')

    def test_history_replacement_releases_only_superseded_history_references(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            old = service.put_media_asset(b'old', 'image/png', 'history', '1')
            service.add_media_reference('history', '2', old['asset_key'])
            service.save_history({'id': 1, 'imageAssetKey': old['asset_key']})
            service.save_history({'id': 2, 'imageAssetKey': old['asset_key']})
            new = service.put_media_asset(b'new', 'image/png', 'history', '1')
            service.save_history({'id': 1, 'imageAssetKey': new['asset_key']})
            with service._connect() as db:
                keys = [row[0] for row in db.execute(
                    "SELECT asset_key FROM media_asset_refs WHERE owner_type='history' AND owner_id='1'")]
            self.assertEqual([new['asset_key']], keys)
            self.assertIsNotNone(service.get_asset(old['asset_key']))
            service.delete_history(2)
            self.assertIsNone(service.get_asset(old['asset_key']))

    def test_maintenance_reclaims_repeated_failed_history_writes(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            # A thumbnail upload can succeed before the history POST fails.
            for i in range(3):
                service.put_asset(f'thumb:{i}', bytes([i + 1]), 'image/png', 'thumbnail')
            service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 6 * 60 * 1000)
            self.assertEqual(0, service.get_stats()['assetBytes'])

    def test_approved_quarantine_expires_but_not_before_retention(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            service.set_media_cache_limit(3)
            asset = service.put_media_asset(b'old', 'image/png', 'history', '1')
            service.save_history({'id': 1, 'imageAssetKey': asset['asset_key']})
            service.delete_history(1)
            now = 1800000000000
            service.record_media_gc_candidate_provenance('wf', [asset['asset_key']])
            service.set_meta('media_gc_observation_started_at', now - 8 * 86400000)
            self.assertEqual(1, service.run_media_gc_canary(['wf'], now_ms=now)['quarantined'])
            service.run_cache_maintenance(now_ms=now + 29 * 86400000)
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))
            service.run_cache_maintenance(now_ms=now + 31 * 86400000)
            self.assertIsNone(service.get_asset_info(asset['asset_key']))
            self.assertEqual(0, service.get_stats()['assetBytes'])
            self.assertEqual([], os.listdir(service._media_quarantine_dir))
            self.assertIsNotNone(service.put_media_asset(b'new', 'image/png', 'history', '2'))

    def quarantine(self, service, body=b'old', now=1800000000000):
        asset = service.put_media_asset(body, 'image/png', 'history', '1')
        service.save_history({'id': 1, 'imageAssetKey': asset['asset_key']})
        service.delete_history(1)
        service.record_media_gc_candidate_provenance('wf', [asset['asset_key']])
        service.set_meta('media_gc_observation_started_at', now - 8 * 86400000)
        service.run_media_gc_canary(['wf'], now_ms=now)
        return asset, now + 31 * 86400000

    def test_reestablished_owner_restores_and_protects_quarantined_media(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            asset, expiry = self.quarantine(service)
            service.add_media_reference('history', '2', asset['asset_key'])
            service.save_history({'id': 2, 'imageAssetKey': asset['asset_key']})
            service.run_cache_maintenance(now_ms=expiry)
            self.assertEqual(b'old', service.get_asset(asset['asset_key'])[1])
            self.assertEqual([], os.listdir(service._media_quarantine_dir))

    def test_quarantine_release_is_guarded_and_retries_after_unlink_failure(self):
        for stage in ('gc_release_audited', 'gc_release_unlinked'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root, formal=True)
                asset, expiry = self.quarantine(service)
                def inject(current):
                    if current == stage:
                        raise OSError('injected')
                service._transition_fault_injector = inject
                with self.assertRaises(OSError):
                    service.release_expired_media_quarantine(now_ms=expiry)
                self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])
                self.assertIsNotNone(service.get_asset_info(asset['asset_key']))
                self.assertEqual(0, service.release_expired_media_quarantine(now_ms=expiry)['quarantineReleased'])
                service._transition_fault_injector = lambda _: None
                # Explicit verification after repair, not a blind latch reset.
                storage_tests.StorageServiceTests().finish_integrity_scan(service, [])
                result = service.release_expired_media_quarantine(now_ms=expiry)
                self.assertEqual(1, result['quarantineReleased'])
                self.assertIsNone(service.get_asset_info(asset['asset_key']))
                self.assertEqual([], os.listdir(service._media_quarantine_dir))

    def test_quarantine_content_tampering_never_deletes_the_file(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            asset, expiry = self.quarantine(service)
            path = os.path.join(service._media_quarantine_dir, hashlib.sha256(asset['asset_key'].encode()).hexdigest())
            with open(path, 'wb') as output:
                output.write(b'changed')
            with self.assertRaises(StorageError):
                service.release_expired_media_quarantine(now_ms=expiry)
            self.assertTrue(os.path.isfile(path))
            self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])

    def test_formal_maintenance_does_not_promote_or_delete_unapproved_candidates(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            asset = service.put_asset('media:unknown', b'unknown', 'image/png', 'media')
            service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 60 * 86400000)
            self.assertIsNotNone(service.get_asset(asset['asset_key']))

    def test_thumbnail_replacement_keeps_retired_bytes_in_quota_until_reclaimed(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.set_media_cache_limit(6)
            service.put_asset('thumb:1', b'old', 'image/png', 'thumbnail')
            service.put_asset('thumb:1', b'new', 'image/png', 'thumbnail')
            self.assertEqual(6, service.get_stats()['actualMediaBytes'])
            with self.assertRaises(StorageError):
                service.put_asset('thumb:1', b'xxx', 'image/png', 'thumbnail')
            service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 6 * 60000)
            self.assertEqual(0, service.get_stats()['actualMediaBytes'])

    def test_aliases_and_duplicate_batch_entries_consume_quota_once(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.set_media_cache_limit(3)
            service.put_asset('thumb:1', b'one', 'image/png', 'thumbnail')
            service.put_asset('thumb:alias', b'one', 'image/png', 'thumbnail')
            self.assertEqual(3, service.get_stats()['actualMediaBytes'])
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.set_media_cache_limit(3)
            values = ['data:image/png;base64,b25l'] * 2
            assets = service.put_media_asset_list(values, 'workflow-operation', '["wf","node","op"]')
            self.assertEqual(2, len(assets))
            self.assertEqual(3, service.get_stats()['actualMediaBytes'])

    def test_persisted_safety_latch_blocks_an_already_running_worker(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            asset, expiry = self.quarantine(service)
            another = storage_tests.StorageServiceTests().make_service(root, verified=False)
            another.initialize()
            another._open_gc_circuit_breaker('test_guard')
            self.assertEqual('healthy', service.get_storage_safety_status()['state'])
            self.assertEqual(0, service.release_expired_media_quarantine(now_ms=expiry)['quarantineReleased'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_quarantine_release_respects_batch_limits(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            asset, expiry = self.quarantine(service)
            self.assertEqual(0, service.release_expired_media_quarantine(
                now_ms=expiry, max_count=0)['quarantineReleased'])
            self.assertEqual(0, service.release_expired_media_quarantine(
                now_ms=expiry, max_bytes=2)['quarantineReleased'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))
            self.assertEqual(1, service.release_expired_media_quarantine(
                now_ms=expiry, max_count=1, max_bytes=3)['quarantineReleased'])

    def test_maintenance_only_removes_stale_managed_temporary_files(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            now = int(time.time() * 1000)
            for name in ('asset-old', 'asset-new', 'user-file'):
                path = os.path.join(service.temp_dir, name)
                with open(path, 'wb') as output:
                    output.write(b'temp')
                if name != 'asset-new':
                    os.utime(path, ((now / 1000) - 600,) * 2)
            service.run_cache_maintenance(now_ms=now)
            self.assertEqual(['asset-new', 'user-file'], sorted(os.listdir(service.temp_dir)))

    def test_maintenance_preserves_unknown_files_even_if_they_are_old(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            path = os.path.join(service.assets_dir, 'unknown.bin')
            with open(path, 'wb') as output:
                output.write(b'unknown')
            service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 60 * 86400000)
            self.assertTrue(os.path.isfile(path))

    def test_maintenance_unlink_failure_suspends_collection_and_retains_asset(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('thumb:locked', b'locked', 'image/png', 'thumbnail')
            with mock.patch('backend.services.storage_service.os.remove', side_effect=PermissionError('locked')):
                service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 6 * 60 * 1000)
            safety = service.get_storage_safety_status()
            self.assertEqual('gc_suspended', safety['state'])
            self.assertEqual('media_asset_delete_failed', safety['reason'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_worker_maintains_after_scan_and_remains_interruptible(self):
        from backend import main
        with mock.patch.object(main, 'storage_service') as service, \
                mock.patch.object(main, '_storage_recovery_stop') as stop, \
                mock.patch.object(main.workflow_service, 'list_workflows', return_value={'workflows': []}):
            service.recover_media_owner_transitions.return_value = {'nextCursor': ''}
            service.scan_media_integrity_page.return_value = {'complete': True}
            stop.is_set.return_value = False
            stop.wait.return_value = True
            main._recover_media_transitions()
            service.run_cache_maintenance.assert_called_once_with()
            stop.wait.assert_called_once_with(300)


if __name__ == '__main__':
    unittest.main()
