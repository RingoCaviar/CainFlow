import ipaddress
import json
import math
from urllib.parse import unquote, urlsplit

from backend import desktop_security
from backend.services.canvas_mcp_bridge import CanvasMcpError, MAX_CALL_BYTES, MAX_IMAGE_CHARS


PREFIX = '/api/canvas-mcp'
CALL_PATH = PREFIX + '/call'
SETTINGS_PATH = PREFIX + '/settings'
SETTINGS_HEADER = 'X-CainFlow-Canvas-MCP'
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


def _authorize(handler, service, is_settings):
    port = handler.server.server_address[1]
    expected_host = f'127.0.0.1:{port}'
    origin_host = '127.0.0.1' if port == 80 else expected_host
    try:
        local_peer = ipaddress.ip_address(handler.client_address[0]).is_loopback
    except ValueError:
        local_peer = False
    if not local_peer or _header_values(handler, 'Host') not in ([expected_host], [origin_host]):
        raise CanvasMcpError(403, 'Canvas MCP is available only through the local CainFlow address.')

    origins = _header_values(handler, 'Origin')
    authorization = _header_values(handler, 'Authorization')
    if is_settings:
        if (authorization or origins != ['http://' + origin_host] or _header_values(handler, SETTINGS_HEADER) != ['settings']
                or not desktop_security.is_api_request_authorized(handler)):
            raise CanvasMcpError(403, 'A same-origin CainFlow settings session is required.')
    else:
        if origins:
            raise CanvasMcpError(403, 'Browser origins cannot call Canvas MCP.')
        if len(authorization) != 1 or not service.is_authorized(authorization[0]):
            raise CanvasMcpError(401, 'A valid Canvas MCP bearer token is required.')


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
        raise CanvasMcpError(413, 'The Canvas MCP request exceeded the size limit.')
    length = int(lengths[0])
    try:
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise ValueError('Incomplete body')
        payload = json.loads(raw.decode('utf-8'), parse_constant=_reject_non_json_number, parse_float=_finite_float)
    except TimeoutError as error:
        raise CanvasMcpError(408, 'Canvas MCP did not receive the request body in time.') from error
    except (ValueError, OSError, RecursionError) as error:
        raise CanvasMcpError(400, 'The Canvas MCP request body must be a JSON object.') from error
    if not isinstance(payload, dict):
        raise CanvasMcpError(400, 'The Canvas MCP request body must be a JSON object.')
    return payload


def _discard_rejected_body(handler):
    """Consume an already-sent body so closing the local connection cannot replace the rejection with RST."""
    lengths = _header_values(handler, 'Content-Length')
    if (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal()
            or _header_values(handler, 'Transfer-Encoding')):
        return
    remaining = int(lengths[0])
    if remaining > MAX_CALL_BYTES:
        return
    try:
        while remaining:
            chunk = handler.rfile.read(min(remaining, 64 * 1024))
            if not chunk:
                return
            remaining -= len(chunk)
    except (OSError, TimeoutError, ValueError):
        return


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
    is_settings = handler.path == SETTINGS_PATH
    settings = getattr(handler.server, 'canvas_mcp_settings', None)
    service = settings.service if settings is not None else None
    if settings is None or (not is_settings and handler.path != CALL_PATH):
        _write_response(handler, 404, {'error': 'Canvas MCP route not found.'})
    elif not is_settings and service is None:
        _write_response(handler, 404, {'error': 'CainFlow Canvas MCP is disabled.'})
    elif handler.command != 'POST':
        _write_response(handler, 405, {'error': 'Canvas MCP requires POST.'}, {'Allow': 'POST'})
    else:
        try:
            handler.connection.settimeout(BODY_TIMEOUT_SECONDS)
            try:
                _authorize(handler, service, is_settings)
            except CanvasMcpError:
                _discard_rejected_body(handler)
                raise
            payload = _read_payload(handler, MAX_CALL_BYTES)
            if is_settings:
                response = _handle_settings(settings, handler.server.server_address[1], payload)
            else:
                method = payload.get('method')
                response = service.call(method, payload.get('args'))
                result_limit = MAX_IMAGE_CHARS + 1000 if method == 'get_run_image' else MAX_CALL_BYTES
                if len(json.dumps(response, separators=(',', ':'))) > result_limit:
                    raise CanvasMcpError(413, '画布结果超出本次请求的大小限制，请分批读取。', 'result_too_large')
            _write_response(handler, 200, response)
        except CanvasMcpError as error:
            headers = {'WWW-Authenticate': 'Bearer'} if error.status == 401 else None
            body = {'error': str(error)}
            if error.code is not None:
                body['errorCode'] = error.code
            _write_response(handler, error.status, body, headers)
        except Exception:
            _write_response(handler, 500, {'error': 'Canvas MCP could not complete the request.'})
    return True
