import unittest
from types import SimpleNamespace
from unittest import mock

from backend.routes import storage_routes
from backend.routes.storage_routes import _is_authorized_local_request


def make_handler(client='127.0.0.1', origin='http://127.0.0.1:8767'):
    return SimpleNamespace(client_address=(client, 50000), headers={'Origin': origin})


class StorageRouteSecurityTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
