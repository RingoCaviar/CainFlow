import http.client
import os
import tempfile
import threading
import unittest
from unittest import mock

from backend import desktop_security
from backend import desktop
from backend import native_dialogs
from backend.desktop import SingleInstanceLock
from backend.handler import ProxyHTTPRequestHandler
from backend.native_dialogs import (
    BROWSER_STATUS_REOPEN,
    BROWSER_STATUS_STOP,
    PORT_CHOICE_EXIT,
    PORT_CHOICE_RANDOM,
    WEBVIEW_CHOICE_BROWSER,
    WEBVIEW_CHOICE_EXIT,
    WEBVIEW_CHOICE_INSTALL,
)
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


class BrowserFallbackTests(unittest.TestCase):
    def test_browser_fallback_prefers_8767_and_reopens_same_url(self):
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        browser_open = mock.Mock(return_value=True)
        status_dialog = mock.Mock(side_effect=[BROWSER_STATUS_REOPEN, BROWSER_STATUS_STOP])
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(httpd, server_thread, 8767)) as start_server, \
                mock.patch.object(desktop, '_stop_local_server') as stop_server:
            result = desktop.run_browser_fallback(browser_open=browser_open, status_dialog=status_dialog)

        self.assertEqual(result, 0)
        self.assertEqual(browser_open.call_args_list, [
            mock.call('http://127.0.0.1:8767'),
            mock.call('http://127.0.0.1:8767'),
        ])
        start_server.assert_called_once_with(8767)
        stop_server.assert_called_once_with(httpd, server_thread)
        instance_lock.release.assert_called_once_with()

    def test_browser_open_failure_stops_server_and_releases_lock(self):
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(httpd, server_thread, 8767)), \
                mock.patch.object(desktop, '_stop_local_server') as stop_server, \
                mock.patch.object(desktop, 'show_native_error') as show_error:
            result = desktop.run_browser_fallback(browser_open=mock.Mock(return_value=False))

        self.assertEqual(result, 1)
        show_error.assert_called_once()
        stop_server.assert_called_once_with(httpd, server_thread)
        instance_lock.release.assert_called_once_with()

    def test_browser_fallback_asks_before_using_random_port(self):
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        port_dialog = mock.Mock(return_value=PORT_CHOICE_RANDOM)
        browser_open = mock.Mock(return_value=True)
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', side_effect=[OSError('address unavailable'), (httpd, server_thread, 43210)]) as start_server, \
                mock.patch.object(desktop, '_stop_local_server') as stop_server:
            result = desktop.run_browser_fallback(
                browser_open=browser_open,
                status_dialog=mock.Mock(return_value=BROWSER_STATUS_STOP),
                port_dialog=port_dialog,
            )

        self.assertEqual(result, 0)
        self.assertEqual(start_server.call_args_list, [mock.call(8767), mock.call(0)])
        port_dialog.assert_called_once_with(8767, 'address unavailable')
        browser_open.assert_called_once_with('http://127.0.0.1:43210')
        stop_server.assert_called_once_with(httpd, server_thread)
        instance_lock.release.assert_called_once_with()

    def test_browser_fallback_exits_when_random_port_is_declined(self):
        instance_lock = mock.Mock()
        port_dialog = mock.Mock(return_value=PORT_CHOICE_EXIT)
        browser_open = mock.Mock()
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', side_effect=OSError('reserved')) as start_server, \
                mock.patch.object(desktop, '_stop_local_server') as stop_server:
            result = desktop.run_browser_fallback(browser_open=browser_open, port_dialog=port_dialog)

        self.assertEqual(result, 0)
        start_server.assert_called_once_with(8767)
        browser_open.assert_not_called()
        stop_server.assert_called_once_with(None, None)
        instance_lock.release.assert_called_once_with()

    def test_missing_webview_choice_routes_to_requested_action(self):
        with mock.patch.object(desktop, 'choose_webview_missing_action', return_value=WEBVIEW_CHOICE_BROWSER), \
                mock.patch.object(desktop, 'run_browser_fallback', return_value=0) as fallback:
            self.assertEqual(desktop._handle_missing_webview(), 0)
            fallback.assert_called_once_with()

        with mock.patch.object(desktop, 'choose_webview_missing_action', return_value=WEBVIEW_CHOICE_INSTALL), \
                mock.patch.object(desktop.webbrowser, 'open', return_value=True) as browser_open:
            self.assertEqual(desktop._handle_missing_webview(), 0)
            browser_open.assert_called_once_with(desktop.WEBVIEW2_DOWNLOAD_URL)

        with mock.patch.object(desktop, 'choose_webview_missing_action', return_value=WEBVIEW_CHOICE_EXIT), \
                mock.patch.object(desktop.webbrowser, 'open') as browser_open:
            self.assertEqual(desktop._handle_missing_webview(), 0)
            browser_open.assert_not_called()

    def test_install_page_failure_returns_error(self):
        with mock.patch.object(desktop, 'choose_webview_missing_action', return_value=WEBVIEW_CHOICE_INSTALL), \
                mock.patch.object(desktop.webbrowser, 'open', return_value=False), \
                mock.patch.object(desktop, 'show_native_error') as show_error:
            self.assertEqual(desktop._handle_missing_webview(), 1)
            show_error.assert_called_once()

    def test_local_server_requests_loopback_random_port(self):
        httpd = mock.Mock()
        httpd.server_address = ('127.0.0.1', 45678)
        thread = mock.Mock()
        with mock.patch.object(desktop.config, 'PORT', 8767), \
                mock.patch.object(desktop, 'create_server', return_value=httpd) as create_server, \
                mock.patch.object(desktop.threading, 'Thread', return_value=thread):
            created_httpd, created_thread, port = desktop._start_local_server(0)

        create_server.assert_called_once_with('127.0.0.1', 0)
        self.assertIs(created_httpd, httpd)
        self.assertIs(created_thread, thread)
        self.assertEqual(port, 45678)
        thread.start.assert_called_once_with()


