import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.services import database_compaction
from tests import test_deleted_node_media as deleted_node_tests
from tests import test_runtime_cache as runtime_tests


class DatabaseCompactionTests(unittest.TestCase):
    def make_service(self, root):
        return runtime_tests.RuntimeCacheTests().make_service(root)

    def free_pages(self, service, size=2 * 1024 * 1024):
        service.put_document('logs_state', {'text': 'x' * size})
        service.put_document('logs_state', {'text': 'retained'})
        with service._connect() as db:
            self.assertGreater(db.execute('PRAGMA freelist_count').fetchone()[0], 0)

    def logical_rows(self, service):
        with service._connect() as db:
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")]
            return {table: sorted([tuple(row) for row in db.execute(
                'SELECT * FROM "' + table.replace('"', '""') + '"')], key=repr) for table in tables}

    def test_clearing_history_reclaims_database_file_space(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'history-image', 'image/png', 'history', '1')
            service.save_history({'id': 1, 'imageAssetKey': asset['asset_key'], 'prompt': 'x' * (2 * 1024 * 1024)})
            before = os.path.getsize(service.database_path)
            self.assertGreater(before, 2 * 1024 * 1024)

            result = service.clear_history()

            self.assertEqual(1, result['historyDeleted'])
            self.assertEqual([], service.list_history())
            self.assertLess(os.path.getsize(service.database_path), before // 2,
                            'History was cleared, but the database file still contains its empty pages')
            self.assertEqual('completed', result['databaseCompaction']['status'])
            self.assertGreater(result['databaseCompaction']['reclaimedBytes'], 1024 * 1024)

    def test_asset_and_temporary_cleanup_also_compact_existing_free_pages(self):
        for action in ['assets', 'temporary']:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root)
                self.free_pages(service)
                before = os.path.getsize(service.database_path)
                result = service.cleanup_assets('node-orphans') if action == 'assets' else service.clear_temporary()
                self.assertEqual('completed', result['databaseCompaction']['status'])
                self.assertLess(os.path.getsize(service.database_path), before // 2)
                self.assertEqual({'text': 'retained'}, service.get_document('logs_state')['value'])

    def test_compaction_preserves_all_rows_other_workflows_and_agent_history_across_restart(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            images = {name: service.put_media_asset(name.encode(), 'image/png', 'workflow-node', 'other:node')['asset_key']
                      for name in ['other-workflow', 'agent-message', 'agent-archive']}
            workflow = {'workflowId': 'other', 'mediaOwnershipRevision': 1,
                'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [images['other-workflow']]}],
                'promptAgent': {
                    'messages': [{'runs': [{'runId': 'message', 'mediaAssetKeys': [images['agent-message']]}]}],
                    'archivedMessages': [{'runs': [{'runId': 'archive', 'mediaAssetKeys': [images['agent-archive']]}]}]}}
            deleted_node_tests.DeletedNodeMediaTests().save_and_commit(service, root, workflow)
            session = {'workflowTabs': [{'workflowId': 'other', 'data': workflow}], 'activeWorkflowId': 'other'}
            service.put_document('session', session)
            self.free_pages(service)
            rows = self.logical_rows(service)
            workflow_file = Path(root, 'workflows', 'other.json')
            workflow_bytes = workflow_file.read_bytes()

            self.assertEqual('completed', service.compact_database()['status'])

            self.assertEqual(rows, self.logical_rows(service), 'Physical compaction changed logical database records')
            self.assertEqual(workflow_bytes, workflow_file.read_bytes())
            with service._connect() as db:
                self.assertEqual('ok', db.execute('PRAGMA integrity_check').fetchone()[0])
                self.assertEqual([], db.execute('PRAGMA foreign_key_check').fetchall())
                self.assertEqual('wal', db.execute('PRAGMA journal_mode').fetchone()[0])
                self.assertEqual('normal', db.execute('PRAGMA locking_mode').fetchone()[0])
            service.mark_clean_shutdown()
            restarted = self.make_service(root)
            self.assertEqual(session, restarted.get_document('session')['value'])
            for name, key in images.items():
                self.assertEqual(name.encode(), restarted.get_asset(key)[1])
            for run, name in [('message', 'agent-message'), ('archive', 'agent-archive')]:
                self.assertEqual([images[name]], restarted.get_media_owner_reference_list(
                    'other', 'prompt-agent-result', run)['assetKeys'])

    def test_background_maintenance_compacts_large_free_space_and_skips_small_changes(self):
        for size, retained_size, status in [(64 * 1024, 0, 'skipped'),
                                           (2 * 1024 * 1024, 0, 'completed'),
                                           (2 * 1024 * 1024, 16 * 1024 * 1024, 'skipped')]:
            with self.subTest(size=size, retained_size=retained_size), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root)
                if retained_size:
                    service.put_document('prompt_library', {'text': 'y' * retained_size})
                self.free_pages(service, size)
                before = os.path.getsize(service.database_path)
                result = service.run_cache_maintenance()['databaseCompaction']
                self.assertEqual(status, result['status'])
                if status == 'skipped':
                    self.assertEqual('below-threshold', result['reason'])
                    self.assertEqual(before, os.path.getsize(service.database_path))
                else:
                    self.assertLess(os.path.getsize(service.database_path), before // 2)
                    self.assertEqual('no-free-pages', service.compact_database()['reason'])

    def test_readers_and_writers_defer_compaction_and_retry_without_losing_data(self):
        for transaction in ['BEGIN', 'BEGIN IMMEDIATE']:
            with self.subTest(transaction=transaction), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root)
                self.free_pages(service, 64 * 1024)
                connection = sqlite3.connect(service.database_path)
                try:
                    connection.execute(transaction)
                    connection.execute('SELECT * FROM documents').fetchall()
                    if transaction == 'BEGIN IMMEDIATE':
                        connection.execute("INSERT INTO meta(key, value) VALUES('concurrent-write', 'retained')")
                    before = time.monotonic()
                    result = service.compact_database()
                    self.assertEqual('deferred', result['status'])
                    self.assertEqual('busy', result['reason'])
                    self.assertLess(time.monotonic() - before, 1)
                    connection.commit()
                finally:
                    connection.close()
                # A deferred explicit cleanup retries even below the background threshold.
                result = service.run_cache_maintenance()['databaseCompaction']
                self.assertEqual('completed', result['status'])
                self.assertEqual({'text': 'retained'}, service.get_document('logs_state')['value'])
                if transaction == 'BEGIN IMMEDIATE':
                    self.assertEqual('retained', service.get_meta('concurrent-write'))

    def test_low_disk_defers_but_does_not_fail_cleanup_and_later_retries(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            self.free_pages(service, 64 * 1024)
            with mock.patch.object(database_compaction.shutil, 'disk_usage', return_value=mock.Mock(free=0)):
                result = service.clear_history()
            self.assertEqual(0, result['historyDeleted'])
            self.assertEqual('insufficient-space', result['databaseCompaction']['reason'])
            self.assertEqual('completed', service.run_cache_maintenance()['databaseCompaction']['status'])

    def test_native_vacuum_interrupt_rolls_back_and_releases_all_locks(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            self.free_pages(service)
            with service._connect() as db:
                db.executemany('INSERT INTO meta(key, value) VALUES(?, ?)',
                               [(f'preserved-{index}', 'value') for index in range(1024)])
            rows = self.logical_rows(service)
            with mock.patch.object(database_compaction, 'MAX_COMPACTION_SECONDS', 0):
                result = service.compact_database()
            self.assertEqual('deferred', result['status'])
            self.assertEqual('time-budget', result['reason'])
            self.assertEqual(rows, self.logical_rows(service))
            self.assertEqual('completed', service.compact_database()['status'])
            service.put_document('prompt_library', {'afterInterrupt': 'writable'})
            self.assertEqual({'afterInterrupt': 'writable'}, service.get_document('prompt_library')['value'])

    def test_storage_guard_and_durable_scan_cursor_block_compaction(self):
        for blocked_by in ['persisted-safety', 'background-scan', 'checkpoint', 'lease', 'schema']:
            with self.subTest(blocked_by=blocked_by), tempfile.TemporaryDirectory() as root:
                service = self.make_service(root)
                self.free_pages(service)
                token = None
                if blocked_by == 'persisted-safety':
                    service._write_safety_status({**service._safety_status, 'state': 'gc_suspended'})
                elif blocked_by == 'background-scan':
                    service.set_background_scan_pending(True)
                elif blocked_by == 'checkpoint':
                    Path(service._integrity_checkpoint_path).write_text('{"cursor": 123}', encoding='utf-8')
                elif blocked_by == 'lease':
                    token = service._claim_integrity_scan()
                else:
                    service.set_meta('schema_version', service._supported_schema_version + 1)
                rows = self.logical_rows(service)
                before = os.path.getsize(service.database_path)
                try:
                    result = service.compact_database()
                    self.assertEqual('deferred', result['status'])
                    self.assertEqual(before, os.path.getsize(service.database_path))
                    self.assertEqual(rows, self.logical_rows(service))
                    if blocked_by == 'checkpoint':
                        self.assertEqual({'cursor': 123}, json.loads(Path(service._integrity_checkpoint_path).read_text()))
                finally:
                    if token:
                        service._release_integrity_scan(token)

    def test_real_sqlite_error_does_not_turn_successful_cleanup_into_failure(self):
        class FullDiskConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == 'VACUUM':
                    error = sqlite3.OperationalError('controlled disk full')
                    error.sqlite_errorcode = sqlite3.SQLITE_FULL
                    raise error
                return super().execute(sql, *args)

        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'history', 'image/png', 'history', '1')
            service.save_history({'id': 1, 'imageAssetKey': asset['asset_key'], 'prompt': 'x' * (2 * 1024 * 1024)})
            session = {'workflowTabs': [{'workflowId': 'other', 'data': {'nodes': [], 'promptAgent': {'draftText': 'keep'}}}]}
            service.put_document('session', session)
            with mock.patch.object(database_compaction, '_open_database', side_effect=lambda path: sqlite3.connect(
                    path, isolation_level=None, factory=FullDiskConnection)):
                result = service.clear_history()
            self.assertEqual(1, result['historyDeleted'])
            self.assertEqual([], service.list_history())
            self.assertEqual('deferred', result['databaseCompaction']['status'])
            self.assertEqual('insufficient-space', result['databaseCompaction']['reason'])
            self.assertEqual(session, service.get_document('session')['value'])
            self.assertEqual('completed', service.run_cache_maintenance()['databaseCompaction']['status'])

    def test_compaction_and_later_writer_serialize_without_overwriting_new_data(self):
        entered, finish_vacuum, writer_started, writer_finished = (threading.Event() for _ in range(4))
        failures, results = [], []

        class PausedConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == 'VACUUM':
                    entered.set()
                    if not finish_vacuum.wait(2):
                        raise AssertionError('Timed out waiting for the concurrent writer')
                return super().execute(sql, *args)

        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            self.free_pages(service)

            def compact():
                try:
                    results.append(service.compact_database())
                except Exception as error:
                    failures.append(error)

            def write():
                writer_started.set()
                connection = None
                try:
                    # An independent connection models another consumer/process.
                    connection = sqlite3.connect(service.database_path, timeout=5)
                    with connection as db:
                        db.execute("INSERT INTO meta(key, value) VALUES('concurrent-save', 'new-data')")
                except Exception as error:
                    failures.append(error)
                finally:
                    if connection is not None:
                        connection.close()
                    writer_finished.set()

            compact_thread = threading.Thread(target=compact)
            writer_thread = threading.Thread(target=write)
            with mock.patch.object(database_compaction, '_open_database', side_effect=lambda path: sqlite3.connect(
                    path, isolation_level=None, factory=PausedConnection)):
                try:
                    compact_thread.start()
                    self.assertTrue(entered.wait(2))
                    writer_thread.start()
                    self.assertTrue(writer_started.wait(1))
                    self.assertFalse(writer_finished.wait(0.05))
                    # A second action must not enter compaction while the first holds the service lock.
                    self.assertEqual('busy', service.compact_database()['reason'])
                finally:
                    finish_vacuum.set()
                    compact_thread.join(3)
                    if writer_thread.ident is not None:
                        writer_thread.join(3)
            self.assertFalse(compact_thread.is_alive())
            self.assertFalse(writer_thread.is_alive())
            self.assertEqual([], failures)
            self.assertEqual('completed', results[0]['status'])
            self.assertEqual('new-data', service.get_meta('concurrent-save'))


if __name__ == '__main__':
    unittest.main()
