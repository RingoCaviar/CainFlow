"""Local library, configuration and configured-provider access for Canvas MCP."""

import base64
import json
import math
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request

from backend.routes.protocol_routes import load_protocol_overrides
from backend.services.canvas_mcp_bridge import CanvasMcpError
from backend.services.media_library import MIME_EXTENSIONS, MediaLibrary
from backend.services.security_service import build_upstream_opener
from backend.services.storage_service import StorageDocumentConflict, StorageError, storage_service
from backend.services.version_service import get_app_user_agent


_MAX_BINARY_BYTES = 32 * 1024 * 1024
_MAX_SAFE_INTEGER = 2**53 - 1
_HISTORY_VERSION = re.compile(r'[0-9]{1,20}:-?[0-9]{1,20}')
_IMAGE_TYPES = frozenset(mime for mime in MIME_EXTENSIONS if mime.startswith('image/'))
_GENERATED_MEDIA_TYPES = {'ImageGenerate': 'image/', 'VideoGenerate': 'video/'}
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9a-zA-Z-]+")
_CONTROL = re.compile(r'[\x00-\x1f\x7f]')
_TRANSPORT_HEADERS = frozenset({
    'host', 'connection', 'content-length', 'cookie', 'set-cookie', 'origin', 'referer',
    'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'te', 'trailer',
    'upgrade', 'keep-alive', 'accept-encoding',
})


def _text(value, limit):
    return value[:limit] if isinstance(value, str) else ''


def _number(value):
    if type(value) is int:
        return value if abs(value) <= _MAX_SAFE_INTEGER else None
    return value if type(value) is float and math.isfinite(value) else None


def _page(args, limit_maximum):
    offset, limit = args.get('offset', 0), args.get('limit', 20)
    if (type(offset) is not int or not 0 <= offset <= _MAX_SAFE_INTEGER
            or type(limit) is not int or not 1 <= limit <= limit_maximum):
        raise CanvasMcpError(400, 'Invalid pagination arguments.', 'invalid_arguments')
    return offset, limit


def _history_id(value):
    if type(value) is not int or not 0 < abs(value) <= _MAX_SAFE_INTEGER:
        raise CanvasMcpError(400, 'Invalid history ID.', 'invalid_arguments')
    return value


def _history_pin(args):
    identifier, version = _history_id(args.get('id')), args.get('fileVersion')
    if not isinstance(version, str) or not _HISTORY_VERSION.fullmatch(version):
        raise CanvasMcpError(400, 'A fileVersion from list_history is required.', 'invalid_arguments')
    return identifier, version


def _history_row(row):
    relative_path = row.get('relativePath')
    filename = re.split(r'[/\\]', relative_path)[-1] if isinstance(relative_path, str) else ''
    duration = row.get('generationDurationSeconds')
    if duration is None:
        duration = row.get('generationDuration')
    return {
        'id': row['id'], 'fileVersion': row['fileVersion'],
        'note': _text(row.get('note'), 160), 'prompt': _text(row.get('prompt'), 1000),
        'model': _text(row.get('model'), 200), 'timestamp': _number(row.get('timestamp')),
        'filename': filename[:240], 'nodeId': _text(row.get('nodeId'), 200),
        'generationDurationSeconds': _number(duration),
    }


def list_history(args):
    offset, limit = _page(args, 40)
    identifier = _history_id(args['id']) if 'id' in args else None
    library = MediaLibrary(storage_service)
    try:
        library.migrate_legacy()
        page = library.list_page(limit, thumbnail_urls=True, offset=offset, image_only=True, filter_id=identifier)
    except (OSError, StorageError, ValueError) as error:
        raise CanvasMcpError(409, 'The local history directory could not be read.', 'history_unavailable') from error
    items = [_history_row(row) for row in page['items']]
    end = offset + len(items)
    return {'items': items, 'total': page['count'], 'nextOffset': end if end < page['count'] else None}


def annotate_history(args):
    identifier, version = _history_pin(args)
    note = args.get('note')
    if not isinstance(note, str) or len(note.strip()) > 80 or _CONTROL.search(note):
        raise CanvasMcpError(400, 'A history note must be a single line of at most 80 characters.', 'invalid_arguments')
    try:
        return MediaLibrary(storage_service).set_note(identifier, note, version)
    except (OSError, StorageError, ValueError) as error:
        raise CanvasMcpError(409, 'The history image changed or is unavailable. List history again.', 'stale_history') from error


