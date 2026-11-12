import json
import os
from pathlib import Path
import secrets
import shlex
import sys
import tempfile
import threading

from backend import config
from backend.services.canvas_mcp_bridge import CanvasMcpBridge, CanvasMcpError, validate_canvas_mcp_token


PRIVATE_DIRECTORY_NAME = '.canvas-mcp'


def _write_atomic(path, content):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _install_command(python, requirements):
    if os.name == 'nt':
        quoted_python = "'" + python.replace("'", "''") + "'"
        quoted_requirements = "'" + str(requirements).replace("'", "''") + "'"
        return f'& {quoted_python} -m pip install -r {quoted_requirements}'
    return shlex.join([python, '-m', 'pip', 'install', '-r', str(requirements)])


class CanvasMcpSettings:
    def __init__(self, data_dir, startup_token=None):
        self.private_directory = (Path(data_dir) / PRIVATE_DIRECTORY_NAME).resolve()
        self._settings_path = self.private_directory / 'settings.state'
        self._lock = threading.Lock()
        self._closed = False
        enabled, self._token = self._load(startup_token)
        self._bridge = CanvasMcpBridge(self._token) if enabled else None

    def _load(self, startup_token):
        try:
            with self._settings_path.open('rb') as file:
                settings = json.load(file)
            if not isinstance(settings, dict) or type(settings.get('enabled')) is not bool:
                return False, None
            return settings['enabled'], validate_canvas_mcp_token(settings.get('token'))
        except FileNotFoundError:
            if startup_token is not None:
                return True, validate_canvas_mcp_token(startup_token)
        except (OSError, ValueError, RecursionError):
            # A malformed or unreadable saved preference cannot activate MCP.
            pass
        return False, None

    @property
    def bridge(self):
        with self._lock:
            return self._bridge

    def is_private_static_path(self, path):
        candidate = Path(path)
        resolved = candidate.resolve()
        return (resolved.is_relative_to(self.private_directory) or any(
            component.casefold() == PRIVATE_DIRECTORY_NAME for component in (*candidate.parts, *resolved.parts)
        ))

    def set_enabled(self, enabled):
        with self._lock:
            if self._closed:
                raise CanvasMcpError(503, 'The CainFlow canvas bridge is shutting down.')
            if enabled == (self._bridge is not None):
                return
            token = self._token or secrets.token_urlsafe(32)
            # Save the desired state before changing the running service.
            try:
                _write_atomic(self._settings_path, json.dumps({'enabled': enabled, 'token': token}).encode('ascii'))
            except OSError as error:
                raise CanvasMcpError(500, 'Could not save the CainFlow Canvas MCP setting.') from error
            self._token = token
            if enabled:
                self._bridge = CanvasMcpBridge(token)
            else:
                self._bridge.close()
                self._bridge = None

    def _client_files(self):
        frozen = getattr(sys, 'frozen', False)
        source = Path(config.STATIC_ROOT if frozen else config.PROJECT_ROOT)
        adapter = source / 'canvas_mcp.py'
        requirements = source / 'requirements-mcp.txt'
        if not adapter.is_file() or not requirements.is_file():
            return None
        if frozen:
            python = 'python' if os.name == 'nt' else 'python3'
            return python, adapter, requirements, self.private_directory
        return sys.executable, adapter, requirements, source

    def status(self, port):
        client_files = self._client_files()
        install_command = None
        if client_files is not None:
            python, _, requirements, directory = client_files
            install_command = _install_command(python, directory / requirements.name)
        return {
            'enabled': self.bridge is not None,
            'port': port,
            'stdioAvailable': client_files is not None,
            'installCommand': install_command,
        }

    def client_configuration(self, port):
        with self._lock:
            if self._bridge is None:
                raise CanvasMcpError(409, 'Enable CainFlow Canvas MCP to get a client configuration.')
            client_files = self._client_files()
            if client_files is None:
                raise CanvasMcpError(409, 'The CainFlow MCP client files are unavailable.')
            python, adapter, requirements, directory = client_files
            if directory == self.private_directory:
                try:
                    for source in (adapter, requirements):
                        destination = directory / source.name
                        content = source.read_bytes()
                        if not destination.is_file() or destination.read_bytes() != content:
                            _write_atomic(destination, content)
                except OSError as error:
                    raise CanvasMcpError(500, 'Could not prepare the CainFlow MCP client files.') from error
            return {
                'config': {'mcpServers': {'cainflow-canvas': {
                    'command': python,
                    'args': [str(directory / adapter.name), '--port', str(port)],
                    'env': {'CAINFLOW_MCP_TOKEN': self._token},
                }}},
                'installCommand': _install_command(python, directory / requirements.name),
            }

    def close(self):
        with self._lock:
            self._closed = True
            if self._bridge is not None:
                self._bridge.close()
                self._bridge = None
