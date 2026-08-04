import ctypes
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser

from backend import config, desktop_security
from backend.main import create_server, get_app_version_tag, initialize_runtime
from backend.services.desktop_bridge import DesktopBridge


WEBVIEW2_DOWNLOAD_URL = 'https://developer.microsoft.com/microsoft-edge/webview2/'


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


def has_webview2_runtime():
    if sys.platform != 'win32':
        return True
    try:
        import winreg
        client_id = r'{F1E7E7F1-4A00-4D58-A94D-5688FE6A4C81}'
        roots = (
            (winreg.HKEY_LOCAL_MACHINE, rf'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{client_id}'),
            (winreg.HKEY_CURRENT_USER, rf'Software\Microsoft\EdgeUpdate\Clients\{client_id}'),
        )
        for root, path in roots:
            try:
                with winreg.OpenKey(root, path):
                    return True
            except OSError:
                continue
    except Exception:
        pass
    candidates = (
        os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'Microsoft', 'EdgeWebView', 'Application'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'EdgeWebView', 'Application'),
    )
    return any(path and os.path.isdir(path) for path in candidates)


def run_desktop():
    try:
        import webview
    except ImportError as error:
        show_native_error('CainFlow 启动失败', f'缺少 pywebview 运行组件：{error}')
        return 1

    if not has_webview2_runtime():
        show_native_error(
            'CainFlow 需要 WebView2',
            '当前系统未检测到 Microsoft Edge WebView2 Runtime。\n请安装后重新启动 CainFlow。'
        )
        webbrowser.open(WEBVIEW2_DOWNLOAD_URL)
        return 1

    instance_lock = SingleInstanceLock(os.path.join(config.DATA_DIR, '.desktop.lock'))
    try:
        os.makedirs(config.DATA_DIR, exist_ok=True)
    except Exception as error:
        show_native_error('CainFlow 数据目录不可用', str(error))
        return 1
    if not instance_lock.acquire():
        show_native_error('CainFlow 已在运行', '请先使用已经打开的 CainFlow 窗口。')
        return 2
    try:
        initialize_runtime()
    except Exception as error:
        instance_lock.release()
        show_native_error('CainFlow 数据初始化失败', str(error))
        return 1

    httpd = None
    server_thread = None
    try:
        token = desktop_security.enable_desktop_session()
        httpd = create_server(config.LOCAL_HOST, 0)
        httpd.daemon_threads = True
        port = httpd.server_address[1]
        config.PORT = port
        server_thread = threading.Thread(target=httpd.serve_forever, name='CainFlowHTTP', daemon=True)
        server_thread.start()

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
        webview.start(func=smoke_worker, args=(window,) if smoke_worker else None, gui=gui, debug=False)
        return 0
    except Exception as error:
        show_native_error('CainFlow 启动失败', str(error))
        return 1
    finally:
        if httpd:
            httpd.shutdown()
            httpd.server_close()
        if server_thread and server_thread.is_alive():
            server_thread.join(timeout=5)
        desktop_security.disable_desktop_session()
        instance_lock.release()
