import json
import io
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode
from backend import desktop_security
from backend.routes.storage_routes import handle_get

from backend.services.file_import import FileImportError, FileImports
from backend.services.log_service import finalize_request_log, set_request_body, set_response_data, start_request_log
from backend.webview2_runtime import WebView2InitializationResult, install_webview2_initialization_hook


class FileImportTests(unittest.TestCase):
    def test_file_reads_and_private_proxy_requests_log_metadata_only(self):
        for path, headers in [
            ('/api/storage/file-imports/text?referenceId=private-scope', {}),
            ('/proxy', {'X-Cainflow-Private-Input': '1'}),
        ]:
            with self.subTest(path=path), patch('backend.services.log_service._append_log_line') as write_log:
                handler = SimpleNamespace(path=path, headers=headers, command='GET', client_address=('127.0.0.1', 0))
                start_request_log(handler)
                body = b'{"text":"private-original"}'
                set_request_body(handler, body, content_type='application/json')
                set_response_data(handler, status=200, body=body, content_type='application/json', total_bytes=len(body))
                finalize_request_log(handler)
                entry = write_log.call_args.args[0]
                self.assertEqual(entry['response']['status'], 200)
                self.assertNotIn('private-original', json.dumps(entry))
                self.assertNotIn('private-scope', json.dumps(entry))

    def test_registered_markdown_is_read_from_its_original_and_scoped_to_the_node(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / '需求.md'
            original.write_text('# Version one', encoding='utf-8')
            private_data = root / 'app-data'
            imported = FileImports(private_data).register('workflow-a', 'file-node', original)
            self.assertEqual(imported['name'], '需求.md')
            self.assertNotIn('path', imported)
            original.write_text('# Version two', encoding='utf-8')

            registry = FileImports(private_data)
            self.assertEqual(registry.read_text('workflow-a', 'file-node', imported['id']), '# Version two')
            with patch('backend.services.file_import.os.startfile', create=True) as open_file:
                self.assertTrue(registry.open_original('workflow-a', 'file-node', imported['id']))
                open_file.assert_called_once_with(original)
            for scope in [('workflow-b', 'file-node'), ('workflow-a', 'other-node')]:
                with self.assertRaises(FileImportError):
                    registry.read_text(*scope, imported['id'])
            self.assertEqual([path.name for path in private_data.iterdir()], ['file-imports.db'])
            original.unlink()
            with self.assertRaisesRegex(FileImportError, '找不到原文件'):
                registry.read_text('workflow-a', 'file-node', imported['id'])

    def test_reads_bom_encoded_text(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / 'note.txt'
            original.write_bytes('简体中文'.encode('utf-16'))
            registry = FileImports(root / 'app-data')
            imported = registry.register('workflow', 'node', original)
            self.assertEqual(registry.read_text('workflow', 'node', imported['id']), '简体中文')

    @unittest.skipUnless(os.name == 'nt', 'Windows sharing violation')
    def test_windows_exclusive_handle_reports_busy_and_recovers(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / 'report.txt'
            original.write_text('source')
            registry = FileImports(root / 'app-data')
            reference = registry.register('workflow', 'node', original)
            scope = ('workflow', 'node', reference['id'])
            handle = kernel.CreateFileW(str(original), 0x80000000, 0, None, 3, 0x80, None)
            self.assertNotEqual(handle, wintypes.HANDLE(-1).value)
            try:
                with self.assertRaises(FileImportError) as got:
                    registry.info(*scope)
                self.assertEqual(got.exception.code, 'busy')
            finally:
                kernel.CloseHandle(handle)
            with patch('backend.services.file_import._open_original_bytes', side_effect=PermissionError('Access is denied')):
                with self.assertRaises(FileImportError) as got:
                    registry.info(*scope)
                self.assertEqual(got.exception.code, 'denied')
            self.assertEqual(registry.read_text(*scope), 'source')

    def test_typed_originals_only_store_references_and_reject_changed_versions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            registry = FileImports(root / 'app-data')
            for name, kind, mime in [
                ('example.png', 'image', 'image/png'), ('example.mp4', 'video', 'video/mp4'),
                ('example.pdf', 'file', 'application/pdf'),
            ]:
                original = root / name
                original.write_bytes(b'original bytes')
                reference = registry.register('workflow', name, original)
                self.assertEqual((reference['kind'], reference['mime']), (kind, mime))
                self.assertNotIn('path', reference)
                with registry.open_content('workflow', name, reference['id'], reference['version']) as (stream, info):
                    self.assertEqual(stream.read(), b'original bytes')
                    self.assertEqual(info['size'], 14)
                original.write_bytes(b'changed')
                with self.assertRaisesRegex(FileImportError, '变更'):
                    with registry.open_content('workflow', name, reference['id'], reference['version']):
                        pass
            self.assertEqual([path.name for path in registry.directory.iterdir()], ['file-imports.db'])

    def test_complex_original_range_is_scoped_and_returns_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = root / 'document.pdf'
            original.write_bytes(b'%PDF-test-data')
            registry = FileImports(root / 'app-data')
            reference = registry.register('workflow', 'node', original)
            cookie = desktop_security.enable_desktop_session()
            self.addCleanup(desktop_security.disable_desktop_session)
            query = urlencode(dict(workflowId='workflow', nodeId='node', referenceId=reference['id'], v=reference['version']))
            def response(range_value, scope=query):
                headers = {}
                body = io.BytesIO()
                handler = SimpleNamespace(
                    path='/api/storage/file-imports/content?' + scope,
                    client_address=('127.0.0.1', 0),
                    headers={'Range': range_value, 'Cookie': f'{desktop_security.COOKIE_NAME}={cookie}'},
                    send_response=lambda code: headers.update(status=code),
                    send_header=lambda key, value: headers.update({key: value}),
                    end_headers=lambda: None, wfile=body,
                )
                with patch('backend.routes.storage_routes.file_imports', return_value=registry):
                    self.assertTrue(handle_get(handler))
                return headers, body.getvalue()
            headers, content = response('bytes=1-3')
            self.assertEqual((headers['status'], headers['Content-Range'], content), (206, 'bytes 1-3/14', b'PDF'))
            self.assertEqual(response('bytes=999-')[0]['status'], 416)
            self.assertEqual(response('bytes=1-3', query.replace('workflowId=workflow', 'workflowId=other'))[0]['status'], 404)

    def test_native_drop_registers_only_the_webview_file_object_from_the_editor(self):
        class CoreWebView2File:
            Path = 'D:/source/note.md'

        class EdgeChrome:
            def on_webview_ready(self, _sender, _args):
                pass

            def on_script_notify(self, _sender, _args):
                pass

        replies = []
        registrations = []
        def register(*args):
            registrations.append(args)
            return {'id': 'abc', 'name': 'note.md'}

        origin = 'http://127.0.0.1:4567'
        restore = install_webview2_initialization_hook(WebView2InitializationResult(), SimpleNamespace(EdgeChrome=EdgeChrome),
                                                       file_drop_origin=origin, register_file_drop=register)
        self.addCleanup(restore)
        edge = EdgeChrome()
        edge.webview = SimpleNamespace(CoreWebView2=SimpleNamespace(PostWebMessageAsJson=lambda reply: replies.append(json.loads(reply))))
        message = {'type': 'cainflow-file-import', 'workflowId': 'workflow', 'nodeId': 'node', 'path': 'D:/unapproved.txt'}
        args = SimpleNamespace(Source='https://other.example', get_WebMessageAsJson=lambda: json.dumps(message),
                               get_AdditionalObjects=lambda: [CoreWebView2File()])
        edge.on_script_notify(None, args)
        self.assertEqual(replies, [])

        args.Source = origin
        args.get_AdditionalObjects = lambda: []
        edge.on_script_notify(None, args)
        self.assertIn('error', replies[-1])
        self.assertEqual(registrations, [])

        args.get_AdditionalObjects = lambda: [CoreWebView2File()]
        edge.on_script_notify(None, args)
        self.assertEqual(registrations, [('workflow', 'node', 'D:/source/note.md')])
        self.assertEqual(replies[-1]['fileImport'], {'id': 'abc', 'name': 'note.md'})


if __name__ == '__main__':
    unittest.main()
