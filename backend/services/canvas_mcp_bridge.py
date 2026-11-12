from __future__ import annotations

import hmac
import re
import threading
import time
import uuid
from dataclasses import dataclass


POLL_SECONDS = 3
LEASE_SECONDS = 10
COMMAND_SECONDS = 10
MAX_PENDING_COMMANDS = 8
MAX_CALL_BYTES = 1024 * 1024
MAX_EDITOR_BYTES = 6_100_000
MAX_IMAGE_CHARS = 6_000_000
METHODS = frozenset({'read_canvas', 'edit_canvas', 'run_workflow', 'get_workflow_run', 'get_run_image'})
EDITOR_ID_PATTERN = re.compile(r'[a-zA-Z0-9_-]{1,128}')


class CanvasMcpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def validate_canvas_mcp_token(token):
    if not isinstance(token, str) or len(token) < 32 or any(not '!' <= char <= '~' for char in token):
        raise ValueError('CAINFLOW_MCP_TOKEN must have at least 32 visible ASCII characters')
    return token


def is_editor_id(value):
    return isinstance(value, str) and EDITOR_ID_PATTERN.fullmatch(value) is not None


@dataclass
class _Command:
    id: str
    method: str
    args: dict
    deadline: float
    delivered: bool = False
    response: dict | None = None
    error: CanvasMcpError | None = None


class CanvasMcpBridge:
    """Dispatch bounded requests to the one currently leased CainFlow editor."""

    def __init__(self, token):
        self._token = validate_canvas_mcp_token(token).encode('ascii')
        self._condition = threading.Condition()
        self._editor_id = None
        self._lease_deadline = 0
        self._commands = {}
        self._closed = False

    def is_authorized(self, authorization):
        scheme, separator, value = authorization.partition(' ')
        return separator == ' ' and scheme.lower() == 'bearer' and hmac.compare_digest(
            value.encode('utf-8'), self._token)

    def _fail(self, command, status, message):
        if command.delivered:
            message += ' The command was already delivered and its outcome may be unknown.'
        command.error = CanvasMcpError(status, message)
        del self._commands[command.id]

    def _revoke_editor(self, status, message):
        self._editor_id = None
        for command in list(self._commands.values()):
            self._fail(command, status, message)
        self._condition.notify_all()

    def _expire(self, now):
        expired = [command for command in self._commands.values() if command.deadline <= now]
        for command in expired:
            self._fail(command, 504, 'The CainFlow editor did not finish in time.')
        if expired:
            self._condition.notify_all()
        if self._editor_id is not None and self._lease_deadline <= now:
            self._revoke_editor(409, 'The CainFlow editor connection expired.')

    def _require_open(self):
        if self._closed:
            raise CanvasMcpError(503, 'The CainFlow editor bridge is shutting down.')

    def _require_current_editor(self, editor_id):
        if editor_id != self._editor_id:
            raise CanvasMcpError(409, 'This CainFlow editor is no longer current.')

    def call(self, method, args):
        if not isinstance(method, str) or method not in METHODS or not isinstance(args, dict):
            raise CanvasMcpError(400, 'Unknown canvas method or invalid arguments.')
        editor_id = args.get('editorId')
        if (method != 'read_canvas' or 'editorId' in args) and not is_editor_id(editor_id):
            raise CanvasMcpError(400, 'A valid editorId from read_canvas is required.')

        with self._condition:
            self._require_open()
            now = time.monotonic()
            self._expire(now)
            if self._editor_id is None:
                raise CanvasMcpError(409, 'Open or focus a CainFlow editor to connect.')
            if editor_id is not None:
                self._require_current_editor(editor_id)
            if len(self._commands) >= MAX_PENDING_COMMANDS:
                raise CanvasMcpError(429, 'The CainFlow editor command queue is full.')

            command = _Command(uuid.uuid4().hex, method, args, now + COMMAND_SECONDS)
            self._commands[command.id] = command
            self._condition.notify_all()
            while command.response is None and command.error is None:
                self._condition.wait(max(0, min(command.deadline, self._lease_deadline) - time.monotonic()))
                self._expire(time.monotonic())
            if command.error is not None:
                raise command.error
            return command.response

    def poll(self, editor_id, activate):
        with self._condition:
            self._require_open()
            now = time.monotonic()
            self._expire(now)
            if activate and editor_id != self._editor_id:
                self._revoke_editor(409, 'The current CainFlow editor changed.')
                self._editor_id = editor_id
            self._require_current_editor(editor_id)
            self._lease_deadline = now + LEASE_SECONDS
            deadline = now + POLL_SECONDS

            while True:
                self._require_open()
                now = time.monotonic()
                self._expire(now)
                self._require_current_editor(editor_id)
                command = next(iter(self._commands.values()), None)
                if command and not command.delivered:
                    command.delivered = True
                    self._lease_deadline = max(self._lease_deadline, command.deadline)
                    return {'command': {'id': command.id, 'method': command.method, 'args': command.args}}
                remaining = deadline - now
                if remaining <= 0:
                    return {'command': None}
                self._condition.wait(remaining)

    def complete(self, editor_id, command_id, response, response_bytes):
        with self._condition:
            self._require_open()
            now = time.monotonic()
            self._expire(now)
            self._require_current_editor(editor_id)
            command = self._commands.get(command_id)
            if command is None or not command.delivered:
                raise CanvasMcpError(409, 'The canvas command is no longer pending.')

            result = response.get('result')
            if command.method == 'get_run_image' and 'result' in response and not (
                    isinstance(result, dict) and isinstance(result.get('mimeType'), str)
                    and result['mimeType'].startswith('image/') and isinstance(result.get('data'), str)
                    and 0 < len(result['data']) <= MAX_IMAGE_CHARS):
                self._fail(command, 502, 'The CainFlow editor returned an invalid or oversized run image.')
            elif command.method != 'get_run_image' and response_bytes > MAX_CALL_BYTES:
                self._fail(command, 413, 'The canvas command response exceeded the size limit.')
            elif command.method == 'read_canvas' and 'result' in response and not isinstance(result, dict):
                self._fail(command, 502, 'The CainFlow editor returned an invalid canvas snapshot.')
            else:
                if command.method == 'read_canvas' and 'result' in response:
                    response = {'result': {**result, 'editorId': editor_id}}
                command.response = response
                del self._commands[command.id]
            self._lease_deadline = now + LEASE_SECONDS
            self._condition.notify_all()
            return {'ok': True}

    def close(self):
        with self._condition:
            self._closed = True
            self._revoke_editor(503, 'The CainFlow editor bridge is shutting down.')
