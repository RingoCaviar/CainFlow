from backend import state
from backend.services.http_helpers import read_json_body, write_error, write_json, write_text
from backend.services.security_service import check_proxy_health, save_allowed_hosts


def handle_get(handler):
    if handler.path == '/api/allowed_hosts':
        write_json(handler, {'hosts': state.CUSTOM_ALLOWED_HOSTS})
        return True
    if handler.path == '/api/proxy':
        write_json(handler, state.ACTIVE_PROXY)
        return True
    return False


def handle_post(handler):
    if handler.path == '/api/allowed_hosts':
        data = read_json_body(handler)
        action = data.get('action', 'set')

        if action == 'add':
            host = data.get('host', '').strip()
            if host and host not in state.CUSTOM_ALLOWED_HOSTS:
                state.CUSTOM_ALLOWED_HOSTS.append(host)
                save_allowed_hosts()
                write_json(handler, {'success': True, 'hosts': state.CUSTOM_ALLOWED_HOSTS})
            else:
                write_error(handler, 400, 'Invalid host or already exists')
            return True

        if action == 'remove':
            host = data.get('host', '').strip()
            if host in state.CUSTOM_ALLOWED_HOSTS:
                state.CUSTOM_ALLOWED_HOSTS.remove(host)
                save_allowed_hosts()
                write_json(handler, {'success': True, 'hosts': state.CUSTOM_ALLOWED_HOSTS})
            else:
                write_error(handler, 404, 'Host not found')
            return True

        hosts = data.get('hosts', [])
        if isinstance(hosts, list):
            normalized = [host.strip() for host in hosts if isinstance(host, str) and host.strip()]
            save_allowed_hosts(normalized)
            write_json(handler, {'success': True, 'hosts': state.CUSTOM_ALLOWED_HOSTS})
        else:
            write_error(handler, 400, 'Invalid hosts format')
        return True

    if handler.path == '/api/test_proxy':
        proxy_cfg = read_json_body(handler)
        success, result = check_proxy_health(proxy_cfg.get('ip', '127.0.0.1'), proxy_cfg.get('port', '7890'))
        if success:
            write_json(handler, {'success': True, 'latency': result if isinstance(result, int) else 0})
        else:
            write_error(handler, 500, 'Cannot connect via proxy', result)
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
    if handler.path != '/api/allowed_hosts':
        return False

    try:
        data = read_json_body(handler)
        host = data.get('host', '').strip()
    except Exception:
        host = ''

    if host and host in state.CUSTOM_ALLOWED_HOSTS:
        state.CUSTOM_ALLOWED_HOSTS.remove(host)
        save_allowed_hosts()
        write_json(handler, {'success': True, 'hosts': state.CUSTOM_ALLOWED_HOSTS})
    else:
        write_error(handler, 404, 'Host not found')
    return True


"""Route handlers for proxy and allowed-host settings APIs."""
