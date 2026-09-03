import ipaddress
from urllib.parse import parse_qs, unquote, urlparse

from backend import config
from backend.services.http_helpers import read_json_body, read_request_body, write_bytes, write_error, write_json
from backend.services.storage_service import DOCUMENT_NAMES, StorageError, storage_service


def _document_name(path):
    prefix = '/api/storage/documents/'
    return unquote(path[len(prefix):]) if path.startswith(prefix) else ''


def _asset_key(path):
    prefix = '/api/storage/assets/'
    return unquote(path[len(prefix):]) if path.startswith(prefix) else ''


def _is_authorized_local_request(handler):
    try:
        if not ipaddress.ip_address(handler.client_address[0]).is_loopback:
            return False
    except (ValueError, TypeError, IndexError):
        return False
    origin = str(handler.headers.get('Origin') or '').strip()
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'} and parsed.port == config.PORT


def _authorize_storage_path(handler, path):
    if not path.startswith('/api/storage/'):
        return True
    if _is_authorized_local_request(handler):
        return True
    write_error(handler, 403, 'Storage API is available only to the local CainFlow origin')
    return False


def handle_get(handler):
    parsed = urlparse(handler.path)
    path = parsed.path
    if not _authorize_storage_path(handler, path):
        return True
    if path.startswith('/api/storage/documents/'):
        name = _document_name(path)
        if name not in DOCUMENT_NAMES:
            write_error(handler, 404, 'Unknown storage document')
        else:
            write_json(handler, storage_service.get_document(name))
        return True
    if path.startswith('/api/storage/assets/'):
        result = storage_service.get_asset(_asset_key(path))
        if not result:
            write_error(handler, 404, 'Asset not found')
        else:
            info, body = result
            write_bytes(handler, body, content_type=info['mime_type'], headers={
                'Cache-Control': 'private, max-age=31536000, immutable',
                'X-CainFlow-Asset-Size': str(info['size_bytes']),
            })
        return True
    if path == '/api/storage/history':
        query = parse_qs(parsed.query)
        limit = int((query.get('limit') or ['0'])[0] or 0)
        write_json(handler, {'items': storage_service.list_history(limit), 'count': len(storage_service.list_history())})
        return True
    if path.startswith('/api/storage/history/'):
        item = storage_service.get_history(int(path.rsplit('/', 1)[-1]))
        write_json(handler, {'item': item}, status=200 if item else 404)
        return True
    if path == '/api/storage/maintenance':
        write_json(handler, storage_service.get_stats())
        return True
    if path.startswith('/api/storage/media-assets/'):
        info = storage_service.get_asset_info(unquote(path[len('/api/storage/media-assets/'):]))
        write_json(handler, {'asset': info}, status=200 if info else 404)
        return True
    if path == '/api/storage/migration':
        write_json(handler, {
            'completed': storage_service.get_meta('browser_migration_completed') == '1',
            'hasUserData': storage_service.has_user_data(),
        })
        return True
    if path == '/api/storage/export-directory':
        write_json(handler, {'directory': storage_service.get_export_directory()})
        return True
    return False


def handle_put(handler):
    path = urlparse(handler.path).path
    if not _authorize_storage_path(handler, path):
        return True
    try:
        if path.startswith('/api/storage/documents/'):
            name = _document_name(path)
            data = read_json_body(handler)
            updated_at = storage_service.put_document(name, data.get('value'))
            write_json(handler, {'success': True, 'updatedAt': updated_at})
            return True
        if path.startswith('/api/storage/assets/'):
            body = read_request_body(handler)
            info = storage_service.put_asset(
                _asset_key(path), body,
                mime_type=handler.headers.get('Content-Type', 'application/octet-stream'),
                kind=handler.headers.get('X-CainFlow-Asset-Kind', 'asset'),
            )
            write_json(handler, {'success': True, 'asset': info})
            return True
        if path == '/api/storage/media-assets':
            body = read_request_body(handler)
            info = storage_service.put_media_asset(
                body, handler.headers.get('Content-Type', 'application/octet-stream'),
                handler.headers.get('X-CainFlow-Media-Owner-Type', ''),
                handler.headers.get('X-CainFlow-Media-Owner-Id', ''),
            )
            write_json(handler, {'success': True, 'asset': info})
            return True
    except StorageError as error:
        write_error(handler, 400, str(error))
        return True
    return False


