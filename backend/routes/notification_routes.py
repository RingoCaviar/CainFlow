import ipaddress
from urllib.parse import urlparse

from backend import config
from backend.services.http_helpers import read_json_body, write_error, write_json
from backend.services.system_notification_service import normalize_notification_payload, send_system_notification


MAX_NOTIFICATION_REQUEST_BYTES = 4096


def _is_loopback_host(hostname):
    normalized = str(hostname or '').strip().lower().rstrip('.')
    if normalized == 'localhost':
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _is_local_cainflow_request(handler):
    client_host = handler.client_address[0] if getattr(handler, 'client_address', None) else ''
    if not _is_loopback_host(client_host):
        return False
    origin = str(handler.headers.get('Origin') or '').strip()
    if not origin:
        return False
    parsed = urlparse(origin)
    try:
        origin_port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return False
    return (
        parsed.scheme in ('http', 'https')
        and _is_loopback_host(parsed.hostname)
        and origin_port == config.PORT
    )


def handle_post(handler):
    if handler.path != '/api/system-notification':
        return False
    if not _is_local_cainflow_request(handler):
        write_error(handler, 403, 'System notifications are only available to the local CainFlow page')
        return True

    try:
        content_length = int(handler.headers.get('Content-Length', 0))
    except (TypeError, ValueError):
        write_error(handler, 400, 'Invalid Content-Length')
        return True
    if content_length <= 0 or content_length > MAX_NOTIFICATION_REQUEST_BYTES:
        write_error(handler, 413, 'Notification request is empty or too large')
        return True

    try:
        data = read_json_body(handler)
    except (UnicodeDecodeError, ValueError) as error:
        write_error(handler, 400, 'Invalid notification request', error)
        return True
    if not isinstance(data, dict):
        write_error(handler, 400, 'Notification request must be a JSON object')
        return True

    try:
        payload = normalize_notification_payload(data.get('title'), data.get('body'), data.get('tag'))
    except ValueError as error:
        write_error(handler, 400, 'Invalid notification request', error)
        return True

    result = send_system_notification(payload['title'], payload['body'], payload['tag'])
    write_json(handler, result, status=200 if result.get('success') or result.get('channel') == 'unsupported' else 500)
    return True


"""Routes for local desktop notification delivery."""
