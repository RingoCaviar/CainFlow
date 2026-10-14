import os
import tempfile
import unittest
import io
import json
from unittest.mock import patch

from backend import config
from backend.routes.protocol_routes import (
    atomic_write_protocol,
    build_serializable_protocol_config,
    handle_post,
    restore_protocol_override,
    save_protocol,
    save_protocol_overrides,
    validate_transport_adapters,
)


class ProtocolRoutesTests(unittest.TestCase):
    class _SaveHandler:
        path = '/api/protocol/save'

        def __init__(self, payload):
            body = payload.encode('utf-8')
            self.headers = {'Content-Length': str(len(body))}
            self.rfile = io.BytesIO(body)

    class _RestoreHandler:
        path = '/api/protocol/override/restore'

        def __init__(self, payload):
            body = payload.encode('utf-8')
            self.headers = {'Content-Length': str(len(body))}
            self.rfile = io.BytesIO(body)

    def test_unknown_transport_fields_are_rejected_instead_of_dropped(self):
        self.assertIn('不支持字段', validate_transport_adapters({
            'transportAdapter': {'adapterId': 'multipart', 'version': 1, 'headers': {}}
        }))
        self.assertIn('不支持 Transport adapter', validate_transport_adapters({
            'transportAdapter': {'adapterId': 'vendor-custom', 'version': 1}
        }))

    def test_transport_encoding_conflicts_are_rejected(self):
        self.assertIn('冲突', validate_transport_adapters({
            'transportAdapter': {'adapterId': 'json', 'version': 1},
            'requestEncoding': 'multipart'
        }))
        self.assertIn('冲突', validate_transport_adapters({
            'transportAdapter': {'adapterId': 'multipart', 'version': 1},
            'variants': {
                'model-a': {'requestEncodingWhenReferenceImages': 'json'}
            }
        }))

    def test_transport_adapter_is_preserved_in_serializable_protocol(self):
        config = build_serializable_protocol_config('sample', {
            'transportAdapter': {
                'adapterId': 'multipart',
                'version': 1,
                'parts': [{'name': 'prompt', 'source': 'parameter', 'path': 'prompt', 'kind': 'text'}],
            }
        })
        self.assertEqual(config['transportAdapter']['adapterId'], 'multipart')

    def test_unknown_protocol_fields_survive_serialization(self):
        config = build_serializable_protocol_config('sample', {
            'futureCapability': {'mode': 'preserve'},
            'parameters': {'prompt': {'futureParameterRule': {'scope': 'provider'}}},
            'variants': {'model-a': {'futureVariantRule': ['keep']}}
        })
        self.assertEqual(config['futureCapability']['mode'], 'preserve')
        self.assertEqual(config['parameters']['prompt']['futureParameterRule']['scope'], 'provider')
        self.assertEqual(config['variants']['model-a']['futureVariantRule'], ['keep'])

    def test_multipart_parts_require_supported_mapping_fields(self):
        base = {'transportAdapter': {'adapterId': 'multipart', 'version': 1, 'parts': [{}]}}
        self.assertIn('缺少 name', validate_transport_adapters(base))
        base['transportAdapter']['parts'] = [{'name': 'prompt', 'source': 'parameter'}]
        self.assertIn('需要 path', validate_transport_adapters(base))
        base['transportAdapter']['parts'] = [{'name': 'prompt', 'source': 'future', 'path': 'prompt'}]
        self.assertIn('source 不受支持', validate_transport_adapters(base))
        base['transportAdapter']['parts'] = [{'name': 'prompt', 'source': 'literal'}]
        self.assertIn('literal 需要 value', validate_transport_adapters(base))

    def test_override_write_keeps_previous_revision_backup(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(config, 'DATA_DIR', root):
                save_protocol_overrides({'openai': {'revision': 1}})
                save_protocol_overrides({'openai': {'revision': 2}})
                with open(os.path.join(root, 'protocol-overrides.json'), encoding='utf-8') as current:
                    self.assertIn('revision": 2', current.read())
                with open(os.path.join(root, 'protocol-overrides.json.bak'), encoding='utf-8') as backup:
                    self.assertIn('revision": 1', backup.read())

    def test_restore_override_replaces_only_requested_id_and_rotates_backup(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(config, 'DATA_DIR', root):
                save_protocol_overrides({
                    'openai': {'revision': 1, 'config': {'label': 'old'}},
                    'google': {'revision': 7},
                })
                save_protocol_overrides({
                    'openai': {'revision': 2, 'config': {'label': 'new'}},
                    'google': {'revision': 8},
                })
                handler = self._RestoreHandler(json.dumps({'protocolId': 'openai'}))
                with patch('backend.routes.protocol_routes.write_json') as write:
                    self.assertTrue(handle_post(handler))

                payload = write.call_args.args[1]
                self.assertTrue(payload['success'])
                self.assertEqual(payload['override']['revision'], 1)
                with open(os.path.join(root, 'protocol-overrides.json'), encoding='utf-8') as current:
                    restored = json.load(current)
                self.assertEqual(restored['openai']['revision'], 1)
                self.assertEqual(restored['google']['revision'], 8)
                with open(os.path.join(root, 'protocol-overrides.json.bak'), encoding='utf-8') as backup:
                    rotated = json.load(backup)
                self.assertEqual(rotated['openai']['revision'], 2)
                self.assertEqual(rotated['google']['revision'], 8)

    def test_restore_override_requires_backup_for_builtin_protocol(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(config, 'DATA_DIR', root), \
                    patch('backend.routes.protocol_routes.write_error') as write_error:
                handler = self._RestoreHandler(json.dumps({'protocolId': 'openai'}))
                self.assertTrue(handle_post(handler))
                self.assertEqual(write_error.call_args.args[1:3], (404, '内置协议 openai 没有可恢复的覆盖版本'))

    def test_restore_override_rejects_non_builtin_protocol(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(config, 'DATA_DIR', root), \
                    patch('backend.routes.protocol_routes.write_error') as write_error:
                handler = self._RestoreHandler(json.dumps({'protocolId': 'custom'}))
                restore_protocol_override(handler)
                self.assertEqual(write_error.call_args.args[1:3], (400, '只有内置协议支持恢复覆盖版本'))

    def test_builtin_save_persists_baseline_metadata_from_request(self):
        handler = self._SaveHandler(json.dumps({
            'id': 'openai',
            'baseSchemaVersion': 1,
            'baseRevision': 'baseline-42',
            'config': {'schemaVersion': 1, 'taskTypes': ['chat', 'image']},
        }))
        with patch('backend.routes.protocol_routes.load_protocol_overrides', return_value={}), \
                patch('backend.routes.protocol_routes.save_protocol_overrides') as save, \
                patch('backend.routes.protocol_routes.write_json'):
            save_protocol(handler)
        record = save.call_args.args[0]['openai']
        self.assertEqual(record['baseSchemaVersion'], 1)
        self.assertEqual(record['baseRevision'], 'baseline-42')

    def test_atomic_protocol_write_keeps_previous_revision_and_cleans_temp_files(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'sample.js')
            atomic_write_protocol(path, 'first')
            atomic_write_protocol(path, 'second')
            with open(path, encoding='utf-8') as current:
                self.assertEqual(current.read(), 'second')
            with open(f'{path}.bak', encoding='utf-8') as backup:
                self.assertEqual(backup.read(), 'first')
            self.assertEqual([name for name in os.listdir(root) if name.endswith('.tmp')], [])


if __name__ == '__main__':
    unittest.main()
