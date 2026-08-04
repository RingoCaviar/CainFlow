import ctypes
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass

from backend import config, desktop_security
from backend.main import create_server, get_app_version_tag, initialize_runtime
from backend.native_dialogs import (
    BROWSER_STATUS_REOPEN,
    PORT_CHOICE_RANDOM,
    WEBVIEW_CHOICE_BROWSER,
    WEBVIEW_CHOICE_INSTALL,
    choose_webview_missing_action,
    choose_random_port_action,
    show_browser_mode_status,
)
from backend.services.desktop_bridge import DesktopBridge


WEBVIEW2_DOWNLOAD_URL = 'https://developer.microsoft.com/microsoft-edge/webview2/'
WEBVIEW2_RUNTIME_CLIENT_ID = r'{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

WEBVIEW2_STATUS_AVAILABLE = 'available'
WEBVIEW2_STATUS_MISSING = 'missing'
WEBVIEW2_STATUS_INVALID = 'invalid'


@dataclass(frozen=True)
class WebView2RuntimeStatus:
    status: str
    version: str = ''
    reason: str = ''

    @property
    def available(self):
        return self.status == WEBVIEW2_STATUS_AVAILABLE


class SingleInstanceLock:
    def __init__(self, path):
        self.path = path
        self.stream = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.stream = open(self.path, 'a+b')
        try:
            if sys.platform == 'win32':
                import msvcrt
                self.stream.seek(0)
                if self.stream.tell() == 0:
                    self.stream.write(b'0')
                    self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (OSError, IOError):
            self.release()
            return False

    def release(self):
        if not self.stream:
            return
        try:
            if sys.platform == 'win32':
                import msvcrt
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        except (OSError, IOError):
            pass
        self.stream.close()
        self.stream = None


def show_native_error(title, message):
    if sys.platform == 'win32':
        ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)
    elif sys.platform == 'darwin':
        escape = lambda value: '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'
        script = f'display alert {escape(title)} message {escape(message)} as critical'
        subprocess.run(['osascript', '-e', script], check=False)
    else:
        print(f'{title}: {message}', file=sys.stderr)


def _is_valid_webview2_version(value):
    version = str(value or '').strip()
    if not version:
        return False
    parts = version.split('.')
    if not all(part.isdigit() for part in parts):
        return False
    return any(int(part) > 0 for part in parts)


def detect_webview2_runtime():
    if sys.platform != 'win32':
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_AVAILABLE, reason='system-webview')
    try:
        import winreg
        locations = (
            (winreg.HKEY_LOCAL_MACHINE, rf'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_RUNTIME_CLIENT_ID}'),
            (winreg.HKEY_LOCAL_MACHINE, rf'SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_RUNTIME_CLIENT_ID}'),
            (winreg.HKEY_CURRENT_USER, rf'Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_RUNTIME_CLIENT_ID}'),
        )
        invalid_versions = []
        for root, path in locations:
            try:
                with winreg.OpenKey(root, path, 0, winreg.KEY_READ) as key:
                    try:
                        version, _ = winreg.QueryValueEx(key, 'pv')
                    except OSError:
                        invalid_versions.append('')
                        continue
                if _is_valid_webview2_version(version):
                    return WebView2RuntimeStatus(WEBVIEW2_STATUS_AVAILABLE, str(version).strip())
                invalid_versions.append(str(version or '').strip())
            except OSError:
                continue
        if invalid_versions:
            return WebView2RuntimeStatus(
                WEBVIEW2_STATUS_INVALID,
                reason='WebView2 Runtime 注册表版本无效',
            )
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_MISSING, reason='未找到 WebView2 Runtime 注册表信息')
    except Exception as error:
        return WebView2RuntimeStatus(WEBVIEW2_STATUS_INVALID, reason=str(error))


def has_webview2_runtime():
    return detect_webview2_runtime().available


def _prepare_runtime_lock():
    instance_lock = SingleInstanceLock(os.path.join(config.DATA_DIR, '.desktop.lock'))
    try:
        os.makedirs(config.DATA_DIR, exist_ok=True)
    except Exception as error:
        show_native_error('CainFlow 数据目录不可用', str(error))
        return None, 1
    if not instance_lock.acquire():
        show_native_error('CainFlow 已在运行', '请先使用已经打开的 CainFlow 窗口。')
        return None, 2
    try:
        initialize_runtime()
    except Exception as error:
        instance_lock.release()
        show_native_error('CainFlow 数据初始化失败', str(error))
        return None, 1
    return instance_lock, 0


def _start_local_server(port=0):
    httpd = create_server(config.LOCAL_HOST, port)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    config.PORT = port
    server_thread = threading.Thread(target=httpd.serve_forever, name='CainFlowHTTP', daemon=True)
    server_thread.start()
    return httpd, server_thread, port


