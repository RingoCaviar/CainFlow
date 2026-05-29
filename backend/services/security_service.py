import base64
import os
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import unquote, urlparse

from backend import config, state

COMMON_PROXY_CANDIDATES = [
    {'ip': '127.0.0.1', 'port': '7892', 'name': 'Clash / Mihomo mixed alt'},
    {'ip': '127.0.0.1', 'port': '7890', 'name': 'Clash / Mihomo HTTP'},
    {'ip': '127.0.0.1', 'port': '7897', 'name': 'Clash Verge / Mihomo mixed'},
    {'ip': '127.0.0.1', 'port': '7891', 'name': 'Clash controller proxy'},
    {'ip': '127.0.0.1', 'port': '10809', 'name': 'v2rayN / Xray HTTP'},
    {'ip': '127.0.0.1', 'port': '10808', 'name': 'v2rayN / Xray mixed'},
    {'ip': '127.0.0.1', 'port': '1080', 'name': 'Generic local proxy'},
    {'ip': '127.0.0.1', 'port': '20171', 'name': 'Hiddify / local proxy'},
    {'ip': '127.0.0.1', 'port': '20172', 'name': 'Hiddify / local proxy alt'},
    {'ip': '127.0.0.1', 'port': '8888', 'name': 'Generic HTTP proxy alt'},
    {'ip': '127.0.0.1', 'port': '8080', 'name': 'Generic HTTP proxy'},
    {'ip': '127.0.0.1', 'port': '9090', 'name': 'Generic HTTP proxy alt'},
]

PROXY_HEALTHCHECK_TARGETS = [
    {'name': 'Google gstatic 204', 'url': 'https://www.gstatic.com/generate_204', 'method': 'HEAD'},
    {'name': 'Google 204', 'url': 'https://www.google.com/generate_204', 'method': 'HEAD'},
    {'name': 'Huawei HiCloud 204', 'url': 'http://connectivitycheck.platform.hicloud.com/generate_204', 'method': 'HEAD'},
]


def _is_reachable_probe_status(status):
    try:
        code = int(status)
    except (TypeError, ValueError):
        return False
    return code > 0 and code < 500


def _can_open_proxy_socket(ip, port, timeout):
    try:
        port_number = int(str(port).strip())
    except (TypeError, ValueError):
        return False
    if port_number <= 0 or port_number > 65535:
        return False
    try:
        with socket.create_connection((str(ip).strip() or '127.0.0.1', port_number), timeout=timeout):
            return True
    except OSError:
        return False


def _normalize_proxy_candidate(ip, port, name=''):
    host = str(ip or '').strip() or '127.0.0.1'
    port_value = str(port or '').strip()
    return {
        'ip': host,
        'port': port_value,
        'name': str(name or '').strip() or 'Local proxy',
    }


def _extract_proxy_candidate(raw_value, name=''):
    raw = str(raw_value or '').strip()
    if not raw:
        return None

    parsed = urlparse(raw if '://' in raw else f'http://{raw}')
    host = parsed.hostname or ''
    port = parsed.port or ''
    if not host or not port:
        return None
    return _normalize_proxy_candidate(host, port, name=name)


def _iter_proxy_server_entries(raw_value):
    raw = str(raw_value or '').strip()
    if not raw:
        return []

    entries = []
    for segment in raw.split(';'):
        part = segment.strip()
        if not part:
            continue
        if '=' in part:
            scheme, value = part.split('=', 1)
            if scheme.strip().lower() in ('http', 'https'):
                entries.append(value.strip())
        else:
            entries.append(part)
    return entries


def _get_env_proxy_candidates():
    candidates = []
    for env_name in ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'):
        candidate = _extract_proxy_candidate(os.environ.get(env_name), name=f'Environment {env_name}')
        if candidate:
            candidates.append(candidate)
    return candidates


def _get_windows_proxy_candidates():
    if os.name != 'nt':
        return []

    try:
        import winreg
    except ImportError:
        return []

    candidates = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
            proxy_enabled, _ = winreg.QueryValueEx(key, 'ProxyEnable')
            if not proxy_enabled:
                return []
            proxy_server, _ = winreg.QueryValueEx(key, 'ProxyServer')
    except OSError:
        return []

    for entry in _iter_proxy_server_entries(proxy_server):
        candidate = _extract_proxy_candidate(entry, name='Windows system proxy')
        if candidate:
            candidates.append(candidate)
    return candidates


