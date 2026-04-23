from urllib.parse import unquote

from backend import config
from backend.services.http_helpers import read_request_body, write_bytes, write_error, write_json, write_text
from backend.services.workflow_service import delete_workflow, list_workflows, load_workflow, rename_workflow, save_workflow


def handle_get(handler):
    if handler.path == '/api/workflows':
        try:
            payload = list_workflows(config.WORKFLOWS_DIR)
            write_json(handler, payload)
        except Exception as exc:
            write_error(handler, 500, 'Failed to list workflows', exc)
        return True

    if handler.path.startswith('/api/workflows/'):
        name = unquote(handler.path[len('/api/workflows/'):])
        content = load_workflow(name)
        if content is None:
            write_error(handler, 404, 'Workflow not found')
        else:
            write_bytes(handler, content, content_type='application/json; charset=utf-8')
        return True

    return False


def handle_post(handler):
    if not handler.path.startswith('/api/workflows/'):
        return False

    name = unquote(handler.path[len('/api/workflows/'):])
    rename_to = handler.headers.get('x-rename-to')
    if rename_to:
        if rename_workflow(name, unquote(rename_to)):
            write_text(handler, 'OK')
        else:
            write_error(handler, 404, 'Original workflow not found')
        return True

    body = read_request_body(handler, default=b'{}')
    try:
        save_workflow(name, body)
        write_text(handler, 'OK')
    except ValueError as exc:
        write_error(handler, 400, 'Invalid workflow payload', exc)
    except Exception as exc:
        write_error(handler, 500, 'Failed to save workflow', exc)
    return True


def handle_delete(handler):
    if not handler.path.startswith('/api/workflows/'):
        return False

    name = unquote(handler.path[len('/api/workflows/'):])
    if delete_workflow(name):
        write_text(handler, 'Deleted')
    else:
        write_error(handler, 404, 'Workflow not found')
    return True


"""Route handlers for workflow list, read, write, rename and delete APIs."""