def _stop_local_server(httpd, server_thread):
    if httpd:
        httpd.shutdown()
        httpd.server_close()
    if server_thread and server_thread.is_alive():
        server_thread.join(timeout=5)


def _destroy_window_safely(window):
    if window is None:
        return
    try:
        window.destroy()
    except Exception:
        pass


def run_browser_fallback(
    browser_open=webbrowser.open,
    status_dialog=show_browser_mode_status,
    port_dialog=choose_random_port_action,
):
    instance_lock, result = _prepare_runtime_lock()
    if not instance_lock:
        return result

    httpd = None
    server_thread = None
    try:
        preferred_port = 8767
        try:
            httpd, server_thread, port = _start_local_server(preferred_port)
        except OSError as error:
            if port_dialog(preferred_port, str(error)) != PORT_CHOICE_RANDOM:
                return 0
            httpd, server_thread, port = _start_local_server(0)
        url = f'http://{config.LOCAL_HOST}:{port}'
        if not browser_open(url):
            show_native_error('CainFlow 浏览器启动失败', f'无法打开系统默认浏览器。\n请手动访问：{url}')
            return 1
        while status_dialog(url) == BROWSER_STATUS_REOPEN:
            if not browser_open(url):
                show_native_error('CainFlow 浏览器启动失败', f'无法重新打开系统默认浏览器。\n请手动访问：{url}')
        return 0
    except Exception as error:
        show_native_error('CainFlow 浏览器模式启动失败', str(error))
        return 1
    finally:
        _stop_local_server(httpd, server_thread)
        instance_lock.release()


def _handle_missing_webview():
    choice = choose_webview_missing_action()
    if choice == WEBVIEW_CHOICE_BROWSER:
        return run_browser_fallback()
    if choice == WEBVIEW_CHOICE_INSTALL:
        if not webbrowser.open(WEBVIEW2_DOWNLOAD_URL):
            show_native_error('无法打开 WebView2 安装页面', WEBVIEW2_DOWNLOAD_URL)
            return 1
    return 0


def run_desktop():
    try:
        import webview
    except ImportError as error:
        show_native_error('CainFlow 启动失败', f'缺少 pywebview 运行组件：{error}')
        return 1

    runtime_status = detect_webview2_runtime()
    if not runtime_status.available:
        return _handle_missing_webview()

    instance_lock, result = _prepare_runtime_lock()
    if not instance_lock:
        return result

    httpd = None
    server_thread = None
    startup_error = None
    webview_error = None
    try:
        token = desktop_security.enable_desktop_session()
        httpd, server_thread, port = _start_local_server(0)

        version = get_app_version_tag()
        bridge = DesktopBridge(version, webview)
        url = f'http://{config.LOCAL_HOST}:{port}{desktop_security.BOOTSTRAP_PATH}?token={urllib.parse.quote(token)}'
        window = webview.create_window(
            f'CainFlow {version}',
            url=url,
            js_api=bridge,
            width=1440,
            height=900,
            min_size=(1024, 700),
        )
        bridge.attach_window(window)
        smoke_marker = os.environ.get('CAINFLOW_DESKTOP_SMOKE_MARKER')
        smoke_worker = None
        if smoke_marker:
            def finish_smoke_test(target_window):
                if not target_window.events.shown.wait(20):
                    return
                deadline = time.monotonic() + 20
                app_ready = False
                while time.monotonic() < deadline:
                    try:
                        app_ready = bool(target_window.evaluate_js(
                            "document.readyState === 'complete' && !!window.__cainflowDesktop"
                        ))
                    except Exception:
                        app_ready = False
                    if app_ready:
                        break
                    time.sleep(0.1)
                if not app_ready:
                    return
                with open(smoke_marker, 'w', encoding='utf-8') as stream:
                    stream.write(f'{port}\n{config.DATABASE_PATH}\n')
                time.sleep(0.2)
                target_window.destroy()
            smoke_worker = finish_smoke_test
        gui = 'edgechromium' if sys.platform == 'win32' else None
        try:
            webview.start(func=smoke_worker, args=(window,) if smoke_worker else None, gui=gui, debug=False)
        except Exception as error:
            webview_error = error
            _destroy_window_safely(window)
    except Exception as error:
        startup_error = error
    finally:
        _stop_local_server(httpd, server_thread)
        desktop_security.disable_desktop_session()
        instance_lock.release()

    if webview_error is not None and sys.platform == 'win32':
        return _handle_missing_webview()
    if webview_error is not None:
        show_native_error('CainFlow 启动失败', str(webview_error))
        return 1
    if startup_error is not None:
        show_native_error('CainFlow 启动失败', str(startup_error))
        return 1
    return 0
