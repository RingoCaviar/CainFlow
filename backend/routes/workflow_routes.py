from urllib.parse import parse_qs, unquote, urlparse

from backend import config
from backend.services.http_helpers import read_request_body, write_bytes, write_error, write_json, write_text
from backend.services.workflow_service import clear_workflows, create_workflow_folder, delete_workflow, delete_workflow_folder, list_workflows, load_workflow, rename_workflow, rename_workflow_folder, save_workflow


def handle_get(handler):
    route_path = urlparse(handler.path).path
    if route_path == '/api/workflows':
        try:
            payload = list_workflows(config.WORKFLOWS_DIR)
            write_json(handler, payload)
        except Exception as exc:
            write_error(handler, 500, 'Failed to list workflows', exc)
        return True

    if route_path.startswith('/api/workflows/'):
        name = unquote(route_path[len('/api/workflows/'):])
        content = load_workflow(name)
        if content is None:
            write_error(handler, 404, 'Workflow not found')
        else:
            write_bytes(handler, content, content_type='application/json; charset=utf-8')
        return True

    return False


def handle_post(handler):
    route_path = urlparse(handler.path).path
    if route_path.startswith('/api/workflow-folders/'):
        name = unquote(route_path[len('/api/workflow-folders/'):])
        rename_to = handler.headers.get('x-rename-to')
        try:
            if rename_to:
                payload = rename_workflow_folder(name, unquote(rename_to))
                if payload is None:
                    write_error(handler, 404, 'Original workflow folder not found')
                else:
                    write_json(handler, payload)
            else:
                create_workflow_folder(name)
                write_text(handler, 'OK')
        except FileExistsError as exc:
            write_error(handler, 409, 'Workflow folder already exists', exc)
        except ValueError as exc:
            write_error(handler, 400, 'Invalid workflow folder name', exc)
        except Exception as exc:
            write_error(handler, 500, 'Failed to update workflow folder', exc)
        return True

    if not route_path.startswith('/api/workflows/'):
        return False

    name = unquote(route_path[len('/api/workflows/'):])
    rename_to = handler.headers.get('x-rename-to')
    if rename_to:
        try:
            if rename_workflow(name, unquote(rename_to)):
                write_text(handler, 'OK')
            else:
                write_error(handler, 404, 'Original workflow not found')
        except FileExistsError as exc:
            write_error(handler, 409, 'Workflow already exists', exc)
        return True

    body = read_request_body(handler, default=b'{}')
    try:
        save_workflow(name, body)
        write_text(handler, 'OK')
    except FileExistsError as exc:
        write_error(handler, 409, 'Workflow already exists', exc)
    except ValueError as exc:
        write_error(handler, 400, 'Invalid workflow payload', exc)
    except Exception as exc:
        write_error(handler, 500, 'Failed to save workflow', exc)
    return True


def handle_delete(handler):
    parsed = urlparse(handler.path)
    route_path = parsed.path
    if route_path == '/api/workflows':
        try:
            payload = {'deleted': clear_workflows(config.WORKFLOWS_DIR)}
            write_json(handler, payload)
        except Exception as exc:
            write_error(handler, 500, 'Failed to clear workflows', exc)
        return True

    if route_path.startswith('/api/workflow-folders/'):
        name = unquote(route_path[len('/api/workflow-folders/'):])
        query = parse_qs(parsed.query)
        delete_contents = query.get('delete_contents', ['0'])[0] in ('1', 'true', 'yes')
        try:
            payload = delete_workflow_folder(name, delete_contents=delete_contents)
            if payload is None:
                write_error(handler, 404, 'Workflow folder not found')
            else:
                write_json(handler, payload)
        except Exception as exc:
            write_error(handler, 500, 'Failed to delete workflow folder', exc)
        return True

    if not route_path.startswith('/api/workflows/'):
        return False

    name = unquote(route_path[len('/api/workflows/'):])
    if delete_workflow(name):
        write_text(handler, 'Deleted')
    else:
        write_error(handler, 404, 'Workflow not found')
    return True


"""Route handlers for workflow list, read, write, rename and delete APIs."""