def history_media(args):
    identifier, version = _history_pin(args)
    library = MediaLibrary(storage_service)
    try:
        row = library.get(identifier)
        result = library.read(identifier, version) if row and row.get('mediaType') == 'image' else None
    except (OSError, ValueError) as error:
        raise CanvasMcpError(409, 'The history image changed or is unavailable. List history again.', 'stale_history') from error
    if not result or result[0] not in _IMAGE_TYPES:
        raise CanvasMcpError(404, 'The referenced history image is unavailable.', 'history_unavailable')
    mime, body = result
    if len(body) > _MAX_BINARY_BYTES:
        raise CanvasMcpError(413, 'The history image is too large to import.', 'media_too_large')
    return {'mimeType': mime, 'body': base64.b64encode(body).decode('ascii')}


def publish_generated_history(document, node_results, *, published_owner_ids):
    """Archive successful generation outputs after the workflow document commits."""
    if not published_owner_ids:
        return {'saved': 0, 'failed': 0}
    try:
        session = _session()
    except (OSError, sqlite3.Error, StorageError):
        session = {}
    models = session.get('models')
    model_names = {model['id']: _text(model.get('name'), 200) for model in models
                   if isinstance(model, dict) and isinstance(model.get('id'), str)} if isinstance(models, list) else {}
    use_prompt_filename = document.get('imageSaveUsePromptFilename', session.get('imageSaveUsePromptFilename')) is True
    nodes = {node['id']: node for node in document['nodes'] if node.get('type') in _GENERATED_MEDIA_TYPES}
    library = MediaLibrary(storage_service)
    saved = failed = 0
    for result in node_results:
        node_id = result['nodeId']
        node = nodes.get(node_id)
        if not node or result.get('succeeded') is not True:
            continue
        data = node.get('data') if isinstance(node.get('data'), dict) else {}
        fields = {**data, **node}
        owned = fields.get('mediaAssetKeys') or []
        fresh = {key for marker in (data.get('mediaOwnershipTemporaryOwners') or [])
                 if isinstance(marker, dict) and isinstance(marker.get('ownerId'), str)
                 and marker['ownerId'] in published_owner_ids and isinstance(marker.get('assetKeys'), list)
                 for key in marker['assetKeys'] if isinstance(key, str)}
        videos = fields.get('videos') or []
        generated_history = result.get('generatedHistory') or []
        for index, asset_key in enumerate(result.get('mediaAssetKeys') or []):
            if not isinstance(asset_key, str) or asset_key not in fresh or asset_key not in owned:
                continue
            metadata = generated_history[index] if index < len(generated_history) else {}
            video = videos[index] if node['type'] == 'VideoGenerate' and index < len(videos) else {}
            prompt = _text(metadata.get('prompt') or video.get('prompt') or fields.get('prompt'), 20000)
            model = _text(metadata.get('model'), 200) or model_names.get(fields.get('apiConfigId'), '')
            try:
                asset = storage_service.get_asset(asset_key)
                mime = asset[0]['mime_type'] if asset else ''
                if mime not in MIME_EXTENSIONS or not mime.startswith(_GENERATED_MEDIA_TYPES[node['type']]):
                    failed += 1
                    continue
                entry = {'nodeId': node_id, 'prompt': prompt, 'model': model,
                         'mimeType': mime, 'usePromptFilename': use_prompt_filename}
                duration = _number(metadata.get('generationDurationSeconds'))
                if duration is not None and duration >= 0:
                    entry['generationDurationSeconds'] = duration
                library.save(entry, asset[1])
                saved += 1
            except (OSError, sqlite3.Error, StorageError, ValueError):
                failed += 1
    return {'saved': saved, 'failed': failed}


def _prompt_library():
    document = storage_service.get_document('prompt_library')
    value = document['value']
    if value is None:
        value = []
    if not isinstance(value, list):
        raise CanvasMcpError(409, 'The saved prompt library is invalid.', 'invalid_prompt_library')
    return value, document['updatedAt']


