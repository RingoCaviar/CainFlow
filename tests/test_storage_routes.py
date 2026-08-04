import unittest
from types import SimpleNamespace

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


if __name__ == '__main__':
    unittest.main()