def _get_proxy_detection_candidates():
    candidates = []
    seen = set()

    def add_candidate(candidate):
        if not candidate:
            return
        normalized = _normalize_proxy_candidate(candidate.get('ip'), candidate.get('port'), candidate.get('name'))
        key = (normalized['ip'].lower(), normalized['port'])
        if not normalized['port'] or key in seen:
            return
        seen.add(key)
        candidates.append(normalized)

    active_proxy = state.ACTIVE_PROXY if isinstance(state.ACTIVE_PROXY, dict) else {}
    add_candidate({
        'ip': active_proxy.get('ip', '127.0.0.1'),
        'port': active_proxy.get('port', ''),
        'name': 'Current CainFlow proxy setting',
    })

    for candidate in _get_windows_proxy_candidates():
        add_candidate(candidate)
    for candidate in _get_env_proxy_candidates():
        add_candidate(candidate)
    for candidate in COMMON_PROXY_CANDIDATES:
        add_candidate(candidate)
    return candidates


class ForcedProxyHandler(urllib.request.BaseHandler):
    """Use an explicitly configured proxy without applying system bypass rules."""

    handler_order = 100

    def __init__(self, proxies):
        self.proxies = proxies
        for scheme, proxy_url in proxies.items():
            normalized_scheme = str(scheme).lower()
            setattr(
                self,
                f'{normalized_scheme}_open',
                lambda request, proxy=proxy_url, proxy_type=normalized_scheme: self.proxy_open(request, proxy, proxy_type)
            )

    def proxy_open(self, request, proxy, request_type):
        original_type = request.type
        proxy_type, user, password, hostport = urllib.request._parse_proxy(proxy)
        if proxy_type is None:
            proxy_type = original_type

        if user and password:
            credentials = f'{unquote(user)}:{unquote(password)}'
            encoded = base64.b64encode(credentials.encode()).decode('ascii')
            request.add_header('Proxy-authorization', f'Basic {encoded}')

        request.set_proxy(unquote(hostport), proxy_type)
        if original_type == proxy_type or original_type == 'https':
            return None
        return self.parent.open(request, timeout=request.timeout)


def build_upstream_opener(proxy_enabled=None, proxy_host=None, proxy_port=None):
    resolved_enabled = bool(state.ACTIVE_PROXY.get('enabled')) if proxy_enabled is None else bool(proxy_enabled)
    resolved_host = str(proxy_host if proxy_host is not None else state.ACTIVE_PROXY.get('ip') or '127.0.0.1').strip() or '127.0.0.1'
    resolved_port = str(proxy_port if proxy_port is not None else state.ACTIVE_PROXY.get('port') or '7890').strip() or '7890'
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    if resolved_enabled:
        proxy_url = f'http://{resolved_host}:{resolved_port}'
        proxy_handler = ForcedProxyHandler({'http': proxy_url, 'https': proxy_url})
    else:
        proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(
        proxy_handler,
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(context=context),
    )
    return opener, {
        'enabled': resolved_enabled,
        'host': resolved_host,
        'port': resolved_port,
        'mode': 'proxy' if resolved_enabled else 'direct',
    }


def _summarize_proxy_exception(exc):
    text = str(exc or '').strip()
    if not text:
        return exc.__class__.__name__
    return text.splitlines()[0]


def _check_proxy_health_details(ip, port, request_timeout=6.0, connect_timeout=0.8):
    host = str(ip or '').strip() or '127.0.0.1'
    port_value = str(port or '').strip()
    result = {
        'ip': host,
        'port': port_value,
        'reachable': False,
        'available': False,
        'latency': 0,
        'detail': '',
        'checkedTarget': '',
        'failures': [],
    }

    if not _can_open_proxy_socket(host, port_value, connect_timeout):
        result['detail'] = 'Port is not reachable'
        return result

    result['reachable'] = True
    opener, _ = build_upstream_opener(proxy_enabled=True, proxy_host=host, proxy_port=port_value)

    for target in PROXY_HEALTHCHECK_TARGETS:
        target_name = str(target.get('name') or target.get('url') or 'target')
        try:
            start = time.perf_counter()
            request = urllib.request.Request(
                target.get('url'),
                method=target.get('method', 'HEAD'),
                headers={
                    'User-Agent': 'CainFlow Proxy Detector',
                    'Connection': 'close',
                },
            )
            opener.open(request, timeout=request_timeout)
            result['available'] = True
            result['latency'] = int((time.perf_counter() - start) * 1000)
            result['checkedTarget'] = target_name
            result['detail'] = f'HTTP proxy check passed via {target_name}'
            return result
        except urllib.error.HTTPError as exc:
            if exc.code == 407:
                result['failures'].append(f'{target_name}: proxy authentication required (407)')
                continue
            result['available'] = True
            result['latency'] = int((time.perf_counter() - start) * 1000)
            result['checkedTarget'] = target_name
            result['detail'] = f'HTTP proxy responded via {target_name} (HTTP {exc.code})'
            return result
        except Exception as exc:
            result['failures'].append(f'{target_name}: {_summarize_proxy_exception(exc)}')

    if result['reachable']:
        if result['failures']:
            result['detail'] = f"Port is open but proxy forwarding failed: {'; '.join(result['failures'][:2])}"
        else:
            result['detail'] = 'Port is open but proxy forwarding failed'
    return result