def _prompt_entry(record, index):
    if not isinstance(record, dict):
        return None
    content = record.get('content') if isinstance(record.get('content'), str) else ''
    name = record.get('name').strip() if isinstance(record.get('name'), str) else ''
    if not name and not content.strip():
        return None
    first_line = next((line.strip() for line in content.splitlines() if line.strip()), '')
    identifier = record.get('id')
    return {
        'id': identifier if isinstance(identifier, str) and identifier else f'legacy-prompt-{index}',
        'name': name or first_line[:40] or '未命名提示词', 'content': content,
        'createdAt': record['createdAt'] if isinstance(record.get('createdAt'), str) else '',
        'updatedAt': record['updatedAt'] if isinstance(record.get('updatedAt'), str) else '',
    }


def _prompt_entries(value):
    return [(index, entry) for index, record in enumerate(value) if (entry := _prompt_entry(record, index))]


def list_prompts(args):
    offset, limit = _page(args, 50)
    query = args.get('query', '')
    if not isinstance(query, str) or len(query) > 200:
        raise CanvasMcpError(400, 'Invalid prompt search query.', 'invalid_arguments')
    value, _ = _prompt_library()
    needle = query.strip().lower()
    entries = [entry for _, entry in _prompt_entries(value)
               if not needle or needle in f"{entry['name']}\n{entry['content']}".lower()]
    items, size = [], 0
    for entry in entries[offset:offset + limit]:
        exposed = {field: _text(entry[field], maximum) for field, maximum in (
            ('id', 200), ('name', 200), ('content', 20000), ('createdAt', 100), ('updatedAt', 100))}
        if len(entry['content']) > 20000:
            exposed['contentOmitted'] = True
        size += len(json.dumps(exposed, ensure_ascii=False).encode('utf-8', errors='replace'))
        if items and size > 100000:
            break
        items.append(exposed)
    end = offset + len(items)
    return {'prompts': items, 'total': len(entries), 'nextOffset': end if end < len(entries) else None}


def get_prompt(args):
    fields = [key for key in ('promptId', 'name') if key in args]
    query = args.get(fields[0]) if len(fields) == 1 else None
    if not isinstance(query, str) or not query.strip() or len(query) > 200:
        raise CanvasMcpError(400, 'Provide one prompt ID or exact name.', 'invalid_arguments')
    field = 'id' if fields[0] == 'promptId' else 'name'
    value, _ = _prompt_library()
    matches = [entry for _, entry in _prompt_entries(value) if entry[field] == (query if field == 'id' else query.strip())]
    if not matches:
        raise CanvasMcpError(404, 'The prompt preset was not found.', 'prompt_not_found')
    if len(matches) != 1:
        raise CanvasMcpError(409, 'The prompt preset is ambiguous. Use a unique prompt ID.', 'ambiguous_prompt')
    if not matches[0]['content'].strip() or len(matches[0]['content']) > 20000:
        raise CanvasMcpError(400, 'The prompt preset must have 1 to 20000 characters.', 'invalid_arguments')
    return matches[0]


def save_prompt(args):
    name, content = args.get('name'), args.get('content')
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 80 or not isinstance(content, str)
            or not content.strip() or len(content) > 20000):
        raise CanvasMcpError(400, 'A valid prompt name and content are required.', 'invalid_arguments')
    name = name.strip()
    for _ in range(5):
        value, revision = _prompt_library()
        matches = [(index, entry) for index, entry in _prompt_entries(value) if entry['name'] == name]
        if len(matches) > 1:
            raise CanvasMcpError(409, 'The prompt name is ambiguous.', 'ambiguous_prompt')
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        if matches:
            index, existing = matches[0]
            updated = {**existing, 'name': name, 'content': content, 'updatedAt': now}
            value[index] = {**value[index], **updated}
        else:
            updated = {'id': 'prompt_' + uuid.uuid4().hex, 'name': name, 'content': content, 'createdAt': now, 'updatedAt': now}
            value.insert(0, updated)
        try:
            storage_service.put_document('prompt_library', value, expected_updated_at=revision)
            return updated
        except StorageDocumentConflict:
            continue
    raise CanvasMcpError(409, 'The prompt library was edited concurrently. Try again.', 'stale_prompt_library')