def handle_post(handler):
    path = urlparse(handler.path).path
    if not _authorize_storage_path(handler, path):
        return True
    try:
        if path == '/api/storage/history':
            history_id = storage_service.save_history(read_json_body(handler))
            write_json(handler, {'success': True, 'id': history_id})
            return True
        if path == '/api/storage/media-assets':
            data = read_json_body(handler)
            action = str(data.get('action') or '')
            if action == 'reference':
                asset = storage_service.add_media_reference(data.get('ownerType'), data.get('ownerId'), data.get('assetKey'))
                result = {'asset': asset}
            elif action == 'unreference':
                result = storage_service.remove_media_reference(data.get('ownerType'), data.get('ownerId'), data.get('assetKey'))
            elif action == 'cache-limit':
                result = {'mediaCacheLimitBytes': storage_service.set_media_cache_limit(data.get('limitBytes'))}
            else:
                raise StorageError('Unknown media asset action')
            write_json(handler, {'success': True, **result})
            return True
        if path == '/api/storage/maintenance':
            data = read_json_body(handler)
            action = str(data.get('action') or '')
            if action == 'clear-temporary':
                result = storage_service.clear_temporary()
            elif action == 'clear-history':
                storage_service.clear_history()
                result = {'success': True}
            elif action == 'factory-reset':
                storage_service.factory_reset()
                result = {'success': True}
            elif action == 'clear-assets':
                result = storage_service.cleanup_assets(data.get('mode', ''), data.get('keepKeys') or [])
            elif action == 'trim-history':
                storage_service.trim_history()
                result = {'success': True}
            else:
                raise StorageError('Unknown maintenance action')
            write_json(handler, {'success': True, **result})
            return True
        if path == '/api/storage/migration':
            data = read_json_body(handler)
            if storage_service.has_user_data() and storage_service.get_meta('browser_migration_started') != '1':
                if data.get('replace') is not True:
                    raise StorageError('Disk storage already contains user data; explicit replacement confirmation is required')
                if not storage_service.get_meta('browser_migration_backup'):
                    backup_path = storage_service.backup_database('pre-browser-migration')
                    storage_service.set_meta('browser_migration_backup', backup_path)
            storage_service.set_meta('browser_migration_started', '1')
            for name, value in (data.get('documents') or {}).items():
                if name in DOCUMENT_NAMES:
                    storage_service.put_document(name, value)
            if data.get('complete') is True:
                storage_service.set_meta('browser_migration_completed', '1')
                storage_service.set_meta('browser_migration_started', '0')
            write_json(handler, {'success': True, 'completed': data.get('complete') is True})
            return True
        if path == '/api/storage/export-directory':
            directory = storage_service.set_export_directory(read_json_body(handler).get('directory', ''))
            write_json(handler, {'success': True, 'directory': directory})
            return True
        if path == '/api/storage/export-media':
            filename = handler.headers.get('X-CainFlow-Filename', 'CainFlow-media.bin')
            destination = storage_service.export_media(filename, read_request_body(handler))
            write_json(handler, {'success': True, 'filename': destination.rsplit('\\', 1)[-1].rsplit('/', 1)[-1]})
            return True
    except (StorageError, ValueError) as error:
        write_error(handler, 400, str(error))
        return True
    return False


def handle_delete(handler):
    path = urlparse(handler.path).path
    if not _authorize_storage_path(handler, path):
        return True
    if path.startswith('/api/storage/assets/'):
        write_json(handler, {'success': storage_service.delete_asset(_asset_key(path))})
        return True
    if path.startswith('/api/storage/history/'):
        write_json(handler, {'success': storage_service.delete_history(int(path.rsplit('/', 1)[-1]))})
        return True
    return False
