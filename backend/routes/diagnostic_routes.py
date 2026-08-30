from urllib.parse import urlparse

from backend.services.http_helpers import read_json_body, write_error, write_json
from backend.services.log_service import diagnostic_service


DIAGNOSTIC_PATH = '/api/diagnostics'


def handle_get(handler):
    if urlparse(handler.path).path != DIAGNOSTIC_PATH:
        return False
    write_json(handler, {'success': True, 'status': diagnostic_service.status()})
    return True


def handle_post(handler):
    if urlparse(handler.path).path != DIAGNOSTIC_PATH:
        return False
    data = read_json_body(handler)
    action = str(data.get('action') or '')
    try:
        if action == 'set-level':
            result = {'policy': diagnostic_service.set_level(data.get('level'))}
        elif action == 'clear':
            result = diagnostic_service.clear(data.get('scope') or 'all')
        elif action == 'record':
            result = diagnostic_service.record(data.get('intent') or {})
        else:
            write_error(handler, 400, 'Unknown diagnostic action')
            return True
        write_json(handler, {'success': True, **result})
    except ValueError as error:
        write_error(handler, 400, str(error))
    return True


"""Local HTTP seam for bounded diagnostic policy and maintenance intents."""
