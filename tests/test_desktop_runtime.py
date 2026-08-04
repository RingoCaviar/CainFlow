import http.client
import os
import tempfile
import threading
import unittest
from unittest import mock

from backend import desktop_security
from backend.desktop import SingleInstanceLock
from backend.handler import ProxyHTTPRequestHandler
from backend.services.desktop_bridge import DesktopBridge


class _ThreadedServer(__import__('socketserver').ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class DesktopSecurityTests(unittest.TestCase):
    def tearDown(self):
        desktop_security.disable_desktop_session()

    def test_desktop_api_requires_bootstrap_cookie(self):
        token = desktop_security.enable_desktop_session()
        server = _ThreadedServer(('127.0.0.1', 0), ProxyHTTPRequestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', server.server_address[1])
            connection.request('GET', '/api/storage/maintenance')
            self.assertEqual(connection.getresponse().status, 403)

            connection.request('GET', f'{desktop_security.BOOTSTRAP_PATH}?token={token}')
            response = connection.getresponse()
            self.assertEqual(response.status, 302)
            cookie = response.getheader('Set-Cookie').split(';', 1)[0]

            connection.request('GET', '/api/storage/maintenance', headers={'Cookie': cookie})
            self.assertNotEqual(connection.getresponse().status, 403)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class DesktopBridgeTests(unittest.TestCase):
    def test_save_file_writes_base64_atomically(self):
        webview = mock.Mock(SAVE_DIALOG=1, FOLDER_DIALOG=2)
        bridge = DesktopBridge('v-test', webview)
        with tempfile.TemporaryDirectory() as directory:
            destination = os.path.join(directory, 'saved.bin')
            window = mock.Mock()
            window.create_file_dialog.return_value = (destination,)
            bridge.attach_window(window)
            result = bridge.save_file('saved.bin', 'application/octet-stream', {
                'encoding': 'base64',
                'data': 'Y2FpbmZsb3c=',
            })
            self.assertEqual(result, destination)
            with open(destination, 'rb') as stream:
                self.assertEqual(stream.read(), b'cainflow')

    def test_external_links_reject_non_http_schemes(self):
        bridge = DesktopBridge('v-test', mock.Mock())
        with self.assertRaises(ValueError):
            bridge.open_external('file:///secret.txt')


class SingleInstanceTests(unittest.TestCase):
    def test_second_lock_is_rejected_until_first_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'desktop.lock')
            first = SingleInstanceLock(path)
            second = SingleInstanceLock(path)
            self.assertTrue(first.acquire())
            self.assertFalse(second.acquire())
            first.release()
            self.assertTrue(second.acquire())
            second.release()


if __name__ == '__main__':
    unittest.main()