class NativeDialogTests(unittest.TestCase):
    def test_webview_choice_maps_custom_buttons_and_window_close(self):
        expected = {
            101: WEBVIEW_CHOICE_BROWSER,
            102: WEBVIEW_CHOICE_INSTALL,
            103: WEBVIEW_CHOICE_EXIT,
            0: WEBVIEW_CHOICE_EXIT,
        }
        for selected, choice in expected.items():
            with self.subTest(selected=selected), \
                    mock.patch.object(native_dialogs.sys, 'platform', 'win32'), \
                    mock.patch.object(native_dialogs, '_show_windows_task_dialog', return_value=selected):
                self.assertEqual(native_dialogs.choose_webview_missing_action(), choice)

    def test_browser_status_maps_reopen_and_close(self):
        for selected, expected in ((201, BROWSER_STATUS_REOPEN), (202, BROWSER_STATUS_STOP), (0, BROWSER_STATUS_STOP)):
            with self.subTest(selected=selected), \
                    mock.patch.object(native_dialogs.sys, 'platform', 'win32'), \
                    mock.patch.object(native_dialogs, '_show_windows_task_dialog', return_value=selected):
                self.assertEqual(native_dialogs.show_browser_mode_status('http://127.0.0.1:43210'), expected)

    def test_random_port_choice_maps_use_and_exit(self):
        for selected, expected in ((301, PORT_CHOICE_RANDOM), (302, PORT_CHOICE_EXIT), (0, PORT_CHOICE_EXIT)):
            with self.subTest(selected=selected), \
                    mock.patch.object(native_dialogs.sys, 'platform', 'win32'), \
                    mock.patch.object(native_dialogs, '_show_windows_task_dialog', return_value=selected):
                self.assertEqual(native_dialogs.choose_random_port_action(8767, 'reserved'), expected)


if __name__ == '__main__':
    unittest.main()
