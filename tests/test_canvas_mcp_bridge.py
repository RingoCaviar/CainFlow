import http.client
import json
import os
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend import desktop_security
from backend.main import create_server


TOKEN = 'canvas-mcp-test-token-0123456789abcdef'
CALL = '/api/canvas-mcp/call'
EDITOR = '/api/canvas-mcp/editor'
SETTINGS = '/api/canvas-mcp/settings'


@contextmanager
def running_server(token=TOKEN, data_dir=None):
    with TemporaryDirectory() as isolated_data, patch.dict(os.environ), \
            patch('backend.config.DATA_DIR', data_dir or isolated_data):
        if token is None:
            os.environ.pop('CAINFLOW_MCP_TOKEN', None)
        else:
            os.environ['CAINFLOW_MCP_TOKEN'] = token
        server = create_server(port=0)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        try:
            yield server.server_address[1]
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def request(port, path, body=None, headers=None, method='POST'):
    client = http.client.HTTPConnection('127.0.0.1', port, timeout=4)
    try:
        payload = json.dumps(body).encode() if isinstance(body, dict) else body
        client.request(method, path, body=payload, headers={'Content-Type': 'application/json', **(headers or {})})
        response = client.getresponse()
        content = response.read()
        return response.status, dict(response.getheaders()), json.loads(content) if content else None
    finally:
        client.close()


def external(port, method, args=None, token=TOKEN):
    status, _, body = request(port, CALL, {'method': method, 'args': args or {}},
                              {'Authorization': f'Bearer {token}'})
    return status, body


def editor(port, editor_id, action='poll', **params):
    status, _, body = request(port, EDITOR, {'action': action, 'editorId': editor_id, **params},
                              {'Origin': f'http://127.0.0.1:{port}', 'X-CainFlow-Canvas-MCP': 'editor'})
    return status, body


def settings(port, action, headers=None, **params):
    return request(port, SETTINGS, {'action': action, **params}, {
        'Origin': f'http://127.0.0.1:{port}', 'X-CainFlow-Canvas-MCP': 'settings', **(headers or {}),
    })


