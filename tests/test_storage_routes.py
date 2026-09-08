import unittest
from types import SimpleNamespace
from unittest import mock

from backend.routes import storage_routes
from backend.routes.storage_routes import _is_authorized_local_request


def make_handler(client='127.0.0.1', origin='http://127.0.0.1:8767'):
    return SimpleNamespace(client_address=(client, 50000), headers={'Origin': origin})


class StorageRouteSecurityTests(unittest.TestCase):
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
