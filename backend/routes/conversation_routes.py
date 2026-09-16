from urllib.parse import parse_qs, unquote, urlparse

from backend.services.conversation_service import (
    ConversationConflict, ConversationError, ConversationStateConflict, conversation_service,
)
from backend.services.http_helpers import read_json_body, write_error, write_json


def handle_get(handler):
    parsed = urlparse(handler.path)
    path = parsed.path
    if path == '/api/conversations':
        query = parse_qs(parsed.query)
        conversations = conversation_service.list_conversations(
            status=(query.get('status') or ['active'])[0],
            workflow_id=(query.get('workflowId') or [''])[0],
            search=(query.get('search') or [''])[0],
        )
        write_json(handler, {'conversations': conversations})
        return True
    prefix = '/api/conversations/'
    if not path.startswith(prefix):
        return False
    conversation = conversation_service.get_conversation(unquote(path[len(prefix):]))
    write_json(handler, {'conversation': conversation}, status=200 if conversation else 404)
    return True


def handle_post(handler):
    path = urlparse(handler.path).path
    media_marker = '/messages/'
    media_suffix = '/media-actions'
    if path.startswith('/api/conversations/') and media_marker in path and path.endswith(media_suffix):
        remainder = path[len('/api/conversations/'):]
        conversation_id, message_path = remainder.split(media_marker, 1)
        message_id = message_path[:-len(media_suffix)].rstrip('/')
        try:
            result = conversation_service.resolve_message_media(
                unquote(conversation_id.rstrip('/')), unquote(message_id), read_json_body(handler))
        except ConversationConflict:
            write_error(handler, 409, 'Conversation revision conflict')
            return True
        except ConversationStateConflict as error:
            write_error(handler, 409, str(error))
            return True
        except ConversationError as error:
            write_error(handler, 400, str(error))
            return True
        write_json(handler, result or {'message': None}, status=200 if result else 404)
        return True
    if path == '/api/conversations':
        try:
            conversation = conversation_service.create_conversation(read_json_body(handler))
        except ConversationError as error:
            write_error(handler, 400, str(error))
            return True
        write_json(handler, {'conversation': conversation}, status=201)
        return True
    prefix = '/api/conversations/'
    suffix = '/messages'
    if not path.startswith(prefix) or not path.endswith(suffix):
        return False
    conversation_id = unquote(path[len(prefix):-len(suffix)]).rstrip('/')
    try:
        result = conversation_service.append_message(conversation_id, read_json_body(handler))
    except ConversationConflict:
        write_error(handler, 409, 'Conversation revision conflict')
        return True
    except ConversationError as error:
        write_error(handler, 400, str(error))
        return True
    if result is None:
        write_json(handler, {'message': None}, status=404)
        return True
    write_json(handler, result, status=201)
    return True


def handle_put(handler):
    path = urlparse(handler.path).path
    prefix = '/api/conversations/'
    if not path.startswith(prefix):
        return False
    message_marker = '/messages/'
    remainder = path[len(prefix):]
    if message_marker in remainder:
        conversation_id, message_id = remainder.split(message_marker, 1)
        try:
            result = conversation_service.update_message(
                unquote(conversation_id.rstrip('/')), unquote(message_id), read_json_body(handler))
        except ConversationConflict:
            write_error(handler, 409, 'Conversation revision conflict')
            return True
        except ConversationStateConflict as error:
            write_error(handler, 409, str(error))
            return True
        except ConversationError as error:
            write_error(handler, 400, str(error))
            return True
        if result is None:
            write_json(handler, {'message': None}, status=404)
            return True
        write_json(handler, result)
        return True
    try:
        conversation = conversation_service.update_conversation(
            unquote(path[len(prefix):]), read_json_body(handler))
    except ConversationConflict:
        write_error(handler, 409, 'Conversation revision conflict')
        return True
    except ConversationError as error:
        write_error(handler, 400, str(error))
        return True
    write_json(handler, {'conversation': conversation}, status=200 if conversation else 404)
    return True


def handle_delete(handler):
    parsed = urlparse(handler.path)
    prefix = '/api/conversations/'
    if not parsed.path.startswith(prefix):
        return False
    revision = (parse_qs(parsed.query).get('revision') or [''])[0]
    try:
        deleted = conversation_service.delete_conversation(
            unquote(parsed.path[len(prefix):]), revision)
    except ConversationConflict:
        write_error(handler, 409, 'Conversation revision conflict')
        return True
    except ConversationStateConflict as error:
        write_error(handler, 409, str(error))
        return True
    except ConversationError as error:
        write_error(handler, 400, str(error))
        return True
    write_json(handler, {'success': bool(deleted)}, status=200 if deleted else 404)
    return True
