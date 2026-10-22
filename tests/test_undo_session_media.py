import tempfile
import unittest
import types
from unittest import mock

from tests import test_runtime_cache as runtime_tests
from backend.services.desktop_bridge import DesktopBridge


class UndoSessionMediaTests(unittest.TestCase):
    def test_native_close_waits_for_frontend_acknowledgement(self):
        class Event:
            def __iadd__(self, callback):
                self.callback = callback
                return self
        event = Event()
        window = mock.Mock(events=types.SimpleNamespace(closing=event))
        bridge = DesktopBridge('test', mock.Mock(), taskbar_service=mock.Mock())
        bridge.attach_window(window)
        with mock.patch('backend.services.desktop_bridge.threading.Thread') as thread:
            self.assertFalse(event.callback())
            thread.call_args.kwargs['target']()
        window.destroy.assert_not_called()
        self.assertIn('cainflowPrepareExit', window.evaluate_js.call_args.args[0])
        bridge.finish_close()
        window.destroy.assert_called_once()
        self.assertTrue(event.callback())

    def test_protection_survives_cleanup_and_page_end_is_isolated(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            service.put_asset('media:undo', b'original', 'image/png', 'media')
            for page in ['a', 'b']:
                service.undo_media_request({'action': 'protect', 'pageId': page, 'recordId': 'record', 'assetKeys': ['media:undo']})
            service.release_legacy_undo_media_references()
            service.cleanup_unreferenced_media_assets()
            self.assertIsNotNone(service.get_asset('media:undo'))
            self.assertEqual(1, service.undo_media_status()['protectedCount'])
            service.undo_media_request({'action': 'end', 'pageId': 'a'})
            self.assertIsNotNone(service.get_asset('media:undo'))
            result = service.undo_media_request({'action': 'end', 'pageId': 'b'})
            self.assertEqual(1, result['assetsDeleted'])
            self.assertIsNone(service.get_asset('media:undo'))
            self.assertEqual(0, service.undo_media_request({'action': 'end', 'pageId': 'b'})['referencesReleased'])
            with self.assertRaisesRegex(ValueError, 'ended'):
                service.undo_media_request({'action': 'protect', 'pageId': 'b', 'recordId': 'late', 'assetKeys': []})

    def test_shared_workflow_and_agent_results_are_not_deleted(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            for owner in ['workflow-node', 'prompt-agent-result']:
                asset = service.put_media_asset(owner.encode(), 'image/png', owner, 'other:result')
                service.undo_media_request({'action': 'protect', 'pageId': 'a', 'recordId': owner, 'assetKeys': [asset['asset_key']]})
            result = service.recover_undo_sessions(ending=True)
            self.assertEqual(2, result['referencesReleased'])
            self.assertEqual(0, result['assetsDeleted'])
            self.assertEqual(2, len(service.get_stats()['mediaReferenceDistribution']))

    def test_dead_runtime_recovery_and_deferred_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            service.put_asset('media:old', b'old', 'image/png', 'media')
            service.undo_media_request({'action': 'protect', 'pageId': 'old', 'recordId': 'r', 'assetKeys': ['media:old']})
            service._undo_runtime_id = 'new-runtime'
            with mock.patch('backend.services.undo_media.process_has_exited', return_value=False):
                self.assertEqual(0, service.recover_undo_sessions()['referencesReleased'])
            with mock.patch('backend.services.undo_media.process_has_exited', return_value=True), mock.patch.object(service, '_cache_reclamation_verified', return_value=False):
                result = service.recover_undo_sessions()
                self.assertEqual(1, result['referencesReleased'])
                self.assertEqual(1, result['pendingCount'])
                self.assertIsNotNone(service.get_asset('media:old'))
            self.assertEqual(1, service.cleanup_undo_candidates()['assetsDeleted'])

    def test_failed_release_retries_and_missing_original_is_reported(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            service.put_asset('media:x', b'x', 'image/png', 'media')
            result = service.undo_media_request({'action': 'protect', 'pageId': 'a', 'recordId': 'r', 'assetKeys': ['media:x', 'media:missing']})
            self.assertEqual(['media:missing'], result['missing'])
            with mock.patch.object(service, 'delete_asset', side_effect=OSError('locked')):
                result = service.undo_media_request({'action': 'release', 'pageId': 'a', 'recordIds': ['r']})
                self.assertEqual(['cleanup-failed-retry'], result['pendingReasons'])
            self.assertEqual(1, service.cleanup_undo_candidates()['assetsDeleted'])
