import json

from backend.services.log_service import finalize_request_log, set_error_data, set_request_body, set_response_data


def _is_client_disconnect_error(error):
    return isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError))


def read_request_body(handler, default=b''):
    length = int(handler.headers.get('content-length', 0))
    body = handler.rfile.read(length) if length > 0 else default
    set_request_body(handler, body, content_type=handler.headers.get('Content-Type'))
    return body


def read_json_body(handler):
    body = read_request_body(handler, default=b'{}')
    return json.loads(body)


def write_json(handler, payload, status=200, headers=None):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    write_bytes(
        handler,
        body,
        status=status,
        content_type='application/json; charset=utf-8',
        headers=headers,
    )


def write_text(handler, text, status=200, headers=None, content_type='text/plain; charset=utf-8'):
    body = text.encode('utf-8')
    write_bytes(handler, body, status=status, content_type=content_type, headers=headers)


def write_bytes(handler, body, status=200, content_type='application/octet-stream', headers=None):
    response_headers = {'Content-Type': content_type}
    if headers:
        response_headers.update(headers)

    try:
        handler.send_response(status)
        for key, value in response_headers.items():
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(body)
    except Exception as error:
        set_response_data(
            handler,
            status=status,
            headers=response_headers,
            body=body,
            content_type=content_type,
            total_bytes=len(body),
        )
        if _is_client_disconnect_error(error):
            set_error_data(handler, 'Client disconnected while sending response', detail=error, exception=error, category='client_disconnect')
            finalize_request_log(handler)
            return
        raise

    set_response_data(
        handler,
        status=status,
        headers=response_headers,
        body=body,
        content_type=content_type,
        total_bytes=len(body),
    )
    finalize_request_log(handler)


def write_error(handler, status, message, detail=None):
    payload = {
        'success': False,
        'error': message,
    }
    if detail is not None:
        payload['detail'] = str(detail)

    set_error_data(handler, message, detail=detail)
    write_json(handler, payload, status=status)


"""Shared helpers for backend request reading and response writing."""
