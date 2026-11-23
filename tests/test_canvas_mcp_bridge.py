import http.client
import base64
import json
import os
import sys
import threading
import time
import unittest
from contextlib import contextmanager
from importlib.util import find_spec
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from tempfile import TemporaryDirectory
from unittest.mock import patch

from backend import desktop_security
from backend.main import create_server
from backend.services.storage_service import StorageService

TOKEN = 'canvas-mcp-test-token-0123456789abcdef'
CALL = '/api/canvas-mcp/call'
SETTINGS = '/api/canvas-mcp/settings'


@contextmanager
def running_server(token=TOKEN, data_dir=None):
    with TemporaryDirectory() as isolated_data:
        root = Path(data_dir or isolated_data)
        storage = StorageService(
            database_path=str(root / 'cainflow.db'), assets_dir=str(root / 'assets'),
            temp_dir=str(root / 'temp'), exports_dir=str(root / 'exports'),
        )
        with patch.dict(os.environ), patch('backend.config.DATA_DIR', str(root)), \
                patch('backend.config.WORKFLOWS_DIR', str(root / 'workflows')), \
                patch('backend.services.canvas_mcp_storage.storage_service', storage), \
                patch('backend.services.canvas_mcp_app_data.storage_service', storage):
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
    client = http.client.HTTPConnection('127.0.0.1', port, timeout=12)
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


def settings(port, action, headers=None, **params):
    return request(port, SETTINGS, {'action': action, **params}, {
        'Origin': f'http://127.0.0.1:{port}', 'X-CainFlow-Canvas-MCP': 'settings', **(headers or {}),
    })


PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPxQAAAAASUVORK5CYII='


@contextmanager
def image_provider(holds=None, formats=None):
    holds = holds or {}
    formats = formats or {}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append((self.path, payload))
            hold = holds.get(payload.get('prompt'))
            if hold:
                requested, release = hold
                requested.set()
                if not release.wait(15):
                    self.send_error(504)
                    return
            output_format = payload.get('output_format')
            reply = {'data': [{'b64_json': formats.get(output_format, PNG)}]}
            if output_format in formats:
                reply['output_format'] = output_format
            response = json.dumps(reply).encode()
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                if not hold:
                    raise

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_address[1]}/v1', requests
        finally:
            for _, release in holds.values():
                release.set()
            server.shutdown()
            thread.join(timeout=2)


class CanvasMcpToolMetadataTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(find_spec('mcp'), 'Install requirements-mcp.txt to test stdio tool metadata.')
    async def test_saved_workflow_contract_is_visible_over_stdio(self):
        from mcp import Client, StdioServerParameters

        with running_server() as port:
            server = StdioServerParameters(
                command=sys.executable,
                args=[str(Path(__file__).resolve().parents[1] / 'canvas_mcp.py'), '--port', str(port)],
                env={'CAINFLOW_MCP_TOKEN': TOKEN},
            )
            async with Client(server, mode='legacy', read_timeout_seconds=10) as client:
                instructions = client.instructions
                tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                created = await client.call_tool('create_workflow', {'name': '从 stdio 创建'})
                self.assertFalse(created.is_error)
                self.assertIn('workflowId', created.structured_content)

        for description in (instructions, tools['edit_canvas'].description):
            self.assertIn('import_history', description)
            self.assertIn('no file upload', description)
            self.assertIn('read_canvas again', description)
        self.assertIn('nodes[].assets', tools['read_canvas'].description)
        self.assertIn('imported[].nodeId', tools['import_history'].description)
        self.assertIn('list_workflows', tools)
        for name in ('read_canvas', 'edit_canvas', 'run_workflow'):
            schema = tools[name].input_schema
            self.assertIn('workflowId', schema['required'])
            self.assertNotIn('editorId', schema.get('properties', {}))


