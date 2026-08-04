import base64
import os
import subprocess
import sys
import tempfile
import webbrowser
from urllib.parse import urlparse

from backend import config
from backend.services.storage_service import storage_service


class DesktopBridge:
    def __init__(self, app_version, webview_module):
        self._app_version = app_version
        self._webview = webview_module
        self._window = None

    def attach_window(self, window):
        self._window = window

    def choose_directory(self):
        if not self._window:
            return None
        result = self._window.create_file_dialog(self._webview.FOLDER_DIALOG)
        return result[0] if result else None

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
        fd, temp_path = tempfile.mkstemp(prefix='.cainflow-save-', dir=parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, destination)
        except Exception:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise
        return destination

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
