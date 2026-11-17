import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from backend import desktop_security
from backend.handler import ProxyHTTPRequestHandler
from backend.routes import storage_routes
from backend.routes.storage_routes import _is_authorized_local_request
from backend.services.storage_service import StorageDocumentConflict, StorageService


def make_handler(client='127.0.0.1', origin='http://127.0.0.1:8767'):
    return SimpleNamespace(client_address=(client, 50000), headers={'Origin': origin})


class StorageRouteSecurityTests(unittest.TestCase):
    def test_asset_head_checks_readable_file_with_the_same_desktop_and_origin_guards(self):
        def probe(*, cookie='', origin='', client='127.0.0.1'):
            handler = ProxyHTTPRequestHandler.__new__(ProxyHTTPRequestHandler)
            handler.command = 'HEAD'
            handler.path = '/api/storage/assets/media%3Aexport'
            handler.client_address = (client, 50000)
            handler.headers = {'Cookie': cookie, 'Origin': origin}
            handler.wfile = io.BytesIO()
            handler.send_response = mock.Mock()
            handler.send_header = mock.Mock()
            handler.end_headers = mock.Mock()
            handler._begin_request_log = mock.Mock()
            handler.do_HEAD()
            self.assertEqual(handler.wfile.getvalue(), b'')
            return handler.send_response.call_args.args[0], dict(
                call.args for call in handler.send_header.call_args_list
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service = StorageService(database_path=root / 'test.db', assets_dir=root / 'assets',
                                     temp_dir=root / 'tmp', exports_dir=root / 'exports')
            original = b'original asset'
            asset = service.put_asset('media:export', original, 'image/webp')
            with mock.patch.object(storage_routes, 'storage_service', service), \
                    mock.patch.object(desktop_security, '_session_token', 'test-session'):
                cookie = 'cainflow_desktop_session=test-session'
                self.assertEqual(probe()[0], 403)
                self.assertEqual(probe(cookie=cookie, origin='https://example.invalid')[0], 403)
                self.assertEqual(probe(cookie=cookie, client='192.168.1.10')[0], 403)
                status, headers = probe(cookie=cookie)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Content-Type'], 'image/webp')
                self.assertEqual(headers['Content-Length'], str(len(original)))
                self.assertEqual(headers['Cache-Control'], 'no-store')
                (root / 'assets' / asset['relative_path']).unlink()
                self.assertIsNotNone(service.get_asset_info('media:export'))
                self.assertEqual(probe(cookie=cookie)[0], 404)

    def test_prompt_library_conflict_requests_a_fresh_document_instead_of_overwriting(self):
        handler = make_handler()
        handler.path = '/api/storage/documents/prompt_library'
        request = {'value': [], 'expectedUpdatedAt': 12}
        with mock.patch.object(storage_routes, 'read_json_body', return_value=request), \
                mock.patch.object(storage_routes.storage_service, 'assert_storage_writable'), \
                mock.patch.object(storage_routes.storage_service, 'put_document',
                                  side_effect=StorageDocumentConflict('The prompt library changed')) as put, \
                mock.patch.object(storage_routes, 'write_error') as error:
            self.assertTrue(storage_routes.handle_put(handler))
            put.assert_called_once_with('prompt_library', [], expected_updated_at=12)
            error.assert_called_once_with(handler, 409, 'The prompt library changed')

    def test_directory_thumbnail_request_reads_the_requested_version(self):
        handler = make_handler()
        handler.path = '/api/storage/library/-8/thumbnail?v=4%3A123'
        with mock.patch.object(storage_routes, 'MediaLibrary') as library, \
                mock.patch.object(storage_routes, 'write_bytes') as write_bytes:
            library.return_value.read_thumbnail.return_value = ('image/webp', b'thumbnail')
            self.assertTrue(storage_routes.handle_get(handler))
            library.return_value.read_thumbnail.assert_called_once_with(-8, '4:123')
            write_bytes.assert_called_once_with(handler, b'thumbnail', content_type='image/webp', headers={'Cache-Control': 'no-store'})

    def test_history_image_tool_errors_do_not_expose_directory_paths(self):
        handler = make_handler()
        handler.path = '/api/storage/library?imagesOnly=1&limit=1'
        private_error = PermissionError(13, 'Permission denied', 'private/directory/history.png')
        with (
            mock.patch.object(storage_routes, 'MediaLibrary') as library,
            mock.patch.object(storage_routes, 'write_error') as error,
        ):
            library.return_value.list_page.side_effect = private_error
            self.assertTrue(storage_routes.handle_get(handler))
            error.assert_called_once_with(handler, 400, '读取历史图片失败，请检查 CainFlow 的保存目录')

        handler.path = '/api/storage/library/123/note'
        handler.headers['Content-Length'] = '100'
        with (
            mock.patch.object(storage_routes, 'MediaLibrary') as library,
            mock.patch.object(storage_routes.storage_service, 'assert_storage_writable'),
            mock.patch.object(storage_routes, 'read_json_body', return_value={'note': '备注', 'fileVersion': '1:123'}),
            mock.patch.object(storage_routes, 'write_error') as error,
        ):
            library.return_value.set_note.side_effect = private_error
            self.assertTrue(storage_routes.handle_post(handler))
            error.assert_called_once_with(handler, 400, '无法保存历史图片备注，请检查 CainFlow 的保存目录')

    def test_integrity_report_endpoint_returns_the_published_report(self):
        handler = make_handler()
        handler.path = '/api/storage/integrity-report'
        report = {'reportId': 'report-a', 'damageItems': []}
        with mock.patch.object(storage_routes.storage_service, 'get_media_integrity_report', return_value=report), \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_get(handler))

        write_json.assert_called_once_with(handler, {'report': report}, status=200)

    def test_integrity_scan_endpoint_advances_one_bounded_page(self):
        handler = make_handler()
        handler.path = '/api/storage/maintenance'
        request = {'action': 'scan-media-integrity', 'workflows': [{'workflowId': 'workflow-a'}], 'batchSize': 17}
        result = {'complete': False, 'cancelled': False, 'checkpoint': {'cursor': 17}}
        with mock.patch.object(storage_routes, 'read_json_body', return_value=request), \
                mock.patch.object(storage_routes.storage_service, 'scan_media_integrity_page', return_value=result) as scan, \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_post(handler))

        scan.assert_called_once_with(request['workflows'], 17, cancelled=False)
        write_json.assert_called_once_with(handler, {'success': True, **result})

    def test_operation_owner_cancellation_maps_the_stable_owner_identity(self):
        handler = make_handler()
        handler.path = '/api/storage/media-assets'
        request = {
            'action': 'cancel-operation-owner',
            'ownerId': '["workflow-a","node-a","operation-a"]',
        }
        result = {'cancelled': True, 'workflowId': 'workflow-a'}
        with mock.patch.object(storage_routes, 'read_json_body', return_value=request), \
                mock.patch.object(storage_routes.storage_service, 'cancel_media_operation_owner', return_value=result) as cancel, \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_post(handler))

        cancel.assert_called_once_with(request['ownerId'])
        write_json.assert_called_once_with(handler, {'success': True, **result})

    def test_operation_owner_list_materialization_maps_one_atomic_request(self):
        handler = make_handler()
        handler.path = '/api/storage/media-assets'
        request = {
            'action': 'materialize-owner-list', 'ownerType': 'workflow-operation',
            'ownerId': 'workflow:node:operation', 'values': ['data:image/png;base64,aGVsbG8='],
        }
        assets = [{'asset_key': 'media:first'}]
        with mock.patch.object(storage_routes, 'read_json_body', return_value=request), \
                mock.patch.object(storage_routes.storage_service, 'put_media_asset_list', return_value=assets) as put, \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_post(handler))
        put.assert_called_once_with(request['values'], 'workflow-operation', 'workflow:node:operation')
        write_json.assert_called_once_with(handler, {'success': True, 'assets': assets})

    def test_accepts_local_origin_and_local_cli_without_origin(self):
        self.assertTrue(_is_authorized_local_request(make_handler()))
        self.assertTrue(_is_authorized_local_request(make_handler(origin='')))
        self.assertTrue(_is_authorized_local_request(make_handler('::1', 'http://localhost:8767')))

    def test_rejects_lan_client_or_wrong_origin(self):
        self.assertFalse(_is_authorized_local_request(make_handler('192.168.1.10')))
        self.assertFalse(_is_authorized_local_request(make_handler(origin='http://127.0.0.1:9999')))
        self.assertFalse(_is_authorized_local_request(make_handler(origin='https://example.com')))

    def test_safety_status_endpoint_is_read_only_and_returns_redacted_state(self):
        handler = make_handler()
        handler.path = '/api/storage/safety-status'
        status = {
            'storageIdentity': 'digest', 'storageModeVersion': 1, 'storageEpoch': 'epoch',
            'state': 'healthy', 'reason': 'verified', 'detectedAt': 123,
            'reportVersion': 1, 'recoveryConditions': [],
        }
        with mock.patch.object(storage_routes.storage_service, 'get_storage_safety_status', return_value=status), \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_get(handler))

        write_json.assert_called_once_with(handler, {'safety': status})

    def test_owner_reference_list_replacement_maps_the_versioned_request_without_media_content(self):
        handler = make_handler()
        handler.path = '/api/storage/media-assets'
        request = {
            'action': 'replace-owner-reference-list',
            'workflowId': 'workflow-a', 'ownerType': 'workflow-node', 'ownerId': 'node-a',
            'operationId': 'operation-a', 'idempotencyKey': 'stable-key',
            'intent': 'save',
            'expectedGeneration': 2, 'documentRevision': 9, 'storageEpoch': 'epoch-a',
            'assetKeys': ['media:first', 'media:second'], 'cancelled': False,
        }
        result = {'status': 'committed', 'generation': 3}
        with mock.patch.object(storage_routes, 'read_json_body', return_value=request), \
                mock.patch.object(storage_routes.storage_service, 'replace_media_owner_references', return_value=result) as replace, \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_post(handler))

        replace.assert_called_once_with(
            workflow_id='workflow-a', owner_type='workflow-node', owner_id='node-a',
            operation_id='operation-a', idempotency_key='stable-key', expected_generation=2,
            intent='save',
            document_revision=9, storage_epoch='epoch-a', asset_keys=['media:first', 'media:second'],
            cancelled=False,
        )
        write_json.assert_called_once_with(handler, {'success': True, **result})

    def test_owner_reference_list_endpoint_returns_the_current_generation(self):
        handler = make_handler()
        handler.path = '/api/storage/media-owner?workflowId=workflow-a&ownerType=workflow-node&ownerId=node-a'
        owner = {'workflowId': 'workflow-a', 'generation': 3, 'assetKeys': ['media:first']}
        with mock.patch.object(storage_routes.storage_service, 'get_media_owner_reference_list', return_value=owner) as get_owner, \
                mock.patch.object(storage_routes, 'write_json') as write_json:
            self.assertTrue(storage_routes.handle_get(handler))

        get_owner.assert_called_once_with('workflow-a', 'workflow-node', 'node-a')
        write_json.assert_called_once_with(handler, {'owner': owner})


if __name__ == '__main__':
    unittest.main()
