import ssl
import urllib.error
import urllib.request

from backend import state
from backend.services.http_helpers import read_json_body, write_bytes, write_error, write_json, write_text
from backend.services.security_service import check_proxy_health, detect_available_proxy, is_safe_url
from backend.services.version_service import get_app_user_agent


def _get_provider_models(handler):
    data = read_json_body(handler)
    url = str(data.get('url') or '').strip()
    protocol = str(data.get('protocol') or 'openai').strip().lower()
    apikey = str(data.get('apikey') or '').strip()
    proxy_cfg = data.get('proxy') if isinstance(data.get('proxy'), dict) else {}

    if not url:
        write_error(handler, 400, 'Missing provider model list URL')
        return
    if not is_safe_url(url):
        write_error(handler, 403, '目标地址无效，仅支持 http 或 https URL')
        return

    headers = {
        'Accept': 'application/json',
        'User-Agent': get_app_user_agent(),
        'Connection': 'close',
    }
    if protocol == 'openai' and apikey:
        headers['Authorization'] = f'Bearer {apikey}'

    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    request = urllib.request.Request(url, headers=headers, method='GET')
    if proxy_cfg.get('enabled'):
        proxy_host = str(proxy_cfg.get('ip') or state.ACTIVE_PROXY.get('ip') or '127.0.0.1')
        proxy_port = str(proxy_cfg.get('port') or state.ACTIVE_PROXY.get('port') or '7890')
        proxy_url = f'http://{proxy_host}:{proxy_port}'
        proxy_handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
    else:
        proxy_handler = urllib.request.ProxyHandler({})
    opener = urllib.request.build_opener(proxy_handler, urllib.request.HTTPSHandler(context=context))

    try:
        response = opener.open(request, timeout=35.0)
        with response:
            raw = response.read()
            status = getattr(response, 'status', 200)
            content_type = response.headers.get('Content-Type', 'application/json; charset=utf-8')
        write_bytes(handler, raw, status=status, content_type=content_type)
    except urllib.error.HTTPError as error:
        raw = error.read()
        content_type = error.headers.get('Content-Type', 'application/json; charset=utf-8')
        write_bytes(handler, raw, status=error.code, content_type=content_type)
    except Exception as error:
        write_error(handler, 504, '获取供应商模型列表失败', error)


def handle_get(handler):
    if handler.path == '/api/proxy':
        write_json(handler, state.ACTIVE_PROXY)
        return True
    return False


def handle_post(handler):
    if handler.path == '/api/provider_models':
        _get_provider_models(handler)
        return True

    if handler.path == '/api/test_proxy':
        proxy_cfg = read_json_body(handler)
        success, result = check_proxy_health(proxy_cfg.get('ip', '127.0.0.1'), proxy_cfg.get('port', '7890'))
        if success:
            write_json(handler, {'success': True, 'latency': result if isinstance(result, int) else 0})
        else:
            write_error(handler, 500, 'Cannot connect via proxy', result)
        return True

    if handler.path == '/api/detect_proxy':
        detected = detect_available_proxy()
        detected_proxy = detected.get('proxy') if isinstance(detected, dict) else None
        attempts = detected.get('attempts', []) if isinstance(detected, dict) else []
        if detected_proxy:
            write_json(handler, {
                'success': True,
                'proxy': {
                    'enabled': True,
                    'ip': detected_proxy.get('ip', '127.0.0.1'),
                    'port': detected_proxy.get('port', ''),
                },
                'latency': detected_proxy.get('latency', 0),
                'source': detected_proxy.get('name', 'Local proxy'),
                'checkedTarget': detected_proxy.get('checkedTarget', ''),
                'attempts': attempts,
            })
        else:
            write_json(handler, {
                'success': False,
                'message': '未检测到可用代理，请确认代理软件已启动，或手动填写代理地址与端口。',
                'attempts': attempts,
            })
        return True

    if handler.path == '/api/proxy':
        new_state = read_json_body(handler)
        if 'enabled' in new_state:
            state.ACTIVE_PROXY['enabled'] = new_state['enabled']
        if 'ip' in new_state:
            state.ACTIVE_PROXY['ip'] = str(new_state['ip'])
        if 'port' in new_state:
            state.ACTIVE_PROXY['port'] = str(new_state['port'])
        write_text(handler, 'OK')
        return True

    return False


def handle_delete(handler):
    return False


"""Route handlers for proxy and settings-related APIs."""
