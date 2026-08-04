import http.client
import ctypes
import os
import tempfile
import threading
import types
from datetime import datetime, timedelta
import unittest
from unittest import mock

from backend import desktop_security
from backend import desktop
from backend import native_dialogs
from backend import webview2_runtime
from backend import browser_status_window
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
    def test_loader_query_returns_version_and_frees_native_memory(self):
        version_buffer = ctypes.create_unicode_buffer('123.0.4567.8')
        query = mock.Mock()

        def query_version(_folder, output_pointer):
            ctypes.cast(output_pointer, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.cast(
                version_buffer,
                ctypes.c_void_p,
            )
            return 0

        query.side_effect = query_version
        loader = mock.Mock(GetAvailableCoreWebView2BrowserVersionString=query)
        memory_free = mock.Mock()

        hresult, version = webview2_runtime.query_webview2_loader(
            'WebView2Loader.dll',
            dll_loader=mock.Mock(return_value=loader),
            memory_free=memory_free,
        )

        self.assertEqual(hresult, 0)
        self.assertEqual(version, '123.0.4567.8')
        memory_free.assert_called_once()

    def test_loader_detection_classifies_versions_and_hresult(self):
        with tempfile.TemporaryDirectory() as directory:
            loader_path = os.path.join(directory, 'WebView2Loader.dll')
            open(loader_path, 'wb').close()
            cases = (
                ((0, '123.0.4567.8'), webview2_runtime.WEBVIEW2_STATUS_AVAILABLE),
                ((0, ''), webview2_runtime.WEBVIEW2_STATUS_INVALID),
                ((0, 'not-a-version'), webview2_runtime.WEBVIEW2_STATUS_INVALID),
                ((0x80070002, ''), webview2_runtime.WEBVIEW2_STATUS_MISSING),
                ((0x80004005, ''), webview2_runtime.WEBVIEW2_STATUS_INVALID),
            )
            for response, expected_status in cases:
                with self.subTest(response=response), \
                        mock.patch.object(webview2_runtime.sys, 'platform', 'win32'):
                    status = webview2_runtime.detect_webview2_runtime(
                        loader_path=loader_path,
                        version_query=mock.Mock(return_value=response),
                    )
                    self.assertEqual(status.status, expected_status)

    def test_loader_detection_rejects_missing_or_unloadable_loader(self):
        with mock.patch.object(webview2_runtime.sys, 'platform', 'win32'):
            status = webview2_runtime.detect_webview2_runtime(loader_path='missing-loader.dll')
        self.assertEqual(status.status, webview2_runtime.WEBVIEW2_STATUS_MISSING)

        with tempfile.TemporaryDirectory() as directory:
            loader_path = os.path.join(directory, 'WebView2Loader.dll')
            open(loader_path, 'wb').close()
            wrong_architecture = OSError('不是有效的 Win32 应用程序')
            wrong_architecture.winerror = 193
            with mock.patch.object(webview2_runtime.sys, 'platform', 'win32'):
                status = webview2_runtime.detect_webview2_runtime(
                    loader_path=loader_path,
                    version_query=mock.Mock(side_effect=wrong_architecture),
                )
        self.assertEqual(status.status, webview2_runtime.WEBVIEW2_STATUS_INVALID)

    def test_initialization_hook_reports_success_or_failure_event(self):
        original_handler = mock.Mock()

        class FakeEdgeChrome:
            on_webview_ready = original_handler

        edge_module = types.SimpleNamespace(EdgeChrome=FakeEdgeChrome)
        result = webview2_runtime.WebView2InitializationResult()
        restore = webview2_runtime.install_webview2_initialization_hook(result, edge_module)
        instance = mock.Mock()

        FakeEdgeChrome.on_webview_ready(instance, mock.Mock(), mock.Mock(IsSuccess=True))
        self.assertEqual(result.status, webview2_runtime.WEBVIEW2_INIT_SUCCESS)
        instance.form.Close.assert_not_called()

        failure = mock.Mock(IsSuccess=False, InitializationException='runtime unavailable')
        FakeEdgeChrome.on_webview_ready(instance, mock.Mock(), failure)
        self.assertEqual(result.status, webview2_runtime.WEBVIEW2_INIT_FAILED)
        self.assertEqual(result.error, 'runtime unavailable')
        instance.form.Close.assert_called_once_with()
        restore()
        self.assertIs(FakeEdgeChrome.on_webview_ready, original_handler)

    def test_missing_webview_is_handled_before_runtime_or_window_creation(self):
        missing = webview2_runtime.WebView2RuntimeStatus(webview2_runtime.WEBVIEW2_STATUS_MISSING)
        fake_webview = mock.Mock()
        with mock.patch.dict('sys.modules', {'webview': fake_webview}), \
                mock.patch.object(desktop, 'detect_webview2_runtime', return_value=missing), \
                mock.patch.object(desktop, '_handle_missing_webview', return_value=0) as fallback, \
                mock.patch.object(desktop, '_prepare_runtime_lock') as prepare_runtime:
            self.assertEqual(desktop.run_desktop(), 0)

        fallback.assert_called_once_with('')
        prepare_runtime.assert_not_called()
        fake_webview.create_window.assert_not_called()

    def test_webview_start_failure_cleans_up_before_browser_fallback(self):
        available = webview2_runtime.WebView2RuntimeStatus(webview2_runtime.WEBVIEW2_STATUS_AVAILABLE, '123.0.0.0')
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        fake_webview = mock.Mock()
        fake_webview.start.side_effect = RuntimeError('WebView2 initialization failed')
        order = []
        with mock.patch.dict('sys.modules', {'webview': fake_webview}), \
                mock.patch.object(desktop.sys, 'platform', 'win32'), \
                mock.patch.object(desktop, 'detect_webview2_runtime', return_value=available), \
                mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(httpd, server_thread, 45678)), \
                mock.patch.object(desktop, '_stop_local_server', side_effect=lambda *_: order.append('stop')), \
                mock.patch.object(desktop, 'install_webview2_initialization_hook', return_value=mock.Mock()), \
                mock.patch.object(desktop.desktop_security, 'enable_desktop_session', return_value='token'), \
                mock.patch.object(desktop.desktop_security, 'disable_desktop_session', side_effect=lambda: order.append('security')), \
                mock.patch.object(instance_lock, 'release', side_effect=lambda: order.append('lock')), \
                mock.patch.object(desktop, '_handle_missing_webview', side_effect=lambda _reason='': order.append('fallback') or 0):
            self.assertEqual(desktop.run_desktop(), 0)

        self.assertEqual(order, ['stop', 'security', 'lock', 'fallback'])
        fake_webview.create_window.return_value.destroy.assert_called_once_with()

    def test_error_after_successful_webview_initialization_is_not_missing_runtime(self):
        available = webview2_runtime.WebView2RuntimeStatus(webview2_runtime.WEBVIEW2_STATUS_AVAILABLE, '123.0.0.0')
        initialized = webview2_runtime.WebView2InitializationResult(webview2_runtime.WEBVIEW2_INIT_SUCCESS)
        fake_webview = mock.Mock()
        fake_webview.start.side_effect = RuntimeError('page startup failed')
        with mock.patch.dict('sys.modules', {'webview': fake_webview}), \
                mock.patch.object(desktop.sys, 'platform', 'win32'), \
                mock.patch.object(desktop, 'detect_webview2_runtime', return_value=available), \
                mock.patch.object(desktop, 'WebView2InitializationResult', return_value=initialized), \
                mock.patch.object(desktop, 'install_webview2_initialization_hook', return_value=mock.Mock()), \
                mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(mock.Mock(), 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(mock.Mock(), mock.Mock(), 45678)), \
                mock.patch.object(desktop, '_stop_local_server'), \
                mock.patch.object(desktop.desktop_security, 'enable_desktop_session', return_value='token'), \
                mock.patch.object(desktop.desktop_security, 'disable_desktop_session'), \
                mock.patch.object(desktop, '_handle_missing_webview') as fallback, \
                mock.patch.object(desktop, 'show_native_error') as show_error:
            self.assertEqual(desktop.run_desktop(), 1)

        fallback.assert_not_called()
        show_error.assert_called_once_with('CainFlow 启动失败', 'page startup failed')

    def test_browser_fallback_prefers_8767_and_reopens_same_url(self):
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        browser_open = mock.Mock(return_value=True)
        status_window = mock.Mock(side_effect=lambda _status, reopen, _open_logs, _stop: reopen())
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(httpd, server_thread, 8767)) as start_server, \
                mock.patch.object(desktop, '_stop_local_server') as stop_server:
            result = desktop.run_browser_fallback(browser_open=browser_open, status_window=status_window)

        self.assertEqual(result, 0)
        self.assertEqual(browser_open.call_args_list, [
            mock.call('http://127.0.0.1:8767'),
            mock.call('http://127.0.0.1:8767'),
        ])
        start_server.assert_called_once_with(8767)
        status_window.assert_called_once()
        self.assertEqual(status_window.call_args.args[0].port, 8767)
        stop_server.assert_called_once_with(httpd, server_thread)
        instance_lock.release.assert_called_once_with()

    def test_browser_open_failure_stops_server_and_releases_lock(self):
        instance_lock = mock.Mock()
        httpd = mock.Mock()
        server_thread = mock.Mock()
        status_window = mock.Mock()
        browser_open = mock.Mock(return_value=False)
        with mock.patch.object(desktop, '_prepare_runtime_lock', return_value=(instance_lock, 0)), \
                mock.patch.object(desktop, '_start_local_server', return_value=(httpd, server_thread, 8767)), \
                mock.patch.object(desktop, '_stop_local_server') as stop_server:
            result = desktop.run_browser_fallback(browser_open=browser_open, status_window=status_window)

        self.assertEqual(result, 0)
        status = status_window.call_args.args[0]
        self.assertIn('无法打开系统默认浏览器', '\n'.join(status.event_lines()))
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
                status_window=mock.Mock(),
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
            fallback.assert_called_once_with(webview_reason='')

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