def _session():
    value = storage_service.get_document('session')['value']
    return value if isinstance(value, dict) else {}


def get_runtime_configuration():
    session = _session()
    options = {key: [row for row in session.get(key, []) if isinstance(row, dict)]
               if isinstance(session.get(key), list) else [] for key in ('models', 'providers')}
    options['protocolOverrides'] = load_protocol_overrides()
    return options


def _provider_origin(url):
    if not isinstance(url, str) or not url or _CONTROL.search(url):
        return None
    try:
        parts = urlsplit(url)
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None
                or parts.password is not None):
            return None
        return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80)
    except ValueError:
        return None


class _ProviderRedirectHandler(HTTPRedirectHandler):
    # The shared opener already contains urllib's default redirect handler.
    handler_order = 100

    def redirect_request(self, request, response, code, message, headers, url):
        if _provider_origin(url) != _provider_origin(request.full_url):
            response.close()
            raise CanvasMcpError(403, 'The configured provider returned a redirect to another origin.', 'provider_target_rejected')
        return super().redirect_request(request, response, code, message, headers, url)


def request_provider(args, providers):
    url, method, supplied_headers = args.get('url'), args.get('method'), args.get('headers', {})
    origin = _provider_origin(url)
    if origin is None or origin not in {_provider_origin(item.get('endpoint')) for item in providers if isinstance(item, dict)}:
        raise CanvasMcpError(403, 'The network target is outside the saved provider origins.', 'provider_target_rejected')
    if method not in ('GET', 'POST') or not isinstance(supplied_headers, dict) or len(supplied_headers) > 32:
        raise CanvasMcpError(400, 'The provider request is invalid.', 'invalid_arguments')
    headers = {}
    for name, value in supplied_headers.items():
        if (not isinstance(name, str) or not _HEADER_NAME.fullmatch(name) or not isinstance(value, str)
                or len(value) > 16384 or _CONTROL.search(value)):
            raise CanvasMcpError(400, 'The provider request contains an invalid header.', 'invalid_arguments')
        if name.lower() not in _TRANSPORT_HEADERS:
            headers[name.lower()] = value
    headers.setdefault('user-agent', get_app_user_agent())
    headers.setdefault('accept', 'application/json')
    headers['accept-encoding'] = 'identity'
    encoded_body = args.get('body')
    if encoded_body is not None and not isinstance(encoded_body, str):
        raise CanvasMcpError(400, 'The provider request body is invalid.', 'invalid_arguments')
    if encoded_body and len(encoded_body) > 4 * ((_MAX_BINARY_BYTES + 2) // 3):
        raise CanvasMcpError(413, 'The provider request body is too large.', 'provider_body_too_large')
    try:
        body = None if encoded_body is None else base64.b64decode(encoded_body, validate=True)
    except (TypeError, ValueError) as error:
        raise CanvasMcpError(400, 'The provider request body is invalid.', 'invalid_arguments') from error
    if body is not None and len(body) > _MAX_BINARY_BYTES:
        raise CanvasMcpError(413, 'The provider request body is too large.', 'provider_body_too_large')

    proxy = _session().get('proxy')
    options = {'proxy_enabled': proxy.get('enabled') is True, 'proxy_host': proxy.get('ip'),
               'proxy_port': proxy.get('port')} if isinstance(proxy, dict) else {}
    opener, _ = build_upstream_opener(**options)
    opener.add_handler(_ProviderRedirectHandler())
    try:
        try:
            response = opener.open(Request(url, data=body, headers=headers, method=method), timeout=300)
        except HTTPError as error:
            response = error
        with response:
            response_data = response.read(_MAX_BINARY_BYTES + 1)
            if len(response_data) > _MAX_BINARY_BYTES:
                raise CanvasMcpError(413, 'The provider response is too large.', 'provider_body_too_large')
            response_headers = {name: value for name, value in response.headers.items()
                                if name.lower() in ('content-type', 'retry-after')}
            return {'status': response.code, 'headers': response_headers,
                    'body': base64.b64encode(response_data).decode('ascii')}
    except (OSError, HTTPException, ValueError) as error:
        raise CanvasMcpError(502, 'The saved provider did not return a response.', 'provider_unavailable') from error
