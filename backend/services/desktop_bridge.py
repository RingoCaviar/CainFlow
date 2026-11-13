import base64
import errno
import os
import re
import subprocess
import sys
import tempfile
import threading
import uuid
import webbrowser
from contextlib import suppress
from urllib.parse import urlparse

from backend import config
from backend.services.storage_service import storage_service
from backend.services.image_clipboard import copy_png_to_clipboard
from backend.services.windows_taskbar_service import WindowsTaskbarService


_DOS_DEVICE_NAME = re.compile(r'CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³]')
_LINK_UNAVAILABLE = {errno.EOPNOTSUPP, errno.ENOTSUP, errno.ENOSYS, errno.EPERM}


class DesktopBridge:
    def __init__(self, app_version, webview_module, taskbar_service=None):
        self._app_version = app_version
        self._webview = webview_module
        self._window = None
        self._close_allowed = False
        self._taskbar_service = taskbar_service or WindowsTaskbarService()
        self._directory_save = None
        self._directory_save_lock = threading.Lock()

    def attach_window(self, window):
        self._window = window
        self._taskbar_service.attach_window(window)
        closing = getattr(getattr(window, 'events', None), 'closing', None)
        if hasattr(type(closing), '__iadd__'):
            window.events.closing += self._request_close

    def _request_close(self):
        if self._close_allowed:
            return True
        def prepare():
            try:
                self._window.evaluate_js('window.cainflowPrepareExit ? window.cainflowPrepareExit() : window.pywebview.api.finish_close()')
            except Exception:
                # A broken renderer must not silently discard unsaved edits.
                pass
        threading.Thread(target=prepare, daemon=True).start()
        return False

    def finish_close(self):
        self._close_allowed = True
        self._window.destroy()
        return True

    def restart_after_update(self, job_id):
        from backend.services import update_service
        update_service.request_update_restart(job_id)
        try:
            return self.finish_close()
        except Exception:
            self._close_allowed = False
            update_service.cancel_update_restart(job_id)
            raise

    def set_taskbar_status(self, status):
        return self._taskbar_service.set_status(status)

    def clear_taskbar_status(self):
        return self._taskbar_service.clear()

    def choose_directory(self):
        if not self._window:
            return None
        result = self._window.create_file_dialog(self._webview.FOLDER_DIALOG)
        return result[0] if result else None

    def begin_directory_save(self):
        directory = self.choose_directory()
        if not directory:
            return None
        directory = os.path.realpath(directory)
        if not os.path.isdir(directory):
            raise ValueError('保存目录不存在')
        token = uuid.uuid4().hex
        with self._directory_save_lock:
            self._directory_save = (token, directory)
        return token

    def save_file_to_directory(self, token, name, payload):
        if (not isinstance(name, str) or not name or name.endswith(('.', ' '))
                or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
                or _DOS_DEVICE_NAME.fullmatch(name.partition('.')[0].rstrip(' ').upper())):
            raise ValueError('无效的保存文件名')
        with self._directory_save_lock:
            if not self._directory_save or self._directory_save[0] != token:
                raise ValueError('保存目录授权已失效，请重新选择')
            _, directory = self._directory_save
            destination = os.path.join(directory, name)
            return self._write_save_content(destination, self._decode_payload(payload), keep_existing=True)

    def end_directory_save(self, token):
        with self._directory_save_lock:
            if self._directory_save and self._directory_save[0] == token:
                self._directory_save = None

    def save_file(self, name, mime='', payload=None):
        if not self._window:
            return None
        safe_name = os.path.basename(str(name or 'CainFlow-export'))
        result = self._window.create_file_dialog(
            self._webview.SAVE_DIALOG,
            save_filename=safe_name
        )
        if not result:
            return None
        destination = result[0] if isinstance(result, (list, tuple)) else result
        content = self._decode_payload(payload)
        parent = os.path.dirname(os.path.abspath(destination))
        os.makedirs(parent, exist_ok=True)
        self._write_save_content(destination, content)
        return destination

    @staticmethod
    def _write_save_content(destination, content, *, keep_existing=False):
        parent = os.path.dirname(os.path.abspath(destination))
        fd, temp_path = tempfile.mkstemp(prefix='.cainflow-save-', dir=parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            if not keep_existing:
                os.replace(temp_path, destination)
                return destination

            # Publish the completed file atomically without replacing existing files.
            windows = os.name == 'nt'
            publish = os.rename if windows else os.link
            stem, extension = os.path.splitext(destination)
            number = 0
            candidate = destination
            while True:
                try:
                    if publish:
                        publish(temp_path, candidate)
                    else:
                        DesktopBridge._write_exclusive_save_content(candidate, content)
                    return candidate
                except FileExistsError:
                    number += 1
                    candidate = f'{stem} ({number}){extension}'
                except OSError as error:
                    if windows or not publish or error.errno not in _LINK_UNAVAILABLE:
                        raise
                    # Some removable and network filesystems cannot create hard links.
                    publish = None
        finally:
            with suppress(OSError):
                os.unlink(temp_path)

    @staticmethod
    def _write_exclusive_save_content(destination, content):
        stream = open(destination, 'xb')
        try:
            with stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            with suppress(OSError):
                os.unlink(destination)
            raise

    def copy_image(self, payload):
        return copy_png_to_clipboard(self._decode_payload(payload))

    def open_external(self, url):
        parsed = urlparse(str(url or ''))
        if parsed.scheme not in {'http', 'https'}:
            raise ValueError('Only HTTP and HTTPS URLs may be opened')
        return bool(webbrowser.open(parsed.geturl()))

    def open_directory(self, path):
        target = os.path.realpath(str(path or ''))
        allowed = [
            os.path.realpath(config.DATA_DIR),
            os.path.realpath(config.WORKFLOWS_DIR),
            os.path.realpath(config.EXPORTS_DIR),
            os.path.realpath(storage_service.get_export_directory()),
        ]
        if not any(target == root or target.startswith(root + os.sep) for root in allowed):
            raise ValueError('Directory is outside CainFlow managed locations')
        if not os.path.isdir(target):
            raise ValueError('Directory does not exist')
        if sys.platform == 'win32':
            os.startfile(target)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target])
        else:
            subprocess.Popen(['xdg-open', target])
        return True

    def get_runtime_info(self):
        return {
            'desktop': True,
            'updateRestart': bool(getattr(sys, 'frozen', False)) and sys.platform in ('win32', 'darwin'),
            'platform': sys.platform,
            'version': self._app_version,
            'dataDirectory': config.DATA_DIR,
            'workflowsDirectory': config.WORKFLOWS_DIR,
            'exportsDirectory': config.EXPORTS_DIR,
        }

    @staticmethod
    def _decode_payload(payload):
        if isinstance(payload, dict):
            encoding = payload.get('encoding')
            data = payload.get('data', '')
            if encoding == 'base64':
                return base64.b64decode(data, validate=True)
            return str(data).encode('utf-8')
        if isinstance(payload, str):
            return payload.encode('utf-8')
        raise ValueError('Unsupported save payload')