class BrowserStatusWindowTests(unittest.TestCase):
    def make_status(self, **overrides):
        values = {
            'version': 'v-test',
            'url': 'http://127.0.0.1:43210',
            'host': '127.0.0.1',
            'port': 43210,
            'started_at': datetime.now().astimezone() - timedelta(seconds=65),
            'data_dir': r'C:\CainFlow\data',
            'database_path': r'C:\CainFlow\data\cainflow.db',
            'workflows_dir': r'C:\CainFlow\workflows',
            'exports_dir': r'C:\CainFlow\exports',
            'log_dir': r'C:\CainFlow\log',
            'random_port': True,
            'port_fallback_reason': '端口被占用',
            'webview_reason': 'Runtime 不可用',
        }
        values.update(overrides)
        return browser_status_window.BrowserServiceStatus(**values)

    def test_terminal_text_contains_service_status_without_sensitive_data(self):
        status = self.make_status()
        status.add_event('HTTP 服务已启动')
        text = status.render_terminal_text(now=status.started_at + timedelta(seconds=65))

        self.assertIn('v-test', text)
        self.assertIn('127.0.0.1:43210', text)
        self.assertIn('系统随机端口', text)
        self.assertIn('00:01:05', text)
        self.assertIn(r'C:\CainFlow\data\cainflow.db', text)
        self.assertIn('Runtime 不可用', text)
        self.assertNotIn('api_key', text.lower())
        self.assertNotIn('authorization', text.lower())

    def test_event_buffer_is_bounded(self):
        status = self.make_status()
        for index in range(120):
            status.add_event(f'event-{index}')
        events = status.event_lines()
        self.assertEqual(len(events), 100)
        self.assertIn('event-20', events[0])

    def test_winforms_failure_falls_back_to_task_dialog_runner(self):
        status = self.make_status()
        fallback = mock.Mock()
        reopen = mock.Mock()
        stop = mock.Mock()
        with mock.patch.object(browser_status_window.sys, 'platform', 'win32'):
            browser_status_window.show_browser_service_window(
                status,
                reopen,
                mock.Mock(),
                stop,
                winforms_runner=mock.Mock(side_effect=RuntimeError('WinForms unavailable')),
                fallback_runner=fallback,
            )

        fallback.assert_called_once_with(status, reopen, stop)
        self.assertIn('已切换到简易窗口', '\n'.join(status.event_lines()))


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
