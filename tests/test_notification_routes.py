import unittest
from types import SimpleNamespace

from backend.routes.notification_routes import _is_local_cainflow_request


def make_handler(client_host='127.0.0.1', origin='http://127.0.0.1:8767'):
    return SimpleNamespace(
        client_address=(client_host, 50000),
        headers={'Origin': origin},
    )


class NotificationRouteSecurityTests(unittest.TestCase):
    def test_accepts_local_cainflow_origin(self):
        self.assertTrue(_is_local_cainflow_request(make_handler()))
        self.assertTrue(_is_local_cainflow_request(make_handler('::1', 'http://localhost:8767')))

    def test_rejects_non_local_client(self):
        self.assertFalse(_is_local_cainflow_request(make_handler('192.168.1.25')))

    def test_rejects_missing_or_wrong_origin(self):
        self.assertFalse(_is_local_cainflow_request(make_handler(origin='')))
        self.assertFalse(_is_local_cainflow_request(make_handler(origin='http://127.0.0.1:9999')))
        self.assertFalse(_is_local_cainflow_request(make_handler(origin='https://example.com')))


if __name__ == '__main__':
    unittest.main()
