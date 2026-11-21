import base64
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from backend.services import canvas_mcp_app_data
from backend.services.canvas_mcp_bridge import CanvasMcpError
from backend.services.media_library import MediaLibrary
from backend.services.storage_service import StorageService


class CanvasMcpGeneratedHistoryTests(unittest.TestCase):
    def test_archives_only_current_successful_generation_in_saved_export_directory(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        storage = StorageService(database_path=str(root / 'cache.db'), assets_dir=str(root / 'cache'),
                                 temp_dir=str(root / 'temp'), exports_dir=str(root / 'default'))
        destination = root / 'exports'
        storage.set_export_directory(str(destination))
        storage.put_document('session', {'models': [{'id': 'model-1', 'name': 'Image Model'}]})
        library = MediaLibrary(storage)
        owners = {kind: json.dumps(['workflow', node, kind]) for kind, node in (
            ('new-image', 'image'), ('new-video', 'video'), ('old-owner', 'image'), ('wrong-format', 'invalid-format'),
        )}

        def asset(kind, value, owner):
            contents = base64.b64encode(value).decode('ascii')
            return storage.put_media_asset_list([f'data:{kind};base64,{contents}'],
                                                'workflow-operation', owners[owner])[0]['asset_key']

        image = asset('image/png', b'this image', 'new-image')
        video = asset('video/mp4', b'this video', 'new-video')
        old = asset('image/png', b'stale', 'old-owner')
        wrong_format = asset('video/mp4', b'not an image', 'wrong-format')

        def node(identifier, node_type, fields, keys, markers):
            return {'id': identifier, 'type': node_type, **fields, 'mediaAssetKeys': keys, 'data': {
                'mediaOwnershipTemporaryOwners': [{'ownerId': owners[owner], 'assetKeys': [key]} for owner, key in markers],
            }}

        document = {'imageSaveUsePromptFilename': True, 'nodes': [
            node('image', 'ImageGenerate', {'apiConfigId': 'model-1', 'prompt': 'A path/segment'},
                 [image, old], [('new-image', image), ('old-owner', old)]),
            node('video', 'VideoGenerate', {'videos': [{'prompt': 'Video result'}]}, [video], [('new-video', video)]),
            node('imported', 'ImageImport', {}, [image], [('new-image', image)]),
            node('failed', 'ImageGenerate', {}, [image], [('new-image', image)]),
            node('invalid-format', 'ImageGenerate', {}, [wrong_format], [('wrong-format', wrong_format)]),
        ]}
        results = [
            {'nodeId': 'image', 'succeeded': True, 'mediaAssetKeys': [image, old, video]},
            {'nodeId': 'video', 'succeeded': True, 'mediaAssetKeys': [video]},
            {'nodeId': 'imported', 'succeeded': True, 'mediaAssetKeys': [image]},
            {'nodeId': 'failed', 'succeeded': False, 'mediaAssetKeys': [image]},
            {'nodeId': 'invalid-format', 'succeeded': True, 'mediaAssetKeys': [wrong_format]},
        ]
        with patch.object(canvas_mcp_app_data, 'storage_service', storage):
            archived = canvas_mcp_app_data.publish_generated_history(document, results,
                published_owner_ids={owners[owner] for owner in ('new-image', 'new-video', 'wrong-format')})

        self.assertEqual({'saved': 2, 'failed': 1}, archived)
        rows = {row['nodeId']: row for row in library.list_page(20)['items']}
        self.assertEqual({'image', 'video'}, rows.keys())
        self.assertEqual('Image Model', rows['image']['model'])
        self.assertTrue(rows['image']['relativePath'].startswith('A path_segment-'))
        self.assertTrue(rows['video']['relativePath'].startswith('Video result-'))
        self.assertEqual(b'this image', (destination / rows['image']['relativePath']).read_bytes())
        self.assertEqual(b'this video', (destination / rows['video']['relativePath']).read_bytes())


class ProviderHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', self.server.destination)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Set-Cookie', 'example=private')
        self.end_headers()
        self.wfile.write(b'configured response')


class CanvasMcpProviderTests(unittest.TestCase):
    def open_provider(self):
        server = self.enterContext(ThreadingHTTPServer(('127.0.0.1', 0), ProviderHandler))
        server.requests = []
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        return server, f'http://127.0.0.1:{server.server_port}'

    def test_configured_provider_allows_same_origin_and_rejects_cross_origin_redirects(self):
        provider, origin = self.open_provider()
        other, other_origin = self.open_provider()
        providers = [{'endpoint': origin + '/v1'}, {'endpoint': other_origin + '/v1'}]
        request = {'url': origin + '/redirect', 'method': 'GET', 'headers': {'Authorization': 'Bearer fake'}, 'body': None}

        with patch.object(canvas_mcp_app_data, '_session', return_value={'proxy': {'enabled': False}}):
            provider.destination = '/ok'
            response = canvas_mcp_app_data.request_provider(request, providers)
            self.assertEqual(200, response['status'])
            self.assertEqual({'Content-Type': 'text/plain'}, response['headers'])
            self.assertEqual(b'configured response', base64.b64decode(response['body']))

            provider.destination = other_origin + '/different-origin'
            with self.assertRaises(CanvasMcpError) as remote:
                canvas_mcp_app_data.request_provider(request, providers)
            self.assertEqual('provider_target_rejected', remote.exception.code)
            self.assertEqual([], other.requests)

            with self.assertRaises(CanvasMcpError) as direct:
                canvas_mcp_app_data.request_provider({**request, 'url': other_origin + '/unconfigured'}, providers[:1])
            self.assertEqual('provider_target_rejected', direct.exception.code)
            self.assertEqual([], other.requests)