class CanvasMcpBridgeTests(unittest.TestCase):
    def test_disabled_route_and_invalid_token(self):
        with running_server(None) as port:
            self.assertEqual(external(port, 'read_canvas')[0], 404)
            self.assertEqual(editor(port, 'test-editor', activate=True), (204, None))
        with TemporaryDirectory() as data_dir, patch('backend.config.DATA_DIR', data_dir), \
                patch.dict(os.environ, {'CAINFLOW_MCP_TOKEN': 'too-short'}):
            with self.assertRaisesRegex(ValueError, 'CAINFLOW_MCP_TOKEN'):
                with create_server(port=0):
                    pass

    def test_settings_toggle_reuses_client_config_and_revokes_delivered_commands(self):
        with running_server(None) as port, ThreadPoolExecutor(max_workers=1) as calls, \
                patch('backend.services.canvas_mcp_bridge.POLL_SECONDS', 0.05):
            status, headers, disabled = settings(port, 'status')
            self.assertEqual(status, 200)
            self.assertEqual(headers.get('Cache-Control'), 'no-store')
            self.assertFalse(disabled['enabled'])
            self.assertEqual(disabled['port'], port)
            self.assertEqual(settings(port, 'connection_config')[0], 409)
            self.assertEqual(settings(port, 'set_enabled', enabled=1)[0], 400)
            self.assertEqual(settings(port, 'set_enabled', enabled=True)[0], 200)
            status, _, setup = settings(port, 'connection_config')
            self.assertEqual(status, 200)
            client = setup['config']['mcpServers']['cainflow-canvas']
            token = client['env']['CAINFLOW_MCP_TOKEN']
            self.assertGreaterEqual(len(token), 32)
            self.assertNotIn(token, json.dumps(settings(port, 'status')[2]))
            self.assertEqual(client['args'][-2:], ['--port', str(port)])
            self.assertEqual(editor(port, 'editor-one', activate=True)[0], 200)
            pending = calls.submit(external, port, 'read_canvas', token=token)
            delivered = self.poll_command(port, 'editor-one')
            self.assertFalse(settings(port, 'set_enabled', enabled=False)[2]['enabled'])
            interrupted = pending.result(timeout=2)
            self.assertEqual(interrupted[0], 503)
            self.assertIn('outcome', interrupted[1]['error'])
            self.assertEqual(editor(port, 'editor-one', 'complete', id=delivered['id'], result={})[0], 204)
            self.assertEqual(external(port, 'read_canvas', token=token)[0], 404)
            self.assertTrue(settings(port, 'set_enabled', enabled=True)[2]['enabled'])
            self.assertEqual(settings(port, 'connection_config')[2], setup)
            self.assertEqual(editor(port, 'editor-one', activate=False)[0], 409)

    def test_settings_persist_across_server_restarts_and_override_legacy_startup(self):
        with TemporaryDirectory() as data_dir:
            with running_server(TOKEN, data_dir) as port:
                self.assertTrue(settings(port, 'status')[2]['enabled'])
                self.assertFalse(settings(port, 'set_enabled', enabled=False)[2]['enabled'])
            with running_server(TOKEN, data_dir) as port:
                self.assertFalse(settings(port, 'status')[2]['enabled'])
                self.assertTrue(settings(port, 'set_enabled', enabled=True)[2]['enabled'])
            with running_server(None, data_dir) as port:
                self.assertTrue(settings(port, 'status')[2]['enabled'])
                client = settings(port, 'connection_config')[2]['config']['mcpServers']['cainflow-canvas']
                self.assertEqual(client['env']['CAINFLOW_MCP_TOKEN'], TOKEN)

    def test_settings_file_is_private_and_invalid_state_fails_closed(self):
        with TemporaryDirectory(dir=os.getcwd()) as data_dir, TemporaryDirectory(dir=os.getcwd()) as sibling_dir:
            private = Path(data_dir) / '.canvas-mcp'
            private.mkdir()
            (private / 'settings.state').write_text('{"enabled":true,"token":"invalid"}', encoding='utf-8')
            sibling = Path(sibling_dir) / '.CaNvAs-McP'
            sibling.mkdir()
            (sibling / 'settings.state').write_text('{}', encoding='utf-8')
            with running_server(TOKEN, data_dir) as port:
                self.assertFalse(settings(port, 'status')[2]['enabled'])
                self.assertTrue(settings(port, 'set_enabled', enabled=True)[2]['enabled'])
                self.assertEqual(external(port, 'read_canvas')[0], 401)
                with patch('backend.config.WORKFLOWS_DIR', data_dir):
                    self.assertEqual(request(port, '/api/workflows/.canvas-mcp/settings', method='GET')[0], 404)
                for relative in [f'/{Path(data_dir).name}/.canvas-mcp/settings.state',
                                 f'/{Path(sibling_dir).name}/.CaNvAs-McP/settings.state']:
                    for method in ['GET', 'HEAD']:
                        with self.subTest(path=relative, method=method):
                            client = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                            try:
                                client.request(method, relative)
                                response = client.getresponse()
                                self.assertEqual(response.status, 404)
                            finally:
                                client.close()

    def test_packaged_copy_provisions_the_adapter_at_a_stable_path(self):
        with TemporaryDirectory() as data_dir, TemporaryDirectory() as bundle_dir, \
                patch.object(sys, 'frozen', True, create=True), patch('backend.config.STATIC_ROOT', bundle_dir), \
                running_server(TOKEN, data_dir) as port:
            self.assertFalse(settings(port, 'status')[2]['stdioAvailable'])
            self.assertEqual(settings(port, 'connection_config')[0], 409)
            files = {'canvas_mcp.py': b'# bundled adapter\n', 'requirements-mcp.txt': b'mcp==2.3.0\n'}
            for name, body in files.items():
                (Path(bundle_dir) / name).write_bytes(body)
            status = settings(port, 'status')[2]
            self.assertTrue(status['stdioAvailable'])
            private = Path(data_dir) / '.canvas-mcp'
            self.assertFalse(private.exists(), 'status never extracts the bundled files')
            _, _, setup = settings(port, 'connection_config')
            client = setup['config']['mcpServers']['cainflow-canvas']
            self.assertEqual(client['command'], 'python' if os.name == 'nt' else 'python3')
            self.assertEqual(Path(client['args'][0]), private / 'canvas_mcp.py')
            self.assertEqual(status['installCommand'], setup['installCommand'])
            for name, body in files.items():
                self.assertEqual((private / name).read_bytes(), body)

    def test_routes_require_distinct_credentials_and_never_log_or_allow_cross_origin(self):
        desktop_token = desktop_security.enable_desktop_session()
        self.addCleanup(desktop_security.disable_desktop_session)
        with running_server() as port, patch('backend.handler.start_request_log') as log_request:
            auth = {'Authorization': f'Bearer {TOKEN}'}
            call = {'method': 'read_canvas', 'args': {}}
            activation = {'action': 'poll', 'editorId': 'test-editor', 'activate': False}
            editor_headers = {'Origin': f'http://127.0.0.1:{port}', 'X-CainFlow-Canvas-MCP': 'editor'}
            cookie = {'Cookie': f'{desktop_security.COOKIE_NAME}={desktop_token}'}
            self.assertEqual(request(port, CALL, call, cookie)[0], 401)
            self.assertEqual(request(port, CALL, call, {**auth, 'Host': f'other.test:{port}'})[0], 403)
            self.assertEqual(request(port, CALL, call, {**auth, 'Origin': 'http://other.test'})[0], 403)
            self.assertEqual(request(port, EDITOR, activation, {**editor_headers, **auth})[0], 403)
            self.assertEqual(request(port, EDITOR, activation, {**editor_headers, **cookie, 'Origin': 'http://other.test'})[0], 403)
            self.assertEqual(request(port, EDITOR, activation, {**cookie, 'Origin': editor_headers['Origin']})[0], 403)
            self.assertEqual(request(port, EDITOR, activation, {**editor_headers, **cookie})[0], 409)
            self.assertEqual(settings(port, 'connection_config')[0], 403)
            self.assertEqual(settings(port, 'set_enabled', {**cookie, 'Origin': 'http://other.test'}, enabled=False)[0], 403)
            self.assertEqual(settings(port, 'set_enabled', {**cookie, 'Host': f'other.test:{port}'}, enabled=False)[0], 403)
            self.assertTrue(settings(port, 'status', cookie)[2]['enabled'])
            self.assertEqual(request(port, CALL, b'{', auth)[0], 400)
            self.assertEqual(request(port, CALL, b'{"method":"read_canvas","args":{"offset":1e9999}}', auth)[0], 400)
            self.assertEqual(request(port, CALL, b'{}', {**auth, 'Content-Type': 'text/plain'})[0], 415)
            self.assertEqual(request(port, CALL, b'{}', {**auth, 'Content-Length': str(1024 * 1024 + 1)})[0], 413)
            self.assertEqual(request(port, CALL, {'method': 'unknown', 'args': {}}, auth)[0], 400)
            self.assertEqual(request(port, CALL + '?invalid=1', call, auth)[0], 404)
            status, headers, _ = request(port, CALL, method='OPTIONS')
            self.assertEqual(status, 405)
            self.assertNotIn('Access-Control-Allow-Origin', headers)
            log_request.assert_not_called()

    def test_current_editor_reads_and_completes_each_command_once(self):
        with patch('backend.services.canvas_mcp_bridge.POLL_SECONDS', 0.1), \
                patch('backend.services.canvas_mcp_bridge.MAX_PENDING_COMMANDS', 1):
            with running_server() as port, ThreadPoolExecutor(max_workers=1) as calls:
                self.assertEqual(editor(port, 'editor-one', activate=True), (200, {'command': None}))
                pending = calls.submit(external, port, 'read_canvas')
                command = self.poll_command(port, 'editor-one')
                self.assertEqual(command['method'], 'read_canvas')
                self.assertEqual(external(port, 'read_canvas')[0], 429)
                self.assertEqual(editor(port, 'editor-one', activate=False), (200, {'command': None}))
                self.assertEqual(editor(port, 'editor-two', 'complete', id=command['id'], result={})[0], 409)
                result = {'workflowId': 'workflow-1'}
                self.assertEqual(editor(port, 'editor-one', 'complete', id=command['id'], result=result),
                                 (200, {'ok': True}))
                self.assertEqual(pending.result(timeout=2), (200, {'result': {**result, 'editorId': 'editor-one'}}))
                self.assertEqual(editor(port, 'editor-one', 'complete', id=command['id'], result=result)[0], 409)
                self.assertEqual(external(port, 'edit_canvas')[0], 400)

                image = {'mimeType': 'image/png', 'data': 'iVBORw0KGgo='}
                pending = calls.submit(external, port, 'get_run_image', {'editorId': 'editor-one'})
                command = self.poll_command(port, 'editor-one')
                self.assertEqual(command['method'], 'get_run_image')
                self.assertEqual(editor(port, 'editor-one', 'complete', id=command['id'], result=image)[0], 200)
                self.assertEqual(pending.result(timeout=2), (200, {'result': image}))

                pending = calls.submit(external, port, 'run_workflow',
                                       {'editorId': 'editor-one', 'workflowId': 'workflow-1'})
                command = self.poll_command(port, 'editor-one')
                self.assertEqual(command['args'], {'editorId': 'editor-one', 'workflowId': 'workflow-1'})
                self.assertEqual(editor(port, 'editor-two', activate=True), (200, {'command': None}))
                self.assertEqual(pending.result(timeout=2)[0], 409)
                self.assertEqual(editor(port, 'editor-one', 'complete', id=command['id'], result={})[0], 409)
                self.assertEqual(external(port, 'run_workflow', {'editorId': 'editor-one'})[0], 409)
                self.assertEqual(external(port, 'get_workflow_run', {'editorId': 'editor-one'})[0], 409)

    def test_timed_out_delivered_command_cannot_replay_or_complete(self):
        with patch('backend.services.canvas_mcp_bridge.POLL_SECONDS', 0.05), \
                patch('backend.services.canvas_mcp_bridge.COMMAND_SECONDS', 0.5):
            with running_server() as port, ThreadPoolExecutor(max_workers=1) as calls:
                self.assertEqual(editor(port, 'editor-one', activate=True)[0], 200)
                pending = calls.submit(external, port, 'edit_canvas', {'editorId': 'editor-one'})
                command = self.poll_command(port, 'editor-one')
                status, body = pending.result(timeout=2)
                self.assertEqual(status, 504)
                self.assertIn('outcome', body['error'])
                self.assertEqual(editor(port, 'editor-one', 'complete', id=command['id'], result={})[0], 409)
                self.assertEqual(editor(port, 'editor-one', activate=False), (200, {'command': None}))

    def poll_command(self, port, editor_id):
        for _ in range(10):
            status, response = editor(port, editor_id, activate=False)
            self.assertEqual(status, 200)
            if response['command']:
                return response['command']
        self.fail('editor did not receive a command')


if __name__ == '__main__':
    unittest.main()
