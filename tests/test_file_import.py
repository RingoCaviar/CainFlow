import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
