import os
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from backend.services.storage_service import StorageError, StorageService


class StorageServiceTests(unittest.TestCase):
    def test_workflow_document_action_is_fenced_by_the_captured_storage_epoch(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            epoch = service.get_storage_safety_status()['storageEpoch']
            calls = []
            self.assertEqual('saved', service.run_at_storage_epoch(epoch, lambda: (calls.append('save'), 'saved')[1]))
            with self.assertRaises(StorageError):
                service.run_at_storage_epoch('stale-epoch', lambda: calls.append('stale-save'))
            self.assertEqual(['save'], calls)

    def make_service(self, root, verified=True):
        service = StorageService(
            database_path=os.path.join(root, 'data', 'cainflow.db'),
            assets_dir=os.path.join(root, 'data', 'assets'),
            temp_dir=os.path.join(root, 'data', 'temp'),
            exports_dir=os.path.join(root, 'exports'),
        )
        if verified:
            service.initialize()
            service._safety_status.update({
                'state': 'healthy', 'reason': 'verified', 'recoveryConditions': [],
            })
            service._write_safety_status(service._safety_status)
        return service

    def record_manifest(self, service, workflow_id, revision, epoch, owner_id, asset_keys):
        return service.record_media_workflow_revision(workflow_id, revision, epoch, [{
            'ownerType': 'workflow-node', 'ownerId': owner_id, 'assetKeys': asset_keys,
        }])

    def finish_integrity_scan(self, service, workflows, batch_size=100):
        repairs = 0
        while True:
            result = service.scan_media_integrity_page(workflows, batch_size=batch_size)
            repairs += result.get('repairsApplied', 0)
            if result.get('complete'):
                return result, repairs

    def test_documents_are_atomic_json_records(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            service.put_document('session', {'nodes': [{'id': 'n1'}], 'apikey': 'plain-test-key'})
            restored = service.get_document('session')['value']
            self.assertEqual('n1', restored['nodes'][0]['id'])
            self.assertEqual('plain-test-key', restored['apikey'])
            with self.assertRaises(StorageError):
                service.put_document('unknown', {})

    def test_storage_safety_identity_and_epoch_survive_a_clean_restart(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            initial = first.get_storage_safety_status()
            first.mark_clean_shutdown()

            restarted = self.make_service(root, verified=False)
            restored = restarted.get_storage_safety_status()

            self.assertEqual('scan_required', initial['state'])
            self.assertEqual(initial['storageIdentity'], restored['storageIdentity'])
            self.assertEqual(initial['databaseIdentity'], restored['databaseIdentity'])
            self.assertEqual(initial['directoryIdentity'], restored['directoryIdentity'])
            self.assertEqual(initial['storageEpoch'], restored['storageEpoch'])
            self.assertEqual(1, restored['storageModeVersion'])
            self.assertEqual(1, restored['reportVersion'])
            self.assertNotIn(root, repr(restored))

    def test_changing_the_media_directory_creates_a_suspended_storage_epoch(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            initial = first.get_storage_safety_status()
            first.mark_clean_shutdown()
            moved = StorageService(
                database_path=first.database_path,
                assets_dir=os.path.join(root, 'moved-assets'),
                temp_dir=first.temp_dir,
                exports_dir=first.exports_dir,
            )

            changed = moved.get_storage_safety_status()

            self.assertEqual('scan_required', changed['state'])
            self.assertEqual('storage_identity_changed', changed['reason'])
            self.assertNotEqual(initial['storageIdentity'], changed['storageIdentity'])
            self.assertNotEqual(initial['storageEpoch'], changed['storageEpoch'])

    def test_unknown_newer_schema_fails_closed_without_being_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.initialize()
            first.mark_clean_shutdown()
            database = sqlite3.connect(first.database_path)
            try:
                database.execute("UPDATE meta SET value='999' WHERE key='schema_version'")
                database.commit()
            finally:
                database.close()

            restarted = self.make_service(root, verified=False)
            status = restarted.get_storage_safety_status()

            self.assertEqual('repair_required', status['state'])
            self.assertEqual('unknown_schema_version', status['reason'])
            database = sqlite3.connect(first.database_path)
            try:
                version = database.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            finally:
                database.close()
            self.assertEqual('999', version)

    def test_known_older_schema_upgrade_requires_an_integrity_scan(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.initialize()
            previous_epoch = first.get_storage_safety_status()['storageEpoch']
            first.mark_clean_shutdown()
            database = sqlite3.connect(first.database_path)
            try:
                database.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
                database.commit()
            finally:
                database.close()

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('scan_required', status['state'])
            self.assertEqual('schema_version_changed', status['reason'])
            self.assertNotEqual(previous_epoch, status['storageEpoch'])

    def test_independently_constructed_v1_schema_fixture_upgrades_forward_without_data_loss(self):
        with tempfile.TemporaryDirectory() as root:
            database_path = os.path.join(root, 'data', 'cainflow.db')
            os.makedirs(os.path.dirname(database_path), exist_ok=True)
            fixture_path = os.path.join(os.path.dirname(__file__), 'fixtures', 'media-safety-schema-v1.sql')
            database = sqlite3.connect(database_path)
            try:
                with open(fixture_path, encoding='utf-8') as source:
                    database.executescript(source.read())
                database.commit()
            finally:
                database.close()
            service = StorageService(database_path, os.path.join(root, 'data', 'assets'),
                                     os.path.join(root, 'data', 'temp'), os.path.join(root, 'exports'))
            service.initialize()
            self.assertEqual({'workflows': []}, service.get_document('session')['value'])
            self.assertEqual('legacy:fixture', service.get_asset_info('legacy:fixture')['asset_key'])
            with service._connect() as database:
                self.assertIsNotNone(database.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_asset_owners'").fetchone())
            self.assertEqual('scan_required', service.get_storage_safety_status()['state'])

    def test_repaired_schema_structure_requires_an_integrity_scan(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.initialize()
            first.mark_clean_shutdown()
            database = sqlite3.connect(first.database_path)
            try:
                database.execute('DROP TABLE media_asset_refs')
                database.commit()
            finally:
                database.close()

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('scan_required', status['state'])
            self.assertEqual('schema_structure_changed', status['reason'])

    def test_unclean_restart_keeps_storage_reclamation_suspended(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.get_storage_safety_status()

            restarted = self.make_service(root, verified=False)
            status = restarted.get_storage_safety_status()

            self.assertEqual('gc_suspended', status['state'])
            self.assertEqual('unclean_shutdown', status['reason'])
            self.assertIn('complete_integrity_scan', status['recoveryConditions'])

    def test_unreadable_persisted_safety_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.initialize()
            first.mark_clean_shutdown()
            with open(f'{first.database_path}.media-safety.json', 'w', encoding='utf-8') as output:
                output.write('{broken')

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('repair_required', status['state'])
            self.assertEqual('safety_state_unreadable', status['reason'])

    def test_oversized_safety_state_is_not_parsed_during_the_bounded_fast_check(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.initialize()
            first.mark_clean_shutdown()
            with open(f'{first.database_path}.media-safety.json', 'w', encoding='utf-8') as output:
                output.write('{"padding":"' + ('x' * 65537) + '"}')

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('repair_required', status['state'])
            self.assertEqual('safety_state_unreadable', status['reason'])

    def test_incomplete_safety_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            initial = first.get_storage_safety_status()
            first.mark_clean_shutdown()
            with open(f'{first.database_path}.media-safety.json', 'w', encoding='utf-8') as output:
                json.dump({'storageIdentity': initial['storageIdentity'], 'cleanShutdown': True}, output)

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('repair_required', status['state'])
            self.assertEqual('safety_state_invalid', status['reason'])

    def test_unknown_safety_state_version_cannot_claim_the_store_is_healthy(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root, verified=False)
            first.mark_clean_shutdown()
            path = f'{first.database_path}.media-safety.json'
            with open(path, encoding='utf-8') as source:
                persisted = json.load(source)
            persisted.update({'state': 'healthy', 'storageModeVersion': 999, 'unknown': 'discard-me'})
            with open(path, 'w', encoding='utf-8') as output:
                json.dump(persisted, output)

            status = self.make_service(root, verified=False).get_storage_safety_status()

            self.assertEqual('repair_required', status['state'])
            self.assertEqual('safety_state_invalid', status['reason'])
            self.assertNotIn('unknown', status)

    def test_fast_check_timeout_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            service = StorageService(
                database_path=os.path.join(root, 'data', 'cainflow.db'),
                assets_dir=os.path.join(root, 'data', 'assets'),
                temp_dir=os.path.join(root, 'data', 'temp'),
                exports_dir=os.path.join(root, 'exports'),
                fast_check_budget_seconds=0,
            )

            status = service.get_storage_safety_status()

            self.assertEqual('gc_suspended', status['state'])
            self.assertEqual('fast_check_timeout', status['reason'])

    def test_suspended_storage_keeps_unreferenced_media_while_owner_and_document_writes_continue(self):
        with tempfile.TemporaryDirectory() as root:
            first = self.make_service(root)
            asset = first.put_media_asset(b'keep-me', 'image/png', 'workflow-node', 'wf:preview')
            first.get_storage_safety_status()
            restarted = self.make_service(root, verified=False)
            self.assertEqual('gc_suspended', restarted.get_storage_safety_status()['state'])

            cleanup = restarted.remove_media_reference('workflow-node', 'wf:preview', asset['asset_key'])
            restarted.put_document('session', {'nodes': []})

            self.assertTrue(cleanup['gcSuspended'])
            self.assertEqual(1, cleanup['candidatesRetained'])
            self.assertIsNotNone(restarted.get_asset_info(asset['asset_key']))
            self.assertEqual({'nodes': []}, restarted.get_document('session')['value'])

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

    def test_replacing_a_new_owner_reference_list_commits_order_and_generation_atomically(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            first = service.put_media_asset(b'first', 'image/png', 'transition', 'op:first')
            second = service.put_media_asset(b'second', 'image/png', 'transition', 'op:second')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow-a', 7, epoch, 'node-a',
                                 [first['asset_key'], second['asset_key'], first['asset_key']])

            result = service.replace_media_owner_references(
                workflow_id='workflow-a', owner_type='workflow-node', owner_id='node-a',
                operation_id='generation-1', idempotency_key='workflow-a:node-a:generation-1',
                expected_generation=0, document_revision=7, storage_epoch=epoch,
                asset_keys=[first['asset_key'], second['asset_key'], first['asset_key']],
            )

            self.assertEqual({'status': 'committed', 'generation': 1}, result)
            owner = service.get_media_owner_reference_list('workflow-a', 'workflow-node', 'node-a')
            self.assertEqual(1, owner['generation'])
            self.assertEqual(7, owner['documentRevision'])
            self.assertEqual(
                [first['asset_key'], second['asset_key'], first['asset_key']],
                owner['assetKeys'],
            )

    def test_owner_reference_replacement_replays_the_same_operation_but_rejects_changed_content(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            first = service.put_media_asset(b'first', 'image/png', 'transition', 'op:first')
            second = service.put_media_asset(b'second', 'image/png', 'transition', 'op:second')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow-a', 7, epoch, 'node-a', [first['asset_key']])
            request = {
                'workflow_id': 'workflow-a', 'owner_type': 'workflow-node', 'owner_id': 'node-a',
                'operation_id': 'generation-1', 'idempotency_key': 'stable-operation-key',
                'expected_generation': 0, 'document_revision': 7, 'storage_epoch': epoch,
                'asset_keys': [first['asset_key']],
            }
            self.assertEqual('committed', service.replace_media_owner_references(**request)['status'])

            replay = service.replace_media_owner_references(**request)

            self.assertEqual({'status': 'already-committed', 'generation': 1}, replay)
            with self.assertRaises(StorageError):
                service.replace_media_owner_references(**{
                    **request, 'asset_keys': [second['asset_key']],
                })

    def test_owner_reference_replacement_distinguishes_stale_cancelled_and_reconciliation_results(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'asset', 'image/png', 'transition', 'op:asset')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow-a', 4, epoch, 'node-a', [asset['asset_key']])
            base = {
                'workflow_id': 'workflow-a', 'owner_type': 'workflow-node', 'owner_id': 'node-a',
                'expected_generation': 0, 'document_revision': 4, 'storage_epoch': epoch,
                'asset_keys': [asset['asset_key']],
            }
            self.assertEqual('cancelled', service.replace_media_owner_references(
                **base, operation_id='cancelled', idempotency_key='cancelled', cancelled=True,
            )['status'])
            self.record_manifest(service, 'workflow-missing', 4, epoch, 'node-a', ['media:missing'])
            self.assertEqual('needs-reconciliation', service.replace_media_owner_references(
                **{**base, 'workflow_id': 'workflow-missing', 'asset_keys': ['media:missing']},
                operation_id='missing', idempotency_key='missing',
            )['status'])
            committed = service.replace_media_owner_references(
                **base, operation_id='commit', idempotency_key='commit',
            )
            self.assertEqual('committed', committed['status'])
            stale = service.replace_media_owner_references(
                **{**base, 'expected_generation': 0, 'document_revision': 3},
                operation_id='late', idempotency_key='late',
            )
            self.assertEqual({'status': 'stale', 'generation': 1}, stale)
            stale_epoch = service.replace_media_owner_references(
                **{**base, 'expected_generation': 1, 'storage_epoch': 'old-epoch'},
                operation_id='old-epoch', idempotency_key='old-epoch',
            )
            self.assertEqual({'status': 'stale', 'generation': 1}, stale_epoch)

    def test_cancelled_generation_stays_fenced_after_restart_and_compensates_only_its_operation_owner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            cancelled_owner = '["workflow","node","cancelled-operation"]'
            newer_owner = '["workflow","node","newer-operation"]'
            cancelled_assets = service.put_media_asset_list(
                ['data:image/png;base64,Y2FuY2VsbGVk'], 'workflow-operation', cancelled_owner)
            other = service.put_media_asset(
                b'newer-result', 'image/png', 'workflow-operation', newer_owner)
            self.assertTrue(service.cancel_media_operation_owner(cancelled_owner)['cancelled'])

            restarted = self.make_service(root)
            with self.assertRaisesRegex(StorageError, 'operation was cancelled'):
                restarted.put_media_asset_list(
                    ['data:image/png;base64,Y2FuY2VsbGVk'], 'workflow-operation', cancelled_owner)
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'operation was cancelled'):
                with restarted._connect() as legacy_writer:
                    legacy_writer.execute('''INSERT INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                        VALUES('workflow-operation', ?, ?, ?)''',
                        (cancelled_owner, other['asset_key'], int(time.time() * 1000)))
            self.assertIsNone(restarted.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node'))
            with restarted._connect() as database:
                self.assertIsNone(database.execute('''SELECT 1 FROM media_asset_refs
                    WHERE owner_type='workflow-operation' AND owner_id=? AND asset_key=?''',
                    (cancelled_owner, cancelled_assets[0]['asset_key'])).fetchone())
            with restarted._connect() as database:
                remaining_operation_refs = database.execute('''SELECT owner_id, asset_key
                    FROM media_asset_refs WHERE owner_type='workflow-operation' ORDER BY owner_id''').fetchall()
            self.assertEqual([(newer_owner, other['asset_key'])], [tuple(row) for row in remaining_operation_refs])

    def test_interrupted_owner_replacement_keeps_the_previous_complete_owner_list(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            epoch = service.get_storage_safety_status()['storageEpoch']
            for injected_stage in ('new_owner_established', 'partial_old_reference_released'):
                old = service.put_media_asset(f'old-{injected_stage}'.encode(), 'image/png',
                                              'transition', f'old-{injected_stage}')
                old_second = service.put_media_asset(f'old-second-{injected_stage}'.encode(), 'image/png',
                                                     'transition', f'old-second-{injected_stage}')
                new = service.put_media_asset(f'new-{injected_stage}'.encode(), 'image/png',
                                              'transition', f'new-{injected_stage}')
                owner_id = f'node-{injected_stage}'
                workflow_id = f'workflow-{injected_stage}'
                old_keys = [old['asset_key'], old_second['asset_key']]
                self.record_manifest(service, workflow_id, 1, epoch, owner_id, old_keys)
                service.replace_media_owner_references(
                    workflow_id=workflow_id, owner_type='workflow-node', owner_id=owner_id,
                    operation_id=f'old-{injected_stage}', idempotency_key=f'old-{injected_stage}',
                    expected_generation=0, document_revision=1, storage_epoch=epoch,
                    asset_keys=old_keys,
                )
                service.remove_media_reference('transition', f'old-{injected_stage}', old['asset_key'])
                service.remove_media_reference('transition', f'old-second-{injected_stage}', old_second['asset_key'])
                self.record_manifest(service, workflow_id, 2, epoch, owner_id, [new['asset_key']])
                interrupted = StorageService(
                    database_path=service.database_path, assets_dir=service.assets_dir,
                    temp_dir=service.temp_dir, exports_dir=service.exports_dir,
                    transition_fault_injector=lambda stage, target=injected_stage: (
                        (_ for _ in ()).throw(RuntimeError('injected interruption'))
                    if stage == target else None
                    ),
                )

                with self.assertRaises(RuntimeError):
                    interrupted.replace_media_owner_references(
                        workflow_id=workflow_id, owner_type='workflow-node', owner_id=owner_id,
                        operation_id=f'new-{injected_stage}', idempotency_key=f'new-{injected_stage}',
                        expected_generation=1, document_revision=2, storage_epoch=epoch,
                        asset_keys=[new['asset_key']],
                    )

                owner = service.get_media_owner_reference_list(workflow_id, 'workflow-node', owner_id)
                if injected_stage == 'new_owner_established':
                    self.assertEqual(1, owner['generation'])
                    self.assertEqual(old_keys, owner['assetKeys'])
                    retry_status = service.replace_media_owner_references(
                        workflow_id=workflow_id, owner_type='workflow-node', owner_id=owner_id,
                        operation_id=f'new-{injected_stage}', idempotency_key=f'new-{injected_stage}',
                        expected_generation=1, document_revision=2, storage_epoch=epoch,
                        asset_keys=[new['asset_key']],
                    )['status']
                    self.assertEqual('committed', retry_status)
                else:
                    self.assertEqual(2, owner['generation'])
                    self.assertEqual([new['asset_key']], owner['assetKeys'])
                    retry_status = service.replace_media_owner_references(
                        workflow_id=workflow_id, owner_type='workflow-node', owner_id=owner_id,
                        operation_id=f'new-{injected_stage}', idempotency_key=f'new-{injected_stage}',
                        expected_generation=1, document_revision=2, storage_epoch=epoch,
                        asset_keys=[new['asset_key']],
                    )['status']
                    self.assertEqual('already-committed', retry_status)
                self.assertIsNotNone(service.get_asset_info(old['asset_key']))
                self.assertIsNotNone(service.get_asset_info(old_second['asset_key']))

    def test_restart_recovers_interrupted_owner_transition_with_its_complete_ordered_target(self):
        for failure_stage in ('new_owner_established', 'owner_promoted', 'partial_old_reference_released'):
            with self.subTest(stage=failure_stage), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root)
                epoch = service.get_storage_safety_status()['storageEpoch']
                old = service.put_media_asset(b'old', 'image/png', 'transition', 'old')
                first = service.put_media_asset(b'first', 'image/png', 'transition', 'first')
                second = service.put_media_asset(b'second', 'image/png', 'transition', 'second')
                self.record_manifest(service, 'workflow', 1, epoch, 'node', [old['asset_key']])
                service.replace_media_owner_references(
                    workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                    operation_id='old', idempotency_key='old', expected_generation=0,
                    document_revision=1, storage_epoch=epoch, asset_keys=[old['asset_key']],
                )
                keys = [second['asset_key'], first['asset_key'], second['asset_key']]
                self.record_manifest(service, 'workflow', 2, epoch, 'node', keys)

                def interrupt(stage):
                    if stage == failure_stage:
                        raise RuntimeError('interrupted transition')

                service._transition_fault_injector = interrupt
                with self.assertRaises(RuntimeError):
                    service.replace_media_owner_references(
                        workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                        operation_id='new', idempotency_key='new', expected_generation=1,
                        document_revision=2, storage_epoch=epoch, asset_keys=keys,
                    )
                service.mark_clean_shutdown()
                restarted = self.make_service(root)
                recovered = restarted.recover_media_owner_transitions()
                self.assertEqual(1, recovered['completed'])
                self.assertEqual(keys, restarted.get_media_owner_reference_list(
                    'workflow', 'workflow-node', 'node')['assetKeys'])
                self.assertEqual(0, restarted.recover_media_owner_transitions()['completed'])
                self.assertNotIn('media-transition', restarted.get_stats()['mediaReferenceDistribution'])

    def test_application_startup_recovers_pending_ownership_before_clean_process_exit(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'result', 'image/png', 'transition', 'operation')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])

            def interrupt(stage):
                if stage == 'new_owner_established':
                    raise RuntimeError('interrupted')

            service._transition_fault_injector = interrupt
            with self.assertRaises(RuntimeError):
                service.replace_media_owner_references(
                    workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                    operation_id='operation', idempotency_key='operation', expected_generation=0,
                    document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']],
                )
            # Configure the real application in a separate process before importing its services.
            # Every mutable path stays inside this test's isolated temporary directory.
            service.mark_clean_shutdown()
            program = '''
import os, sys, time
from backend import config
root = sys.argv[1]
config.EXE_DIR = config.STATIC_ROOT = root
config.MAIN_EXE_PATH = os.path.join(root, 'CainFlow.exe')
for name, relative in {
    'WORKFLOWS_DIR': 'workflows', 'LOG_DIR': 'log', 'PROTOCOLS_DIR': 'protocols',
    'DATA_DIR': 'data', 'ASSETS_DIR': 'data/assets', 'DATA_TEMP_DIR': 'data/temp',
    'DATABASE_PATH': 'data/cainflow.db', 'EXPORTS_DIR': 'exports',
}.items():
    setattr(config, name, os.path.join(root, relative))
from backend.main import initialize_runtime
from backend.services.storage_service import storage_service
initialize_runtime()
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    owner = storage_service.get_media_owner_reference_list('workflow', 'workflow-node', 'node')
    if owner and owner['assetKeys'] == [sys.argv[2]]:
        break
    time.sleep(0.01)
else:
    raise RuntimeError('Startup did not recover the pending owner')
'''
            process = subprocess.run([sys.executable, '-c', program, root, asset['asset_key']],
                                     capture_output=True, text=True, timeout=10)
            self.assertEqual(0, process.returncode, process.stderr)
            restarted = self.make_service(root, verified=False)
            self.assertEqual('healthy', restarted.get_storage_safety_status()['state'])
            self.assertNotIn('media-transition', restarted.get_stats()['mediaReferenceDistribution'])
            self.assertIsNotNone(restarted.get_asset(asset['asset_key']))

    def test_late_release_preserves_media_reintroduced_by_a_newer_generation(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            first = service.put_media_asset(b'first', 'image/png', 'transition', 'first')
            second = service.put_media_asset(b'second', 'image/png', 'transition', 'second')
            epoch = service.get_storage_safety_status()['storageEpoch']

            def replace(revision, asset):
                self.record_manifest(service, 'workflow-a', revision, epoch, 'node-a', [asset['asset_key']])
                return service.replace_media_owner_references(
                    workflow_id='workflow-a', owner_type='workflow-node', owner_id='node-a',
                    operation_id=f'op-{revision}', idempotency_key=f'op-{revision}',
                    expected_generation=revision - 1, document_revision=revision,
                    storage_epoch=epoch, asset_keys=[asset['asset_key']],
                )

            replace(1, first)

            def overlap(stage):
                if stage == 'owner_promoted':
                    service._transition_fault_injector = lambda _stage: None
                    replace(3, first)

            service._transition_fault_injector = overlap
            replace(2, second)
            service.remove_media_reference('transition', 'first')
            service.remove_media_reference('transition', 'second')
            service.cleanup_unreferenced_media_assets()

            self.assertEqual([first['asset_key']], service.get_media_owner_reference_list(
                'workflow-a', 'workflow-node', 'node-a')['assetKeys'])
            self.assertIsNotNone(service.get_asset(first['asset_key']))
            self.assertEqual({'assets': 1, 'bytes': 5},
                             service.get_stats()['mediaReferenceDistribution']['workflow-node'])

    def test_concurrent_owner_replacements_allow_only_one_generation_cas_winner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            assets = [
                service.put_media_asset(value, 'image/png', 'transition', f'op:{index}')
                for index, value in enumerate((b'one', b'two'))
            ]
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow-a', 1, epoch, 'node-a', [assets[0]['asset_key']])
            barrier = threading.Barrier(2)
            results = []

            def replace(index):
                contender = StorageService(
                    database_path=service.database_path, assets_dir=service.assets_dir,
                    temp_dir=service.temp_dir, exports_dir=service.exports_dir,
                    transition_fault_injector=lambda stage: barrier.wait()
                    if stage == 'new_owner_established' else None,
                )
                results.append(contender.replace_media_owner_references(
                    workflow_id='workflow-a', owner_type='workflow-node', owner_id='node-a',
                    operation_id=f'op-{index}', idempotency_key=f'op-{index}',
                    expected_generation=0, document_revision=1,
                    storage_epoch=epoch, asset_keys=[assets[0]['asset_key']],
                ))

            threads = [threading.Thread(target=replace, args=(index,)) for index in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(['committed', 'stale'], sorted(result['status'] for result in results))
            self.assertEqual(1, service.get_media_owner_reference_list(
                'workflow-a', 'workflow-node', 'node-a')['generation'])

    def test_concurrent_replay_of_one_operation_does_not_supersede_its_successful_commit(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'result', 'image/png', 'transition', 'operation')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])
            barrier = threading.Barrier(2, timeout=5)
            outcomes = []
            errors = []
            request = dict(workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                           operation_id='operation', idempotency_key='operation', expected_generation=0,
                           document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])

            def replay():
                try:
                    contender = StorageService(
                        database_path=service.database_path, assets_dir=service.assets_dir,
                        temp_dir=service.temp_dir, exports_dir=service.exports_dir,
                        transition_fault_injector=lambda stage: barrier.wait()
                        if stage == 'new_owner_established' else None,
                    )
                    outcomes.append(contender.replace_media_owner_references(**request)['status'])
                except Exception as error:
                    errors.append(error)

            threads = [threading.Thread(target=replay) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive())
            self.assertEqual([], errors)
            self.assertEqual(['already-committed', 'committed'], sorted(outcomes))
            self.assertEqual('already-committed', service.replace_media_owner_references(**request)['status'])
            self.assertEqual(1, service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node')['generation'])

    def test_owner_reference_identity_is_unambiguous_across_workflow_and_node_boundaries(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            assets = [service.put_media_asset(value, 'image/png', 'transition', str(index))
                      for index, value in enumerate((b'one', b'two'))]
            epoch = service.get_storage_safety_status()['storageEpoch']
            identities = (('a:b', 'c'), ('a', 'b:c'))
            for index, (workflow_id, owner_id) in enumerate(identities):
                self.record_manifest(service, workflow_id, 1, epoch, owner_id,
                                     [assets[index]['asset_key']])
                service.replace_media_owner_references(
                    workflow_id=workflow_id, owner_type='workflow-node', owner_id=owner_id,
                    operation_id=str(index), idempotency_key=f'identity-{index}',
                    expected_generation=0, document_revision=1, storage_epoch=epoch,
                    asset_keys=[assets[index]['asset_key']],
                )

            for index, (workflow_id, owner_id) in enumerate(identities):
                self.assertEqual([assets[index]['asset_key']], service.get_media_owner_reference_list(
                    workflow_id, 'workflow-node', owner_id)['assetKeys'])

    def test_workflow_document_revision_cannot_be_rebound_to_different_media(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            assets = [service.put_media_asset(value, 'image/png', 'transition', str(index))
                      for index, value in enumerate((b'one', b'two'))]
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow-a', 1, epoch, 'node-a', [assets[0]['asset_key']])

            with self.assertRaises(StorageError):
                self.record_manifest(service, 'workflow-a', 1, epoch, 'node-a', [assets[1]['asset_key']])

    def test_interrupted_media_materialization_never_publishes_an_unowned_asset(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)

            def interrupt(stage):
                if stage == 'media_materialized':
                    raise RuntimeError('simulated process interruption')

            service._transition_fault_injector = interrupt
            with self.assertRaisesRegex(RuntimeError, 'simulated process interruption'):
                service.put_media_asset(b'new-result', 'image/png', 'media-transition', 'operation-a')

            self.assertEqual(0, service.get_stats()['mediaBytes'])
            service._transition_fault_injector = lambda _stage: None
            retried = service.put_media_asset(b'new-result', 'image/png', 'media-transition', 'operation-a')
            service.cleanup_unreferenced_media_assets()
            self.assertIsNotNone(service.get_asset(retried['asset_key']))
            self.assertEqual({'assets': 1, 'bytes': 10},
                             service.get_stats()['mediaReferenceDistribution']['media-transition'])

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

    def test_workflow_deletion_seals_formal_owners_across_restart_and_preserves_other_workflows(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'shared', 'image/png', 'transition', 'operation')
            epoch = service.get_storage_safety_status()['storageEpoch']
            for workflow_id in ('workflow-a', 'workflow-b'):
                self.record_manifest(service, workflow_id, 1, epoch, 'node', [asset['asset_key']])
                service.replace_media_owner_references(
                    workflow_id=workflow_id, owner_type='workflow-node', owner_id='node',
                    operation_id=workflow_id, idempotency_key=workflow_id,
                    expected_generation=0, document_revision=1, storage_epoch=epoch,
                    asset_keys=[asset['asset_key']],
                )
            service.remove_media_reference('transition', 'operation')

            service.release_workflow_media_references('workflow-a')
            service.mark_clean_shutdown()
            restarted = self.make_service(root)

            deleted = restarted.get_media_owner_reference_list('workflow-a', 'workflow-node', 'node')
            self.assertTrue(deleted['tombstoned'])
            self.assertEqual(2, deleted['generation'])
            self.assertEqual([], deleted['assetKeys'])
            self.assertEqual([asset['asset_key']], restarted.get_media_owner_reference_list(
                'workflow-b', 'workflow-node', 'node')['assetKeys'])
            self.assertIsNotNone(restarted.get_asset(asset['asset_key']))
            with self.assertRaises(StorageError):
                self.record_manifest(restarted, 'workflow-a', 2, epoch, 'node', [asset['asset_key']])
            restarted.release_workflow_media_references('workflow-a')
            self.assertEqual(2, restarted.get_media_owner_reference_list(
                'workflow-a', 'workflow-node', 'node')['generation'])

    def test_workflow_deletion_between_preparation_and_promotion_rejects_late_completion(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'pending', 'image/png', 'transition', 'operation')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])

            def delete_during_transition(stage):
                if stage == 'new_owner_established':
                    service.release_workflow_media_references('workflow')

            service._transition_fault_injector = delete_during_transition
            outcome = service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='operation', idempotency_key='operation', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']],
            )
            self.assertEqual('stale', outcome['status'])
            self.assertIsNone(service.get_media_owner_reference_list('workflow', 'workflow-node', 'node'))
            self.assertEqual(0, service.recover_media_owner_transitions()['completed'])
            with self.assertRaises(StorageError):
                self.record_manifest(service, 'workflow', 2, epoch, 'new-node', [asset['asset_key']])

    def test_node_removal_tombstones_its_owner_and_undo_can_explicitly_restore_it(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'node-result', 'image/png', 'transition', 'materialize')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])
            service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='generate-1', idempotency_key='generate-1', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])

            service.record_media_workflow_revision('workflow', 2, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': []
            }])
            removed = service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='workflow-delete:2', idempotency_key='delete-node', expected_generation=1,
                intent='delete',
                document_revision=2, storage_epoch=epoch, asset_keys=[])
            self.assertEqual('committed', removed['status'])
            deleted = service.get_media_owner_reference_list('workflow', 'workflow-node', 'node')
            self.assertTrue(deleted['tombstoned'])
            self.assertEqual(2, deleted['generation'])
            self.assertEqual([], deleted['assetKeys'])
            late = service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='late', idempotency_key='late', expected_generation=1,
                document_revision=2, storage_epoch=epoch, asset_keys=[asset['asset_key']])
            self.assertEqual('stale', late['status'])

            self.record_manifest(service, 'workflow', 3, epoch, 'node', [asset['asset_key']])
            restored = service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='workflow-undo:3', idempotency_key='undo-delete', expected_generation=2,
                intent='undo',
                document_revision=3, storage_epoch=epoch, asset_keys=[asset['asset_key']])
            self.assertEqual('committed', restored['status'])
            self.assertFalse(service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node')['tombstoned'])

    def test_redo_can_explicitly_restore_a_tombstoned_node(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'redo-result', 'image/png', 'transition', 'materialize')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [])
            service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='workflow-delete:1', idempotency_key='delete-for-redo', expected_generation=0,
                intent='delete', document_revision=1, storage_epoch=epoch, asset_keys=[])
            self.record_manifest(service, 'workflow', 2, epoch, 'node', [asset['asset_key']])

            restored = service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='workflow-redo:2', idempotency_key='redo-delete', expected_generation=1,
                intent='redo', document_revision=2, storage_epoch=epoch, asset_keys=[asset['asset_key']])

            self.assertEqual('committed', restored['status'])
            self.assertFalse(service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node')['tombstoned'])

    def test_transition_intent_is_validated_and_bound_to_the_idempotency_key(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'intent', 'image/png', 'transition', 'materialize')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])
            request = dict(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='operation', idempotency_key='intent-key', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])

            with self.assertRaisesRegex(StorageError, 'Unknown Media asset owner transition intent'):
                service.replace_media_owner_references(**request, intent='restore-anything')
            self.assertEqual('committed', service.replace_media_owner_references(
                **request, intent='save')['status'])
            with self.assertRaisesRegex(StorageError, 'different transition content'):
                service.replace_media_owner_references(**request, intent='undo')
            with service._connect() as database:
                self.assertEqual('save', database.execute(
                    'SELECT intent FROM media_asset_transitions WHERE idempotency_key=?',
                    ('intent-key',)).fetchone()[0])

    def test_node_deletion_transition_recovers_after_owner_promotion(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'node-result', 'image/png', 'transition', 'materialize')
            epoch = service.get_storage_safety_status()['storageEpoch']
            self.record_manifest(service, 'workflow', 1, epoch, 'node', [asset['asset_key']])
            service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                operation_id='generate', idempotency_key='generate', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])
            service.record_media_workflow_revision('workflow', 2, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': []
            }])
            service._transition_fault_injector = lambda stage: (
                (_ for _ in ()).throw(RuntimeError('crash')) if stage == 'owner_promoted' else None
            )
            with self.assertRaisesRegex(RuntimeError, 'crash'):
                service.replace_media_owner_references(
                    workflow_id='workflow', owner_type='workflow-node', owner_id='node',
                    operation_id='workflow-delete:2', idempotency_key='delete', expected_generation=1,
                    intent='delete',
                    document_revision=2, storage_epoch=epoch, asset_keys=[])
            service._transition_fault_injector = lambda _stage: None
            self.assertEqual(1, service.recover_media_owner_transitions()['completed'])
            self.assertTrue(service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node')['tombstoned'])

    def test_deleted_workflow_rejects_late_legacy_generation_and_reference_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            shared = service.put_media_asset(b'shared', 'image/png', 'history', 'one')
            service.release_workflow_media_references('workflow-a')
            service.mark_clean_shutdown()
            restarted = self.make_service(root)

            with self.assertRaises(StorageError):
                restarted.put_media_asset(b'late', 'image/png', 'workflow-node', 'workflow-a:new-node')
            with self.assertRaises(StorageError):
                restarted.add_media_reference('workflow-import', 'workflow-a:import', shared['asset_key'])
            restarted.add_media_reference('workflow-node', 'workflow-b:new-node', shared['asset_key'])
            self.assertEqual(len(b'shared'), restarted.get_stats()['mediaBytes'])

    def test_workflow_deletion_releases_and_fences_operation_scoped_temporary_owners(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(
                b'pending', 'image/png', 'workflow-operation', '["workflow-a","node","operation-a"]')

            outcome = service.release_workflow_media_references('workflow-a')

            self.assertEqual(1, outcome['referencesDeleted'])
            with self.assertRaises(StorageError):
                service.put_media_asset(
                    b'late', 'image/png', 'workflow-operation', '["workflow-a","node","operation-b"]')
            self.assertIsNone(service.get_asset_info(asset['asset_key']))

    def test_operation_media_list_materializes_all_assets_and_references_atomically(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            values = [
                'data:image/png;base64,aGVsbG8=',
                'data:image/png;base64,d29ybGQ=',
            ]

            owner_id = '["workflow","node","operation"]'
            assets = service.put_media_asset_list(values, 'workflow-operation', owner_id)

            self.assertEqual(2, len(assets))
            with service._connect() as database:
                self.assertEqual(2, database.execute('''SELECT COUNT(*) FROM media_asset_refs
                    WHERE owner_type='workflow-operation' AND owner_id=?''', (owner_id,)).fetchone()[0])
                self.assertEqual(
                    [asset['asset_key'] for asset in assets],
                    [row[0] for row in database.execute('''SELECT asset_key FROM media_operation_owner_items
                        WHERE owner_id=? ORDER BY position''', (owner_id,))])
            replay = service.put_media_asset_list(values, 'workflow-operation', owner_id)
            self.assertEqual([asset['asset_key'] for asset in assets], [asset['asset_key'] for asset in replay])
            with self.assertRaisesRegex(StorageError, 'different ordered list'):
                service.put_media_asset_list(list(reversed(values)), 'workflow-operation', owner_id)
            with self.assertRaises(StorageError):
                service.put_media_asset_list([values[0], 'invalid'], 'workflow-operation', 'workflow:node:failed')
            with service._connect() as database:
                self.assertEqual(0, database.execute('''SELECT COUNT(*) FROM media_asset_refs
                    WHERE owner_type='workflow-operation' AND owner_id='workflow:node:failed' ''').fetchone()[0])

    def test_startup_promotes_operation_owner_proven_by_the_durable_workflow(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            owner_id = '["workflow","node","operation"]'
            key = service.put_media_asset_list(
                ['data:image/png;base64,aGVsbG8='], 'workflow-operation', owner_id)[0]['asset_key']
            workflow = {'workflowId': 'workflow', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node', 'type': 'ImagePreview', 'data': {
                    'mediaAssetKeys': [key],
                    'mediaOwnershipTemporaryOwners': [{'ownerId': owner_id, 'assetKeys': [key]}],
                }}]}

            self.assertEqual({'completed': 1, 'unresolved': 0},
                             service.recover_workflow_operation_owners([workflow]))
            self.assertEqual([key], service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'node')['assetKeys'])
            with service._connect() as database:
                self.assertEqual(0, database.execute('''SELECT COUNT(*) FROM media_asset_refs
                    WHERE owner_type='workflow-operation' AND owner_id=?''', (owner_id,)).fetchone()[0])

    def test_startup_retains_unassociated_operation_owner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            owner_id = '["workflow","node","operation"]'
            key = service.put_media_asset_list(
                ['data:image/png;base64,aGVsbG8='], 'workflow-operation', owner_id)[0]['asset_key']

            self.assertEqual({'completed': 0, 'unresolved': 0},
                             service.recover_workflow_operation_owners([]))
            with service._connect() as database:
                self.assertEqual(1, database.execute('''SELECT COUNT(*) FROM media_asset_refs
                    WHERE owner_type='workflow-operation' AND owner_id=? AND asset_key=?''',
                    (owner_id, key)).fetchone()[0])

    def test_startup_recovery_tombstones_an_owner_deleted_by_the_same_document_revision(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            epoch = service.get_storage_safety_status()['storageEpoch']
            old = service.put_media_asset(b'old', 'image/png', 'transition', 'old')
            self.record_manifest(service, 'workflow', 1, epoch, 'deleted', [old['asset_key']])
            service.replace_media_owner_references(
                workflow_id='workflow', owner_type='workflow-node', owner_id='deleted',
                operation_id='save:1', idempotency_key='save:1', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[old['asset_key']])
            owner_id = '["workflow","current","operation"]'
            key = service.put_media_asset_list(
                ['data:image/png;base64,aGVsbG8='], 'workflow-operation', owner_id)[0]['asset_key']
            workflow = {'workflowId': 'workflow', 'mediaOwnershipRevision': 2, 'nodes': [{
                'id': 'current', 'type': 'ImagePreview', 'data': {'mediaAssetKeys': [key],
                'mediaOwnershipTemporaryOwners': [{'ownerId': owner_id, 'assetKeys': [key]}]}}]}

            self.assertEqual(2, service.recover_workflow_operation_owners([workflow])['completed'])
            self.assertTrue(service.get_media_owner_reference_list(
                'workflow', 'workflow-node', 'deleted')['tombstoned'])

    def test_startup_does_not_promote_an_operation_from_an_old_storage_epoch(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            owner_id = '["workflow","node","operation"]'
            key = service.put_media_asset_list(
                ['data:image/png;base64,aGVsbG8='], 'workflow-operation', owner_id)[0]['asset_key']
            with service._connect() as database:
                database.execute("UPDATE media_operation_owner_items SET storage_epoch='old-epoch' WHERE owner_id=?",
                                 (owner_id,))
            workflow = {'workflowId': 'workflow', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node', 'type': 'ImagePreview', 'data': {'mediaAssetKeys': [key],
                'mediaOwnershipTemporaryOwners': [{'ownerId': owner_id, 'assetKeys': [key]}]}}]}

            self.assertEqual({'completed': 0, 'unresolved': 1},
                             service.recover_workflow_operation_owners([workflow]))
            self.assertIsNone(service.get_media_owner_reference_list('workflow', 'workflow-node', 'node'))

    def test_startup_releases_every_overlapping_operation_owner_for_the_promoted_node(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            values = ['data:image/png;base64,aGVsbG8=']
            owner_ids = ['["workflow","node","one"]', '["workflow","node","two"]']
            key = service.put_media_asset_list(values, 'workflow-operation', owner_ids[0])[0]['asset_key']
            service.put_media_asset_list(values, 'workflow-operation', owner_ids[1])
            workflow = {'workflowId': 'workflow', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node', 'type': 'ImagePreview', 'data': {'mediaAssetKeys': [key],
                'mediaOwnershipTemporaryOwners': [
                    {'ownerId': owner_id, 'assetKeys': [key]} for owner_id in owner_ids
                ]}}]}

            self.assertEqual(1, service.recover_workflow_operation_owners([workflow])['completed'])
            with service._connect() as database:
                self.assertEqual(0, database.execute('''SELECT COUNT(*) FROM media_asset_refs
                    WHERE owner_type='workflow-operation' ''').fetchone()[0])

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

    def test_releasing_workflow_media_also_removes_undo_snapshot_owners(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'undo-only', 'image/png', 'workflow-undo', 'workflow-a:undo:node')
            service.add_media_reference('workflow-undo', 'workflow-b:undo:node', asset['asset_key'])

            result = service.release_workflow_media_references('workflow-a')

            self.assertEqual(1, result['referencesDeleted'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))
            service.release_workflow_media_references('workflow-b')
            self.assertIsNone(service.get_asset_info(asset['asset_key']))

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
            service = self.make_service(root, verified=False)
            service.put_document('session', {'nodes': []})
            exported = service.export_media('keep.bin', b'keep')
            service.put_asset('node:1', b'data')
            with self.assertRaises(StorageError):
                service.factory_reset()
            self.assertTrue(service.has_user_data())
            self.assertTrue(os.path.exists(exported))

    def test_corrupt_database_is_quarantined(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            os.makedirs(os.path.dirname(service.database_path), exist_ok=True)
            with open(service.database_path, 'wb') as file:
                file.write(b'not-a-sqlite-database')
            service.initialize()
            quarantined = [name for name in os.listdir(os.path.dirname(service.database_path)) if '.corrupt-' in name]
            self.assertEqual(1, len(quarantined))
            self.assertEqual(0, service.get_stats()['documents'])
            status = service.get_storage_safety_status()
            self.assertEqual('repair_required', status['state'])
            self.assertEqual('database_unreadable', status['reason'])

    def test_integrity_scan_is_resumable_and_classifies_each_durable_source(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            present = service.put_asset('media:present', b'present', 'image/png', 'media')
            missing_file = service.put_asset('media:missing-file', b'missing-file', 'image/png', 'media')
            os.remove(os.path.join(service.assets_dir, service.get_asset_info(missing_file['asset_key'])['relative_path']))
            unregistered_path = os.path.join(service.assets_dir, 'unregistered.bin')
            with open(unregistered_path, 'wb') as output:
                output.write(b'unregistered')
            database = sqlite3.connect(service.database_path)
            try:
                database.create_function('cainflow_writer_schema_version', 0, lambda: 10)
                database.execute('PRAGMA foreign_keys=OFF')
                database.execute("INSERT INTO media_asset_refs VALUES('history', 'missing-meta', 'missing-key', 1)")
                database.execute("INSERT INTO media_asset_owners VALUES('wf', 'workflow-node', 'partial', 1, 1, 0, 1)")
                database.execute("INSERT INTO media_asset_owner_items VALUES('wf', 'workflow-node', 'partial', 1, ?)",
                                 (present['asset_key'],))
                database.execute("INSERT INTO media_asset_refs VALUES('workflow-node', ?, ?, 1)",
                                 (json.dumps(['ghost', 'workflow-node', 'n']), present['asset_key']))
                database.execute("INSERT INTO media_asset_transitions VALUES('stuck', 'wf', 'workflow-node', 'n', 'op', 'save', 'digest', 0, 1, ?, 'prepared', NULL, 1)",
                                 (service.get_storage_safety_status()['storageEpoch'],))
                database.commit()
            finally:
                database.close()

            workflows = [{'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'partial', 'type': 'ImageGenerate', 'output': {'assetKeys': [present['asset_key'], 'missing-key']},
            }, {
                'id': 'missing-owner', 'type': 'ImageGenerate', 'output': {'assetKey': present['asset_key']},
            }]}]
            original_workflows = json.loads(json.dumps(workflows))
            first = service.scan_media_integrity_page(workflows, batch_size=1)
            self.assertFalse(first['complete'])

            restarted = self.make_service(root, verified=False)
            result = first
            repairs_applied = 0
            while not result['complete']:
                result = restarted.scan_media_integrity_page(workflows, batch_size=2)
                repairs_applied += result.get('repairsApplied', 0)
            classes = {item['damageClass'] for item in result['report']['damageItems']}
            self.assertTrue({'missing_file', 'missing_metadata', 'unassociated_owner',
                             'unregistered_file', 'interrupted_transition', 'partial_reference_list'} <= classes,
                            classes)
            self.assertEqual(1, repairs_applied)
            self.assertEqual('gc_suspended', restarted.get_storage_safety_status()['state'])
            self.assertEqual(original_workflows, workflows)

    def test_clean_integrity_report_is_published_with_healthy_state_atomically(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            result, _ = self.finish_integrity_scan(service, [])

            self.assertTrue(result['complete'])
            self.assertEqual([], result['report']['damageItems'])
            self.assertIsInstance(result['report']['cutoffRevision'], int)
            self.assertEqual({
                'pendingTransitionCount': 0, 'highRiskDamageCount': 0,
                'quarantineValid': True, 'quarantineItemCount': 0,
                'collectionCandidateCount': 0,
            }, result['report']['verification'])
            status = service.get_storage_safety_status()
            self.assertEqual('healthy', status['state'])
            self.assertEqual(result['report']['reportId'], status['reportId'])

    def test_invalid_integrity_checkpoint_requires_repair_and_cancellation_retains_latch(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.initialize()
            with open(service._integrity_checkpoint_path, 'w', encoding='utf-8') as output:
                json.dump({'scannerVersion': 999}, output)

            with self.assertRaises(StorageError):
                service.scan_media_integrity_page([], batch_size=1)
            self.assertEqual('repair_required', service.get_storage_safety_status()['state'])

            os.remove(service._integrity_checkpoint_path)
            cancelled = service.scan_media_integrity_page([], batch_size=1, cancelled=True)
            self.assertTrue(cancelled['cancelled'])
            self.assertNotEqual('healthy', service.get_storage_safety_status()['state'])

    def test_missing_media_report_does_not_reenable_physical_reclamation(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            missing = service.put_asset('media:missing', b'missing', 'image/png', 'media')
            os.remove(os.path.join(service.assets_dir, missing['relative_path']))

            result, _ = self.finish_integrity_scan(service, [])

            self.assertTrue(result['complete'])
            self.assertEqual({'missing_file'}, {item['damageClass'] for item in result['report']['damageItems']})
            self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])

    def test_concurrent_partition_change_is_replayed_before_report_publication(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.put_asset('media:first', b'first', 'image/png', 'media')
            first = service.scan_media_integrity_page([], batch_size=1)
            self.assertFalse(first['complete'])
            service.put_asset('media:second', b'second', 'image/png', 'media')

            replay = service.scan_media_integrity_page([], batch_size=100)
            while not replay['checkpoint']['rescanSet']:
                replay = service.scan_media_integrity_page([], batch_size=100)

            self.assertFalse(replay['complete'])
            self.assertIn('assets', replay['checkpoint']['rescanSet'])
            self.assertIsNone(service.get_media_integrity_report())

    def test_integrity_sources_return_only_the_requested_stable_page(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            for index in range(5):
                service.put_asset(f'media:{index}', str(index).encode(), 'image/png', 'media')

            first, cursor, done, _ = service._integrity_source_page('assets', 0, 2, [])
            second, next_cursor, second_done, _ = service._integrity_source_page('assets', cursor, 2, [])

            self.assertEqual(2, len(first))
            self.assertEqual(2, len(second))
            self.assertFalse(done)
            self.assertFalse(second_done)
            self.assertGreater(next_cursor, cursor)
            self.assertTrue(set(item['asset_key'] for item in first).isdisjoint(
                item['asset_key'] for item in second))

    def test_integrity_batch_size_adapts_to_page_cost(self):
        self.assertEqual(20, StorageService._next_integrity_batch_size(10, 0.001))
        self.assertEqual(5, StorageService._next_integrity_batch_size(10, 0.1))
        self.assertEqual(10, StorageService._next_integrity_batch_size(10, 0.02))

    def test_filesystem_change_after_validation_forces_a_rescan_before_publish(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            original_publish = service._publish_integrity_report
            inserted = False

            def publish(*args, **kwargs):
                nonlocal inserted
                if not inserted:
                    inserted = True
                    with open(os.path.join(service.assets_dir, 'late.bin'), 'wb') as output:
                        output.write(b'late')
                return original_publish(*args, **kwargs)

            service._publish_integrity_report = publish
            result, _ = self.finish_integrity_scan(service, [])

            self.assertTrue(inserted)
            self.assertIn('unregistered_file', {
                item['damageClass'] for item in result['report']['damageItems']})

    def test_changed_workflow_snapshot_is_replayed_before_publication(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:workflow-change', b'change', 'image/png', 'media')
            service.scan_media_integrity_page([], batch_size=1)
            workflow = {'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node-a', 'type': 'ImageGenerate', 'output': {'assetKey': asset['asset_key']},
            }]}

            result, repairs = self.finish_integrity_scan(service, [workflow], batch_size=1)

            self.assertEqual(1, repairs)
            self.assertEqual([], result['report']['damageItems'])

    def test_invalid_quarantine_state_keeps_the_published_report_guarded(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:quarantine', b'q', 'image/png', 'media')
            with service._connect() as database:
                database.execute('''INSERT INTO media_asset_quarantine(asset_key, state, quarantined_at)
                    VALUES(?, 'invalid', 1)''', (asset['asset_key'],))

            result, _ = self.finish_integrity_scan(service, [])

            self.assertFalse(result['report']['verification']['quarantineValid'])
            self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])

    def test_active_integrity_coordinator_lease_rejects_a_second_process(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.initialize()
            now = int(time.time() * 1000)
            with service._connect() as database:
                database.execute('''INSERT INTO media_integrity_coordinator(
                    singleton, coordinator_id, lease_token, lease_expires_at) VALUES(1, 'other', 'token', ?)''',
                    (now + 60000,))

            with self.assertRaises(StorageError):
                service.scan_media_integrity_page([], batch_size=1)
            self.assertNotEqual('healthy', service.get_storage_safety_status()['state'])

    def test_integrity_scan_repairs_a_proven_missing_formal_owner_then_rescans(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:owned', b'owned', 'image/png', 'media')
            workflow = {'workflowId': 'wf', 'mediaOwnershipRevision': 4, 'nodes': [{
                'id': 'node-a', 'type': 'ImageGenerate', 'output': {'assetKey': asset['asset_key']},
            }]}

            completed, repairs = self.finish_integrity_scan(service, [workflow])

            self.assertEqual(1, repairs)
            owner = service.get_media_owner_reference_list('wf', 'workflow-node', 'node-a')
            self.assertEqual([asset['asset_key']], owner['assetKeys'])
            self.assertTrue(completed['complete'])
            self.assertEqual([], completed['report']['damageItems'])
            self.assertEqual('healthy', service.get_storage_safety_status()['state'])

    def test_integrity_scan_never_repairs_a_missing_media_asset(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            workflow = {'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node-a', 'type': 'ImageGenerate', 'output': {'assetKey': 'media:absent'},
            }]}

            result, _ = self.finish_integrity_scan(service, [workflow])

            self.assertTrue(result['complete'])
            self.assertIn('missing_owner', {item['damageClass'] for item in result['report']['damageItems']})
            self.assertIsNone(service.get_media_owner_reference_list('wf', 'workflow-node', 'node-a'))

    def test_local_file_inspection_failure_becomes_damage_and_scan_continues(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            first = service.put_asset('media:first', b'first', 'image/png', 'media')
            second = service.put_asset('media:second', b'second', 'image/png', 'media')
            original = service._inspect_integrity_file

            def inspect(path):
                if path.endswith(first['relative_path'].replace('/', os.sep)):
                    raise OSError('simulated localized read failure')
                return original(path)

            service._inspect_integrity_file = inspect
            result, _ = self.finish_integrity_scan(service, [])

            self.assertTrue(result['complete'])
            classes = {item['damageClass'] for item in result['report']['damageItems']}
            self.assertIn('source_item_failure', classes)
            self.assertNotIn('missing_file', classes)
            self.assertIsNotNone(service.get_asset_info(second['asset_key']))

    def test_integrity_file_inspection_retries_a_transient_local_failure(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:retry', b'retry', 'image/png', 'media')
            path = os.path.join(service.assets_dir, asset['relative_path'])
            original = service._inspect_integrity_file
            calls = 0

            def inspect(candidate):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError('transient')
                return original(candidate)

            service._inspect_integrity_file = inspect
            result, _ = self.finish_integrity_scan(service, [])

            self.assertTrue(result['complete'])
            self.assertGreaterEqual(calls, 2)
            self.assertNotIn('source_item_failure', {
                item['damageClass'] for item in result['report']['damageItems']})

    def test_integrity_repair_preserves_an_existing_empty_owner_for_reconciliation(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:expected', b'expected', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node-a', 'assetKeys': [asset['asset_key']],
            }])
            with service._connect() as database:
                database.execute('''INSERT INTO media_asset_owners(
                    workflow_id, owner_type, owner_id, generation, document_revision, tombstoned, updated_at)
                    VALUES('wf', 'workflow-node', 'node-a', 3, 1, 0, 1)''')
            workflow = {'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': [{
                'id': 'node-a', 'type': 'ImageGenerate', 'output': {'assetKey': asset['asset_key']},
            }]}

            result, _ = self.finish_integrity_scan(service, [workflow])

            self.assertTrue(result['complete'])
            self.assertIn('missing_owner', {item['damageClass'] for item in result['report']['damageItems']})
            self.assertEqual(3, service.get_media_owner_reference_list(
                'wf', 'workflow-node', 'node-a')['generation'])

    def test_legacy_cleanup_keep_keys_is_audited_but_never_liveness_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:legacy', b'legacy', 'image/png', 'media')
            result = service.cleanup_assets('node-orphans', [asset['asset_key']])
            self.assertTrue(result['legacyKeepKeysIgnored'])
            self.assertEqual(1, result['legacyKeepKeysCount'])
            self.assertIsNotNone(service.get_asset_info(asset['asset_key']))

    def test_progressive_workflow_migration_resumes_by_global_cursor_and_never_guesses_identity(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:migrate', b'migrate', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']
            workflows = [
                {'name': 'legacy-without-id', 'nodes': [{'id': 'n0', 'output': {'assetKey': asset['asset_key']}}]},
                {'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'nodes': [{'id': 'n1', 'type': 'ImageGenerate', 'output': {'assetKey': asset['asset_key']}}]},
            ]
            service.create_media_migration_backup()
            first = service.migrate_legacy_media_workflows_page(workflows, epoch, batch_size=1)
            restarted = self.make_service(root, verified=False)
            second = restarted.migrate_legacy_media_workflows_page(workflows, epoch, batch_size=1)
            self.assertFalse(first['complete'])
            self.assertTrue(second['complete'])
            self.assertEqual(['wf'], second['migratedWorkflowIds'])
            self.assertEqual([asset['asset_key']], restarted.get_media_owner_reference_list('wf', 'workflow-node', 'n1')['assetKeys'])
            second_asset = restarted.put_asset('media:migrate-2', b'migrate-2', 'image/png', 'media')
            workflows[1]['mediaOwnershipRevision'] = 3
            workflows[1]['nodes'][0]['output']['assetKey'] = second_asset['asset_key']
            updated = restarted.migrate_legacy_media_workflows_page(workflows, epoch, batch_size=10)
            self.assertTrue(updated['complete'])
            self.assertEqual([second_asset['asset_key']], restarted.get_media_owner_reference_list('wf', 'workflow-node', 'n1')['assetKeys'])

    def test_verified_backup_binds_database_documents_and_media_hash_inventory(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.put_document('session', {'workflow': 'wf'})
            service.put_asset('media:backup', b'backup', 'image/png', 'media')
            backup = service.create_media_migration_backup()
            self.assertTrue(os.path.exists(backup['databasePath']))
            self.assertEqual(64, len(backup['databaseSha256']))
            self.assertEqual(64, len(backup['documentsSha256']))
            self.assertEqual(64, len(backup['mediaInventorySha256']))

    def test_quarantine_restore_never_overwrites_conflicting_content_and_breaker_is_durable(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:q', b'original', 'image/png', 'media')
            quarantined = service.quarantine_media_candidates([asset['asset_key']], reason='canary')
            path = os.path.join(service.assets_dir, asset['relative_path'])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as output:
                output.write(b'different')
            with self.assertRaises(StorageError):
                service.restore_quarantined_media(asset['asset_key'])
            self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])
            restarted = self.make_service(root, verified=False)
            self.assertEqual('quarantine_restore_conflict', restarted.get_storage_safety_status()['reason'])
            self.assertEqual(1, quarantined['quarantined'])

    def test_quarantine_and_audit_fault_points_fail_closed_with_recovery_evidence(self):
        for stage in ('quarantine_pending', 'quarantine_moved'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root, verified=False)
                asset = service.put_asset(f'media:{stage}', stage.encode(), 'image/png', 'media')
                service._transition_fault_injector = lambda current, target=stage: (
                    (_ for _ in ()).throw(RuntimeError('injected')) if current == target else None)
                with self.assertRaisesRegex(RuntimeError, 'injected'):
                    service.quarantine_media_candidates([asset['asset_key']])
                self.assertEqual('gc_suspended', service.get_storage_safety_status()['state'])
                if stage == 'quarantine_moved':
                    service._transition_fault_injector = lambda _stage: None
                    self.assertTrue(service.restore_quarantined_media(asset['asset_key'])['restored'])
                self.assertIsNotNone(service.get_asset(asset['asset_key']))

        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:audit-fault', b'audit', 'image/png', 'media')
            service.record_media_gc_candidate_provenance('wf', [asset['asset_key']])
            self.finish_integrity_scan(service, [])
            service._transition_fault_injector = lambda stage: (
                (_ for _ in ()).throw(RuntimeError('injected')) if stage == 'audit_recorded' else None)
            with self.assertRaises(StorageError):
                service.audit_media_gc_candidates(['wf'])
            self.assertEqual('media_gc_audit_failed', service.get_storage_safety_status()['reason'])

    def test_unregistered_files_enter_versioned_quarantine_without_being_released(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.initialize()
            path = os.path.join(service.assets_dir, 'legacy.bin')
            with open(path, 'wb') as output:
                output.write(b'legacy')
            result = service.quarantine_unregistered_media_files()
            self.assertEqual(1, result['quarantined'])
            self.assertFalse(os.path.exists(path))
            self.assertTrue(os.path.exists(result['items'][0]['quarantinePath']))
            self.assertGreater(result['items'][0]['releaseAfter'], result['items'][0]['quarantinedAt'])

    def test_gc_canary_requires_clean_observation_and_respects_count_and_byte_limits(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            service.put_asset('media:a', b'a', 'image/png', 'media')
            service.put_asset('media:b', b'bb', 'image/png', 'media')
            service.record_media_gc_candidate_provenance('wf', ['media:a', 'media:b'])
            result, _ = self.finish_integrity_scan(service, [])
            now = result['report']['completedAt'] + 8 * 24 * 60 * 60 * 1000
            service.set_meta('media_gc_observation_started_at', result['report']['completedAt'] - 8 * 24 * 60 * 60 * 1000)
            limited = service.run_media_gc_canary(['wf'], max_count=1, max_bytes=1, now_ms=now)
            self.assertTrue(limited['limitExceeded'])
            self.assertEqual(0, limited['quarantined'])
            moved = service.run_media_gc_canary(['wf'], max_count=2, max_bytes=3, now_ms=now)
            self.assertEqual(2, moved['quarantined'])

    def test_audit_only_starts_observation_without_moving_and_spike_opens_durable_breaker(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:audit', b'audit', 'image/png', 'media')
            service.record_media_gc_candidate_provenance('wf', [asset['asset_key']])
            self.finish_integrity_scan(service, [])
            audit = service.audit_media_gc_candidates(['wf'])
            self.assertEqual(1, audit['candidateCount'])
            self.assertTrue(os.path.exists(os.path.join(service.assets_dir, asset['relative_path'])))
            service.set_meta('media_gc_abnormal_candidate_threshold', 0)
            with self.assertRaises(StorageError):
                service.audit_media_gc_candidates(['wf'])
            restarted = self.make_service(root, verified=False)
            self.assertEqual('abnormal_candidate_spike', restarted.get_storage_safety_status()['reason'])

    def test_formal_authority_switch_advances_epoch_and_rejects_legacy_keep_keys(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            backup = service.create_media_migration_backup()
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.migrate_legacy_media_workflows_page([], epoch)
            self.finish_integrity_scan(service, [])
            switched = service.activate_formal_media_authority(backup['backupId'])
            self.assertNotEqual(epoch, switched['storageEpoch'])
            with self.assertRaises(StorageError):
                service.cleanup_assets('node-orphans', ['legacy-node'])
            orphan = service.put_asset('media:after-switch', b'orphan', 'image/png', 'media')
            retained = service.cleanup_unreferenced_media_assets()
            self.assertEqual(1, retained['candidatesRetained'])
            self.assertIsNotNone(service.get_asset_info(orphan['asset_key']))

            old_application = StorageService(
                service.database_path, service.assets_dir, service.temp_dir, service.exports_dir,
                supported_schema_version=9)
            with self.assertRaises(StorageError):
                old_application.put_document('session', {'old': 'writer'})
            with self.assertRaises(StorageError):
                old_application.put_media_asset(b'old', 'image/png', 'history', 'old')
            with self.assertRaises(StorageError):
                old_application.put_media_asset_list(['data:image/png;base64,b2xk'], 'workflow-operation', '["wf","n","op"]')
            legacy_connection = sqlite3.connect(service.database_path)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    legacy_connection.execute("INSERT INTO documents VALUES('session', '{}', 1)")
                with self.assertRaises(sqlite3.OperationalError):
                    legacy_connection.execute("DELETE FROM assets WHERE asset_key='media:after-switch'")
            finally:
                legacy_connection.close()

    def test_workflow_release_records_gc_canary_provenance_in_production_path(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:released', b'released', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node-a', 'assetKeys': [asset['asset_key']]}])
            service.replace_media_owner_references(
                workflow_id='wf', owner_type='workflow-node', owner_id='node-a', operation_id='op',
                intent='save', idempotency_key='key', expected_generation=0,
                document_revision=1, storage_epoch=epoch, asset_keys=[asset['asset_key']])
            service.release_workflow_media_references('wf')
            with service._connect() as database:
                row = database.execute('''SELECT workflow_id FROM media_gc_candidate_provenance
                    WHERE asset_key=?''', (asset['asset_key'],)).fetchone()
            self.assertEqual('wf', row['workflow_id'])

    def test_node_reference_replacement_records_gc_canary_provenance(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            old = service.put_asset('media:old', b'old', 'image/png', 'media')
            new = service.put_asset('media:new', b'new', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node-a', 'assetKeys': [old['asset_key']]}])
            service.replace_media_owner_references(workflow_id='wf', owner_type='workflow-node', owner_id='node-a',
                operation_id='one', idempotency_key='one', expected_generation=0, document_revision=1,
                storage_epoch=epoch, asset_keys=[old['asset_key']])
            service.record_media_workflow_revision('wf', 2, epoch, [{
                'ownerType': 'workflow-node', 'ownerId': 'node-a', 'assetKeys': [new['asset_key']]}])
            service.replace_media_owner_references(workflow_id='wf', owner_type='workflow-node', owner_id='node-a',
                operation_id='two', idempotency_key='two', expected_generation=1, document_revision=2,
                storage_epoch=epoch, asset_keys=[new['asset_key']])
            with service._connect() as database:
                row = database.execute('''SELECT workflow_id FROM media_gc_candidate_provenance
                    WHERE asset_key=?''', (old['asset_key'],)).fetchone()
            self.assertEqual('wf', row['workflow_id'])

    def test_undo_reownership_removes_stale_gc_candidate_provenance(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root, verified=False)
            asset = service.put_asset('media:undo', b'undo', 'image/png', 'media')
            epoch = service.get_storage_safety_status()['storageEpoch']

            def transition(revision, intent, keys):
                service.record_media_workflow_revision('wf', revision, epoch, [{
                    'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': keys}])
                return service.replace_media_owner_references(
                    workflow_id='wf', owner_type='workflow-node', owner_id='node',
                    operation_id=str(revision), idempotency_key=str(revision), intent=intent,
                    expected_generation=revision - 1, document_revision=revision,
                    storage_epoch=epoch, asset_keys=keys)

            transition(1, 'save', [asset['asset_key']])
            transition(2, 'delete', [])
            transition(3, 'undo', [asset['asset_key']])
            with service._connect() as database:
                candidate = database.execute(
                    'SELECT 1 FROM media_gc_candidate_provenance WHERE asset_key=?',
                    (asset['asset_key'],)).fetchone()
            self.assertIsNone(candidate)


if __name__ == '__main__':
    unittest.main()
