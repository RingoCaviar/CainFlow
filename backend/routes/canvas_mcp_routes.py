import ipaddress
import json
import math
from urllib.parse import unquote, urlsplit

from backend import desktop_security
from backend.services.canvas_mcp_bridge import CanvasMcpError, MAX_CALL_BYTES, MAX_EDITOR_BYTES, is_editor_id


PREFIX = '/api/canvas-mcp'
CALL_PATH = PREFIX + '/call'
EDITOR_PATH = PREFIX + '/editor'
SETTINGS_PATH = PREFIX + '/settings'
EDITOR_HEADER = 'X-CainFlow-Canvas-MCP'
BODY_TIMEOUT_SECONDS = 3


def is_canvas_mcp_path(target):
    try:
        path = unquote(urlsplit(target).path)
    except ValueError:
        path = target.partition('?')[0]
    return path == PREFIX or path.startswith(PREFIX + '/')


def _write_response(handler, status, payload=None, extra_headers=None):
    # Do not use the standard diagnostic helpers for credentials or canvas data.
    body = json.dumps(payload, separators=(',', ':')).encode('ascii') if payload is not None else b''
    handler.close_connection = True
    try:
        handler.send_response(status)
        handler.send_header('Content-Length', str(len(body)))
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Connection', 'close')
        if payload is not None:
            handler.send_header('Content-Type', 'application/json')
        for name, value in (extra_headers or {}).items():
            handler.send_header(name, value)
        handler.end_headers()
        if handler.command != 'HEAD' and body:
            handler.wfile.write(body)
    except OSError:
        # A local client can leave during a poll or before a command completes.
        return


def _header_values(handler, name):
    return handler.headers.get_all(name) or []


def _authorize(handler, bridge, editor_role):
    port = handler.server.server_address[1]
    expected_host = f'127.0.0.1:{port}'
    origin_host = '127.0.0.1' if port == 80 else expected_host
    try:
        local_peer = ipaddress.ip_address(handler.client_address[0]).is_loopback
    except ValueError:
        local_peer = False
    if not local_peer or _header_values(handler, 'Host') not in ([expected_host], [origin_host]):
        raise CanvasMcpError(403, 'The canvas bridge is available only through the local CainFlow address.')

    origins = _header_values(handler, 'Origin')
    if editor_role is not None:
        if (origins != ['http://' + origin_host] or _header_values(handler, EDITOR_HEADER) != [editor_role]
                or not desktop_security.is_api_request_authorized(handler)):
            raise CanvasMcpError(403, 'A same-origin CainFlow editor is required.')
    else:
        if origins:
            raise CanvasMcpError(403, 'Browser origins cannot call the external canvas bridge.')
        authorization = _header_values(handler, 'Authorization')
        if len(authorization) != 1 or not bridge.is_authorized(authorization[0]):
            raise CanvasMcpError(401, 'A valid canvas bridge bearer token is required.')


def _reject_non_json_number(_value):
    raise ValueError('Non-finite JSON number')


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        _reject_non_json_number(value)
    return number


def _read_payload(handler, limit):
    content_types = _header_values(handler, 'Content-Type')
    if len(content_types) != 1 or content_types[0].partition(';')[0].strip().lower() != 'application/json':
        raise CanvasMcpError(415, 'Content-Type must be application/json.')
    lengths = _header_values(handler, 'Content-Length')
    if not lengths:
        raise CanvasMcpError(411, 'Content-Length is required.')
    if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal()
            or _header_values(handler, 'Transfer-Encoding')):
        raise CanvasMcpError(400, 'Invalid request length.')
    if len(lengths[0]) > 10 or int(lengths[0]) > limit:
        raise CanvasMcpError(413, 'The canvas bridge request exceeded the size limit.')
    length = int(lengths[0])
    try:
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise ValueError('Incomplete body')
        payload = json.loads(raw.decode('utf-8'), parse_constant=_reject_non_json_number, parse_float=_finite_float)
    except TimeoutError as error:
        raise CanvasMcpError(408, 'The canvas bridge did not receive the request body in time.') from error
    except (ValueError, OSError, RecursionError) as error:
        raise CanvasMcpError(400, 'The canvas bridge request body must be a JSON object.') from error
    if not isinstance(payload, dict):
        raise CanvasMcpError(400, 'The canvas bridge request body must be a JSON object.')
    return payload, length


def _handle_editor(bridge, payload, length):
    editor_id = payload.get('editorId')
    if not is_editor_id(editor_id):
        raise CanvasMcpError(400, 'Invalid editorId.')
    action = payload.get('action')
    if action == 'poll' and type(payload.get('activate')) is bool:
        if length > MAX_CALL_BYTES:
            raise CanvasMcpError(413, 'The canvas bridge request exceeded the size limit.')
        return bridge.poll(editor_id, payload['activate'])
    if action == 'complete':
        command_id = payload.get('id')
        has_result = 'result' in payload
        has_error = 'error' in payload
        if (not is_editor_id(command_id) or has_result == has_error
                or (has_error and (not isinstance(payload['error'], str) or not payload['error']))):
            raise CanvasMcpError(400, 'Invalid canvas command completion.')
        response = {'result': payload['result']} if has_result else {'error': payload['error']}
        return bridge.complete(editor_id, command_id, response, length)
    raise CanvasMcpError(400, 'Invalid canvas editor action.')


def _handle_settings(settings, port, payload):
    action = payload.get('action')
    if action == 'status':
        return settings.status(port)
    if action == 'set_enabled' and type(payload.get('enabled')) is bool:
        settings.set_enabled(payload['enabled'])
        return settings.status(port)
    if action == 'connection_config':
        return settings.client_configuration(port)
    raise CanvasMcpError(400, 'Invalid Canvas MCP settings action.')


def handle(handler):
    if not is_canvas_mcp_path(handler.path):
        return False
    is_editor = handler.path == EDITOR_PATH
    is_settings = handler.path == SETTINGS_PATH
    settings = getattr(handler.server, 'canvas_mcp_settings', None)
    bridge = settings.bridge if settings is not None else None
    if settings is None or (not is_editor and not is_settings and handler.path != CALL_PATH):
        _write_response(handler, 404, {'error': 'Canvas bridge route not found.'})
    elif not is_settings and bridge is None:
        if is_editor and handler.command == 'POST':
            _write_response(handler, 204)
        else:
            _write_response(handler, 404, {'error': 'The CainFlow canvas bridge is disabled.'})
    elif handler.command != 'POST':
        _write_response(handler, 405, {'error': 'The canvas bridge requires POST.'}, {'Allow': 'POST'})
    else:
        try:
            handler.connection.settimeout(BODY_TIMEOUT_SECONDS)
            editor_role = 'settings' if is_settings else 'editor' if is_editor else None
            _authorize(handler, bridge, editor_role)
            payload, length = _read_payload(handler, MAX_EDITOR_BYTES if is_editor else MAX_CALL_BYTES)
            if is_settings:
                response = _handle_settings(settings, handler.server.server_address[1], payload)
            elif is_editor:
                response = _handle_editor(bridge, payload, length)
            else:
                response = bridge.call(payload.get('method'), payload.get('args'))
            _write_response(handler, 200, response)
        except CanvasMcpError as error:
            headers = {'WWW-Authenticate': 'Bearer'} if error.status == 401 else None
            _write_response(handler, error.status, {'error': str(error)}, headers)
        except Exception:
            _write_response(handler, 500, {'error': 'The CainFlow canvas bridge could not complete the request.'})
    return True