class CanvasMcpServiceTests(unittest.TestCase):
    def call(self, port, method, args=None, token=TOKEN):
        status, body = external(port, method, args, token=token)
        self.assertEqual(status, 200, body)
        return body['result']

    def wait_for_run(self, port, workflow_id, run_id):
        for _ in range(100):
            result = self.call(port, 'get_workflow_run', {'workflowId': workflow_id, 'runId': run_id})
            if result['status'] != 'running':
                return result
            time.sleep(0.03)
        self.fail('Saved workflow did not finish')

    def test_read_edit_run_and_undo_without_opening_an_editor(self):
        with running_server() as port:
            created = self.call(port, 'create_workflow', {'name': '无人值守工作流'})
            workflow_id = created['workflowId']
            self.assertEqual(self.call(port, 'list_workflows')['items'][0]['workflowId'], workflow_id)
            target = self.call(port, 'read_canvas', {'workflowId': workflow_id})
            scope = {'workflowId': workflow_id, 'revision': target['revision']}
            edit = self.call(port, 'edit_canvas', {**scope, 'plan': {'version': 1, 'steps': [
                {'id': 'source', 'type': 'Text', 'parameters': {'text': '保存的原文'}},
                {'id': 'output', 'type': 'Text', 'parameters': {}, 'execute': False},
            ], 'connections': [{'from': {'ref': 'source', 'port': 'text'}, 'to': {'ref': 'output', 'port': 'text'}}]}})
            self.assertNotEqual(edit['revision'], scope['revision'])
            self.assertEqual(external(port, 'read_canvas', scope)[1]['errorCode'], 'stale_revision')
            self.assertEqual(external(port, 'run_workflow', scope)[1]['errorCode'], 'stale_revision')
            edit_scope = {'workflowId': workflow_id, 'revision': edit['revision']}
            changed = self.call(port, 'undo_canvas', edit_scope)
            self.assertTrue(changed['changed'])
            self.assertEqual(self.call(port, 'read_canvas', {'workflowId': workflow_id})['totalNodes'], 0)
            redo = self.call(port, 'redo_canvas', {'workflowId': workflow_id, 'revision': changed['revision']})
            output = edit['bindings']['output']
            run = self.call(port, 'run_workflow', {'workflowId': workflow_id, 'revision': redo['revision'], 'targetNodeId': output})
            result = self.wait_for_run(port, workflow_id, run['runId'])
            self.assertEqual(result['status'], 'completed', result)
            self.assertEqual({row['nodeId']: row.get('texts') for row in result['nodeResults']}[output], ['保存的原文'])
            self.assertEqual(self.call(port, 'read_canvas', {'workflowId': workflow_id})['totalNodes'], 2)
            self.assertEqual(request(port, '/api/canvas-mcp/editor', {})[0], 404)

    def test_library_changes_and_saved_workflow_survive_server_restart(self):
        with TemporaryDirectory() as directory:
            with running_server(data_dir=directory) as port:
                preset = self.call(port, 'save_prompt', {'name': '统一拍摄', 'content': '保留原包装文字'})
                created = self.call(port, 'create_workflow', {'name': '重开工作流'})
            with running_server(data_dir=directory) as port:
                self.assertEqual(self.call(port, 'list_prompts')['prompts'][0]['id'], preset['id'])
                self.assertEqual(self.call(port, 'read_canvas', {'workflowId': created['workflowId']})['revision'], created['revision'])

    def test_run_uses_saved_model_and_persists_generated_image_without_any_window(self):
        from backend.services import canvas_mcp_app_data as app
        with running_server() as port, image_provider() as (endpoint, requests):
            app.storage_service.put_document('session', {
                'models': [{'id': 'model', 'name': 'Image', 'modelId': 'gpt-image-1', 'protocol': 'openai',
                            'taskType': 'image', 'providerIds': ['provider']}],
                'providers': [{'id': 'provider', 'name': 'Image Provider', 'endpoint': endpoint, 'apikey': 'local-test-key'}],
            })
            self.assertEqual(self.call(port, 'list_models')['models'][0]['id'], 'model')
            created = self.call(port, 'create_workflow', {'name': '后台生图'})
            workflow_id = created['workflowId']
            edited = self.call(port, 'edit_canvas', {
                'workflowId': workflow_id, 'revision': created['revision'], 'plan': {'version': 1, 'steps': [{
                    'id': 'image', 'type': 'ImageGenerate', 'parameters': {'prompt': '生成测试图片'},
                    'modelId': 'model', 'providerId': 'provider',
                }]},
            })
            node_id = edited['bindings']['image']
            started = self.call(port, 'run_workflow', {'workflowId': workflow_id, 'revision': edited['revision']})
            run = self.wait_for_run(port, workflow_id, started['runId'])
            self.assertEqual(run['status'], 'completed', run)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0][1]['prompt'], '生成测试图片')
            image = self.call(port, 'get_run_image', {'workflowId': workflow_id, 'runId': run['runId'], 'nodeId': node_id})
            self.assertEqual(base64.b64decode(image['data']), base64.b64decode(PNG))
            state = self.call(port, 'read_canvas', {'workflowId': workflow_id})
            self.assertEqual(state['nodes'][0]['assets'], run['nodeResults'][0]['mediaAssetKeys'])
            self.assertEqual(len(state['nodes'][0]['assets']), 1)
            self.assertNotIn('local-test-key', json.dumps(state))

    def test_gif_and_svg_results_keep_their_bytes_in_history_and_mcp(self):
        from backend.services import canvas_mcp_app_data as app

        gif = bytes.fromhex('47494638396101000100800000000000ffffff21ff0b4e45545343415045322e300301000000'
                            '21f904000a0000002c0000000001000100000202440100'
                            '21f904000a0000002c00000000010001000002024c01003b')
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>'
        originals = {'gif': gif, 'svg': svg}
        formats = {name: base64.b64encode(original).decode('ascii') for name, original in originals.items()}
        with running_server() as port, image_provider(formats=formats) as (endpoint, requests):
            app.storage_service.put_document('session', {
                'models': [{'id': 'model', 'name': 'Image', 'modelId': 'gpt-image-2.6-flare', 'protocol': 'openai',
                            'taskType': 'image', 'providerIds': ['provider']}],
                'providers': [{'id': 'provider', 'name': 'Image Provider', 'endpoint': endpoint, 'apikey': 'local-test-key'}],
            })
            created = self.call(port, 'create_workflow', {'name': '后台动图和矢量图'})
            workflow_id = created['workflowId']
            edited = self.call(port, 'edit_canvas', {
                'workflowId': workflow_id, 'revision': created['revision'], 'plan': {'version': 1, 'steps': [
                    {'id': name, 'type': 'ImageGenerate', 'modelId': 'model', 'providerId': 'provider',
                     'parameters': {'prompt': name, 'protocolParams': {'output_format': name}}}
                    for name in formats
                ]},
            })
            started = self.call(port, 'run_workflow', {'workflowId': workflow_id, 'revision': edited['revision']})
            run = self.wait_for_run(port, workflow_id, started['runId'])
            self.assertEqual(run['status'], 'completed', run)
            self.assertEqual(run['historySaved'], 2, run)
            self.assertCountEqual([request['output_format'] for _, request in requests], formats)
            history_directory = Path(app.storage_service.get_export_directory())
            for name, original in originals.items():
                with self.subTest(output=name):
                    node_id = edited['bindings'][name]
                    image = self.call(port, 'get_run_image', {'workflowId': workflow_id, 'runId': run['runId'], 'nodeId': node_id})
                    self.assertEqual(image['mimeType'], 'image/svg+xml' if name == 'svg' else 'image/gif')
                    self.assertEqual(base64.b64decode(image['data']), original)
                    self.assertEqual([path.read_bytes() for path in history_directory.glob(f'*.{name}')], [original])

    def test_stops_held_provider_requests_by_node_and_by_run(self):
        from backend.services import canvas_mcp_app_data as app

        stopped_request, stopped_release = threading.Event(), threading.Event()
        surviving_request, surviving_release = threading.Event(), threading.Event()
        holds = {'取消分支': (stopped_request, stopped_release), '保留分支': (surviving_request, surviving_release)}
        with running_server() as port, image_provider(holds) as (endpoint, requests):
            app.storage_service.put_document('session', {
                'models': [{'id': 'model', 'name': 'Image', 'modelId': 'gpt-image-1', 'protocol': 'openai',
                            'taskType': 'image', 'providerIds': ['provider']}],
                'providers': [{'id': 'provider', 'name': 'Image Provider', 'endpoint': endpoint, 'apikey': 'local-test-key'}],
            })
            created = self.call(port, 'create_workflow', {'name': '后台停止生图'})
            workflow_id = created['workflowId']
            edit = self.call(port, 'edit_canvas', {
                'workflowId': workflow_id, 'revision': created['revision'], 'plan': {'version': 1, 'steps': [
                    {'id': ref, 'type': 'ImageGenerate', 'parameters': {'prompt': prompt},
                     'modelId': 'model', 'providerId': 'provider'}
                    for ref, prompt in [('stopped', '取消分支'), ('surviving', '保留分支')]
                ]},
            })
            stopped_id = edit['bindings']['stopped']
            surviving_id = edit['bindings']['surviving']
            scope = {'workflowId': workflow_id, 'revision': edit['revision']}
            started = self.call(port, 'run_workflow', scope)
            self.assertTrue(stopped_request.wait(5), 'The first branch did not reach the provider')

            self.assertEqual(self.call(port, 'stop_workflow', {**scope, 'nodeIds': [stopped_id]})['stopped'], 1)
            self.assertTrue(surviving_request.wait(5), 'The independent branch did not continue after cancellation')
            surviving_release.set()
            run = self.wait_for_run(port, workflow_id, started['runId'])
            self.assertEqual(run['status'], 'cancelled', run)
            results = {result['nodeId']: result for result in run['nodeResults']}
            self.assertEqual(results[stopped_id]['errorCode'], 'node_cancelled')
            self.assertTrue(results[surviving_id]['succeeded'])
            self.assertEqual(len(results[surviving_id]['mediaAssetKeys']), 1)
            self.assertEqual(run['historySaved'], 1)
            self.assertEqual(run['historySaveFailures'], 0)

            stopped_request.clear()
            scope['revision'] = run['revision']
            started = self.call(port, 'run_workflow', {**scope, 'targetNodeId': stopped_id})
            self.assertTrue(stopped_request.wait(5), 'The targeted run did not reach the provider')
            self.assertCountEqual([payload['prompt'] for _, payload in requests], ['取消分支', '保留分支', '取消分支'])
            self.assertEqual(external(port, 'stop_workflow', {**scope, 'nodeIds': [surviving_id]})[0], 400)
            self.assertEqual(self.call(port, 'stop_workflow', scope)['stopped'], 1)
            run = self.wait_for_run(port, workflow_id, started['runId'])
            self.assertEqual(run['status'], 'stopped', run)
            self.assertEqual([(row['nodeId'], row['errorCode']) for row in run['nodeResults']],
                             [(stopped_id, 'node_cancelled')])
            stopped_request.clear()
            self.call(port, 'run_workflow', {**scope, 'targetNodeId': stopped_id})
            self.assertTrue(stopped_request.wait(5), 'The last run did not reach the provider before shutdown')
            self.assertEqual(settings(port, 'set_enabled', enabled=False)[2]['enabled'], False)
            stopped_release.set()
            self.assertEqual(settings(port, 'set_enabled', enabled=True)[2]['enabled'], True)
            self.assertEqual(self.call(port, 'read_canvas', {'workflowId': workflow_id})['revision'], scope['revision'])
            self.assertEqual(self.call(port, 'list_history')['total'], 1)

    def test_requires_explicit_workflow_and_rejects_editor_scope(self):
        with running_server() as port:
            self.assertEqual(external(port, 'read_canvas')[0], 400)
            self.assertEqual(external(port, 'read_canvas', {'editorId': 'old', 'workflowId': 'unknown'})[0], 400)
            self.assertEqual(external(port, 'run_workflow', {'workflowId': 'unknown'})[0], 400)
            self.assertEqual(external(port, 'read_canvas', {'workflowId': 'unknown'})[0], 404)
            self.assertEqual(external(port, 'edit_canvas', {'workflowId': '../escape', 'revision': 'a', 'plan': {}})[0], 400)

    def test_missing_node_runtime_is_reported_without_a_browser_fallback(self):
        with running_server() as port, patch.dict(os.environ, {'CAINFLOW_NODE_PATH': 'relative/not-allowed'}):
            self.assertFalse(settings(port, 'status')[2]['runtimeAvailable'])
            created = self.call(port, 'create_workflow', {'name': '缺运行时'})
            status, body = external(port, 'read_canvas', {'workflowId': created['workflowId']})
            self.assertEqual((status, body['errorCode']), (503, 'runtime_unavailable'))

    def test_settings_toggle_reuses_client_configuration(self):
        with running_server(None) as port:
            status, headers, disabled = settings(port, 'status')
            self.assertEqual(status, 200)
            self.assertEqual(headers.get('Cache-Control'), 'no-store')
            self.assertFalse(disabled['enabled'])
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
            self.assertFalse(settings(port, 'set_enabled', enabled=False)[2]['enabled'])
            self.assertEqual(external(port, 'list_workflows', token=token)[0], 404)
            self.assertTrue(settings(port, 'set_enabled', enabled=True)[2]['enabled'])
            self.assertEqual(settings(port, 'connection_config')[2], setup)

    def test_settings_persist_across_server_restarts(self):
        with TemporaryDirectory() as directory:
            with running_server(TOKEN, directory) as port:
                self.assertTrue(settings(port, 'status')[2]['enabled'])
                self.assertFalse(settings(port, 'set_enabled', enabled=False)[2]['enabled'])
            with running_server(TOKEN, directory) as port:
                self.assertFalse(settings(port, 'status')[2]['enabled'])
                self.assertTrue(settings(port, 'set_enabled', enabled=True)[2]['enabled'])
            with running_server(None, directory) as port:
                self.assertTrue(settings(port, 'status')[2]['enabled'])
                self.assertEqual(settings(port, 'connection_config')[2]['config']['mcpServers']['cainflow-canvas']['env']['CAINFLOW_MCP_TOKEN'], TOKEN)

    def test_invalid_settings_file_is_private_and_fails_closed(self):
        with TemporaryDirectory(dir=os.getcwd()) as directory:
            private = Path(directory) / '.canvas-mcp'
            private.mkdir()
            (private / 'settings.state').write_text('{"enabled":true,"token":"invalid"}', encoding='utf-8')
            with running_server(TOKEN, directory) as port:
                self.assertFalse(settings(port, 'status')[2]['enabled'])
                client = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                try:
                    client.request('GET', f'/{Path(directory).name}/.canvas-mcp/settings.state')
                    self.assertEqual(client.getresponse().status, 404)
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
        with running_server() as port, patch('backend.handler.start_request_log') as log_request:
            desktop_token = desktop_security.enable_desktop_session()
            try:
                auth = {'Authorization': f'Bearer {TOKEN}'}
                call = {'method': 'list_workflows', 'args': {}}
                cookie = {'Cookie': f'{desktop_security.COOKIE_NAME}={desktop_token}'}
                self.assertEqual(request(port, CALL, call, cookie)[0], 401)
                self.assertEqual(request(port, CALL, call, {**auth, 'Origin': 'https://cross-origin.test'})[0], 403)
                self.assertEqual(request(port, CALL, call, {**auth, 'Host': f'localhost:{port}'})[0], 403)
                self.assertEqual(settings(port, 'status', headers=auth)[0], 403)
                self.assertEqual(settings(port, 'status')[0], 403)
                self.assertEqual(settings(port, 'status', headers=cookie)[0], 200)
                self.assertEqual(request(port, CALL, call, auth)[0], 200)
                log_request.assert_not_called()
            finally:
                desktop_security.disable_desktop_session()


if __name__ == '__main__':
    unittest.main()
