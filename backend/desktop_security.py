import hmac
import secrets
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse


_session_token = None
COOKIE_NAME = 'cainflow_desktop_session'
BOOTSTRAP_PATH = '/__cainflow_desktop__'


def enable_desktop_session():
    global _session_token
    _session_token = secrets.token_urlsafe(32)
    return _session_token


def disable_desktop_session():
    global _session_token
    _session_token = None


def is_desktop_session_enabled():
    return bool(_session_token)


def handle_bootstrap(handler):
    parsed = urlparse(handler.path)
    if parsed.path != BOOTSTRAP_PATH or not _session_token:
        return False
    supplied = parse_qs(parsed.query).get('token', [''])[0]
    if not hmac.compare_digest(supplied, _session_token):
        handler.send_error(403, 'Forbidden')
        return True
    handler.send_response(302)
    handler.send_header('Location', '/?desktop=1')
    handler.send_header(
        'Set-Cookie',
        f'{COOKIE_NAME}={_session_token}; Path=/; HttpOnly; SameSite=Strict'
    )
    handler.end_headers()
    return True


def is_api_request_authorized(handler):
    if not _session_token:
        return True
    parsed = urlparse(handler.path)
    if not (parsed.path.startswith('/api/') or parsed.path == '/proxy'):
        return True
    cookie = SimpleCookie()
    try:
        cookie.load(handler.headers.get('Cookie', ''))
    except Exception:
        return False
    supplied = cookie.get(COOKIE_NAME)
    return bool(supplied and hmac.compare_digest(supplied.value, _session_token))