def check_proxy_health(ip, port, request_timeout=5.0, connect_timeout=0.8):
    details = _check_proxy_health_details(ip, port, request_timeout=request_timeout, connect_timeout=connect_timeout)
    if details['available']:
        return True, details['latency'] if details['latency'] > 0 else details['detail']
    return False, details['detail'] or 'Proxy port is not reachable'


def detect_available_proxy(request_timeout=6.0, connect_timeout=0.6, stop_after_first_available=False):
    attempts = []
    detected_proxy = None

    for candidate in _get_proxy_detection_candidates():
        details = _check_proxy_health_details(
            candidate.get('ip', '127.0.0.1'),
            candidate.get('port', ''),
            request_timeout=request_timeout,
            connect_timeout=connect_timeout,
        )
        attempt = {
            'ip': details.get('ip', candidate.get('ip', '127.0.0.1')),
            'port': details.get('port', candidate.get('port', '')),
            'name': candidate.get('name', 'Local proxy'),
            'reachable': bool(details.get('reachable')),
            'available': bool(details.get('available')),
            'latency': int(details.get('latency', 0) or 0),
            'detail': details.get('detail', ''),
            'checkedTarget': details.get('checkedTarget', ''),
        }
        attempts.append(attempt)
        if attempt['available'] and detected_proxy is None:
            detected_proxy = attempt
            if stop_after_first_available:
                break

    return {
        'proxy': detected_proxy,
        'attempts': attempts,
    }


def probe_network_target(url, name='', method='HEAD', request_timeout=3.0):
    target_url = str(url or '').strip()
    target_name = str(name or target_url or 'target').strip()
    target_method = str(method or 'HEAD').strip().upper()
    if target_method not in ('HEAD', 'GET'):
        target_method = 'HEAD'

    result = {
        'name': target_name,
        'url': target_url,
        'success': False,
        'status': 0,
        'latency': 0,
        'detail': '',
    }
    if not is_safe_url(target_url):
        result['detail'] = '目标地址无效，仅支持 http 或 https URL'
        return result

    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(context=context),
    )
    try:
        start = time.perf_counter()
        request = urllib.request.Request(
            target_url,
            method=target_method,
            headers={
                'User-Agent': 'CainFlow Network Detector',
                'Connection': 'close',
                'Cache-Control': 'no-cache',
            },
        )
        with opener.open(request, timeout=request_timeout) as response:
            status = getattr(response, 'status', 200)
        result['status'] = int(status)
        result['success'] = _is_reachable_probe_status(status)
        result['latency'] = int((time.perf_counter() - start) * 1000)
        result['detail'] = f'HTTP {status}'
    except urllib.error.HTTPError as exc:
        result['status'] = int(exc.code)
        result['success'] = _is_reachable_probe_status(exc.code)
        result['latency'] = int((time.perf_counter() - start) * 1000) if 'start' in locals() else 0
        result['detail'] = f'HTTP {exc.code}'
    except Exception as exc:
        result['latency'] = int((time.perf_counter() - start) * 1000) if 'start' in locals() else 0
        result['detail'] = _summarize_proxy_exception(exc)
    return result


def is_safe_url(url, allow_private_network_targets=False):
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False
        return bool(parsed.hostname)
    except Exception:
        return False


def get_safe_path(name):
    safe_name = os.path.basename(name)
    if not safe_name or safe_name in ('.', '..'):
        return None
    filepath = os.path.join(config.WORKFLOWS_DIR, f'{safe_name}.json')
    abs_root = os.path.abspath(config.WORKFLOWS_DIR)
    abs_file = os.path.abspath(filepath)
    if not abs_file.startswith(abs_root):
        return None
    return filepath


"""提供代理健康检查、URL 基础校验和工作流路径安全能力。"""
