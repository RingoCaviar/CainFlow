from urllib.parse import parse_qs, urlparse

from backend.services.download_service import classify_download_error, stream_remote_download
from backend.services.http_helpers import read_json_body, write_error, write_json
from backend.services.media_recovery_service import recover_image_from_response_text


def handle_get(handler):
    parsed = urlparse(handler.path)
    if parsed.path != '/api/media/download':
        return False

    query = parse_qs(parsed.query or '', keep_blank_values=True)
    target_url = str((query.get('url') or [''])[0]).strip()
    filename = str((query.get('filename') or [''])[0]).strip()

    try:
        stream_remote_download(handler, target_url, filename=filename)
    except Exception as error:
        status, message = classify_download_error(error)
        write_error(handler, status, message, error)
    return True


def handle_post(handler):
    parsed = urlparse(handler.path)
    if parsed.path == '/api/media/recover-image':
        try:
            payload = read_json_body(handler)
        except Exception as error:
            write_error(handler, 400, 'Invalid JSON body', error)
            return True

        result = recover_image_from_response_text(
            text=str((payload or {}).get('body') or ''),
            content_type=str((payload or {}).get('contentType') or ''),
        )
        status = 200 if result.get('success') else 422
        write_json(handler, result, status=status)
        return True

    if parsed.path != '/api/media/download':
        return False

    try:
        payload = read_json_body(handler)
    except Exception as error:
        write_error(handler, 400, 'Invalid JSON body', error)
        return True

    target_url = str((payload or {}).get('url') or '').strip()
    filename = str((payload or {}).get('filename') or '').strip()

    try:
        stream_remote_download(handler, target_url, filename=filename)
    except Exception as error:
        status, message = classify_download_error(error)
        write_error(handler, status, message, error)
    return True


def handle_delete(handler):
    return False
