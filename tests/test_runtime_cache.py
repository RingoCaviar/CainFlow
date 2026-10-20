import hashlib
import json
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

    def test_maintenance_removes_unregistered_files_regardless_of_name_or_age(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            path = os.path.join(service.assets_dir, 'unknown.bin')
            with open(path, 'wb') as output:
                output.write(b'unknown')
            result = service.run_cache_maintenance(now_ms=int(time.time() * 1000))
            self.assertEqual(1, result['orphanFilesDeleted'])
            self.assertFalse(os.path.exists(path))

    def test_formal_maintenance_also_removes_unregistered_files(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, formal=True)
            path = os.path.join(service.assets_dir, 'legacy-image.png')
            with open(path, 'wb') as output:
                output.write(b'unregistered')

            result = service.run_cache_maintenance()

            self.assertEqual(1, result['orphanFilesDeleted'])
            self.assertFalse(os.path.exists(path))

    def test_maintenance_removes_stale_content_addressed_orphan_and_empty_directories(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            digest = 'a' * 64
            path = os.path.join(service.assets_dir, digest[:2], f'{digest}.png')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as output:
                output.write(b'orphan')
            now = int(time.time() * 1000)
            os.utime(path, ((now - 86400000) / 1000,) * 2)
            result = service.run_cache_maintenance(now_ms=now)
            self.assertEqual(1, result['orphanFilesDeleted'])
            self.assertFalse(os.path.exists(path))
            self.assertFalse(os.path.isdir(os.path.dirname(path)))

    def test_maintenance_unlink_failure_suspends_collection_and_retains_asset(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('thumb:locked', b'locked', 'image/png', 'thumbnail')
            with mock.patch('backend.services.storage_service.os.remove', side_effect=PermissionError('locked')):
                result = service.run_cache_maintenance(now_ms=int(time.time() * 1000) + 6 * 60 * 1000)
            safety = service.get_storage_safety_status()
            self.assertEqual('gc_suspended', safety['state'])
            self.assertEqual('media_asset_delete_failed', safety['reason'])
            self.assertTrue(result['gcSuspended'])
            self.assertEqual(1, result['candidatesRetained'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_manual_asset_cleanup_reports_retained_media_when_reclamation_is_suspended(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('media:stale', b'stale', 'image/png', 'media')
            service._safety_status.update({'state': 'gc_suspended', 'reason': 'test_guard'})
            service._write_safety_status(service._safety_status)

            result = service.cleanup_assets('nodes')

            self.assertTrue(result['gcSuspended'])
            self.assertEqual(1, result['candidatesRetained'])
            self.assertEqual(0, result['assetsDeleted'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_manual_import_cleanup_reports_retained_legacy_image_when_reclamation_is_suspended(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_asset('image-import:old', b'old', 'image/png', 'image-import')
            service._safety_status.update({'state': 'gc_suspended', 'reason': 'test_guard'})
            service._write_safety_status(service._safety_status)

            result = service.cleanup_assets('image-import')

            self.assertTrue(result['gcSuspended'])
            self.assertEqual(1, result['candidatesRetained'])
            self.assertEqual(0, result['assetsDeleted'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_node_cleanup_reclaims_superseded_operation_media_but_keeps_current_and_pending_results(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            obsolete_owner = json.dumps(['wf', 'removed-node', 'old'], separators=(',', ':'))
            current_owner = json.dumps(['wf', 'node', 'current'], separators=(',', ':'))
            now = time.time()
            with mock.patch('backend.services.storage_service.time.time', return_value=now - 600):
                obsolete = service.put_media_asset_list(
                    ['data:image/png;base64,b2Jzb2xldGU='], 'workflow-operation', obsolete_owner)[0]
                current = service.put_media_asset(b'current', 'image/png', 'workflow-operation', current_owner)
            recent_owner = json.dumps(['wf', 'node', 'recent'], separators=(',', ':'))
            with mock.patch('backend.services.storage_service.time.time', return_value=now - 60):
                recent = service.put_media_asset(b'recent', 'image/png', 'workflow-operation', recent_owner)
            epoch = service.get_storage_safety_status()['storageEpoch']
            with mock.patch('backend.services.storage_service.time.time', return_value=now):
                self.assertEqual(1, service.record_media_workflow_revision('wf', 1, epoch, [{
                    'ownerType': 'workflow-node', 'ownerId': 'node',
                    'assetKeys': [current['asset_key']],
                }]))
                committed = service.replace_media_owner_references(
                    workflow_id='wf', owner_type='workflow-node', owner_id='node',
                    operation_id='save-1', idempotency_key='wf:node:save-1',
                    expected_generation=0, document_revision=1, storage_epoch=epoch,
                    asset_keys=[current['asset_key']],
                )
            self.assertEqual('committed', committed['status'])
            pending_owner = json.dumps(['wf', 'node', 'pending'], separators=(',', ':'))
            with mock.patch('backend.services.storage_service.time.time', return_value=now + 60):
                pending = service.put_media_asset(b'pending', 'image/png', 'workflow-operation', pending_owner)

            result = service.cleanup_assets('node-orphans')

            self.assertIsNone(service.get_asset_info(obsolete['asset_key']))
            self.assertEqual(2, result['operationOwnersReleased'])
            self.assertIsNotNone(service.get_asset_info(current['asset_key']))
            self.assertIsNotNone(service.get_asset_info(recent['asset_key']))
            self.assertIsNotNone(service.get_asset_info(pending['asset_key']))
            self.assertEqual(len(b'current') + len(b'recent') + len(b'pending'),
                             service.get_stats()['actualMediaBytes'])
            with mock.patch('backend.services.storage_service.time.time', return_value=now + 120):
                service.record_media_workflow_revision('wf', 1, epoch, [{
                    'ownerType': 'workflow-node', 'ownerId': 'node',
                    'assetKeys': [current['asset_key']],
                }])
            self.assertEqual(0, service.cleanup_assets('node-orphans')['operationOwnersReleased'])
            self.assertIsNotNone(service.get_asset_info(pending['asset_key']))
            with service._connect() as db:
                self.assertEqual(0, db.execute(
                    'SELECT COUNT(*) FROM media_operation_owner_items WHERE owner_id=?',
                    (obsolete_owner,)).fetchone()[0])

    def test_node_cleanup_keeps_operations_until_the_document_owner_commit_finishes(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            owner = json.dumps(['wf', 'node', 'old'], separators=(',', ':'))
            asset = service.put_media_asset(b'old', 'image/png', 'workflow-operation', owner)
            epoch = service.get_storage_safety_status()['storageEpoch']
            with mock.patch('backend.services.storage_service.time.time', return_value=time.time() + 60):
                service.record_media_workflow_revision('wf', 1, epoch, [{
                    'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': [],
                }])

            result = service.cleanup_assets('node-orphans')

            self.assertEqual(0, result['operationOwnersReleased'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_background_maintenance_reclaims_superseded_operation_media(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            owner = json.dumps(['wf', 'removed-node', 'old'], separators=(',', ':'))
            old = service.put_media_asset(b'old', 'image/png', 'workflow-operation', owner)
            epoch = service.get_storage_safety_status()['storageEpoch']
            later = time.time() + 60
            with mock.patch('backend.services.storage_service.time.time', return_value=later):
                service.record_media_workflow_revision('wf', 1, epoch, [])

            result = service.run_cache_maintenance(now_ms=int((later + 6 * 60) * 1000))

            self.assertEqual(1, result['operationOwnersReleased'])
            self.assertEqual(1, result['assetsDeleted'])
            self.assertIsNone(service.get_asset_info(old['asset_key']))

    def test_import_cleanup_does_not_detach_a_formal_workflow_owner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'import', 'image/png', 'workflow-operation',
                                            json.dumps(['wf', 'import-node', 'operation']))
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'workflow-import', 'ownerId': 'import-node',
                'assetKeys': [asset['asset_key']],
            }])
            service.replace_media_owner_references(
                workflow_id='wf', owner_type='workflow-import', owner_id='import-node',
                operation_id='save-1', idempotency_key='wf:import-node:save-1',
                expected_generation=0, document_revision=1, storage_epoch=epoch,
                asset_keys=[asset['asset_key']],
            )

            service.cleanup_assets('image-import')

            owner_id = service._formal_reference_owner_id('wf', 'workflow-import', 'import-node')
            with service._connect() as db:
                self.assertIsNotNone(db.execute('''SELECT 1 FROM media_asset_refs
                    WHERE owner_type='workflow-import' AND owner_id=? AND asset_key=?''',
                    (owner_id, asset['asset_key'])).fetchone())
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
            service.set_background_scan_pending.assert_called_once_with(False)
            stop.wait.assert_called_once_with(300)

    def test_worker_rechecks_integrity_after_unregistered_files_are_removed(self):
        from backend import main
        with mock.patch.object(main, 'storage_service') as service, \
                mock.patch.object(main, '_storage_recovery_stop') as stop, \
                mock.patch.object(main.workflow_service, 'list_workflows', return_value={'workflows': []}):
            service.get_storage_safety_status.return_value = {'reason': 'unregistered_files_removed'}
            service.recover_media_owner_transitions.return_value = {'nextCursor': ''}
            service.scan_media_integrity_page.return_value = {'complete': True}
            stop.is_set.return_value = False
            stop.wait.return_value = True

            main._maintain_runtime_cache()

            service.scan_media_integrity_page.assert_called_once()
            self.assertEqual([mock.call(True), mock.call(False)],
                             service.set_background_scan_pending.call_args_list)


if __name__ == '__main__':
    unittest.main()
