import json
import threading
import time
import traceback
import uuid
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from backend import config

_LOG_WRITE_LOCK = threading.Lock()
_REQUEST_CONTEXT_ATTR = '_cainflow_request_log'

_SENSITIVE_QUERY_KEYS = {
    'key',
    'api_key',
    'apikey',
    'token',
    'access_token',
}

_SENSITIVE_HEADER_KEYS = {
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'set-cookie',
}

_SENSITIVE_BODY_KEYS = {
    'authorization',
    'apikey',
    'api_key',
    'api-key',
    'x-api-key',
    'key',
    'token',
    'access_token',
}


def should_log_path(raw_path):
    path = (urlparse(raw_path).path or '').strip()
    return path == '/proxy' or path.startswith('/api/')


def start_request_log(handler):
    if not should_log_path(getattr(handler, 'path', '')):
        return None

    parsed = urlparse(handler.path)
    started_at = datetime.now().astimezone()
    context = {
        'finalized': False,
        'start_perf': time.perf_counter(),
        'startedAt': started_at.isoformat(timespec='milliseconds'),
        'startedAtMs': int(started_at.timestamp() * 1000),
        'requestId': f'req_{uuid.uuid4().hex[:12]}',
        'method': getattr(handler, 'command', ''),
        'path': parsed.path,
        'query': parsed.query,
        'clientIp': handler.client_address[0] if getattr(handler, 'client_address', None) else '',
        'request': {
            'headers': sanitize_headers(dict(handler.headers.items())),
        },
        'response': None,
        'error': None,
    }
    setattr(handler, _REQUEST_CONTEXT_ATTR, context)
    return context


def get_request_log(handler):
    return getattr(handler, _REQUEST_CONTEXT_ATTR, None)


def set_request_data(handler, **fields):
    context = get_request_log(handler)
    if not context:
        return
    context['request'].update({key: value for key, value in fields.items() if value is not None})


def set_request_body(handler, body, content_type=None, partial=False):
    context = get_request_log(handler)
    if not context:
        return
    context['request'].update(summarize_body(body, content_type=content_type, partial=partial))
    if content_type:
        context['request']['contentType'] = content_type


def set_response_data(handler, status=None, headers=None, body=None, content_type=None, total_bytes=None, partial=False, **extra_fields):
    context = get_request_log(handler)
    if not context:
        return

    response = context.get('response') or {}
    if status is not None:
        response['status'] = status
    if headers is not None:
        response['headers'] = sanitize_headers(headers)
    if content_type:
        response['contentType'] = content_type
    if body is not None or total_bytes is not None:
        response.update(summarize_body(body, content_type=content_type, total_bytes=total_bytes, partial=partial))
    for key, value in extra_fields.items():
        if value is not None:
            response[key] = value
    context['response'] = response


def set_error_data(handler, message, detail=None, exception=None, category=None):
    context = get_request_log(handler)
    if not context:
        return

    error_payload = {
        'message': str(message),
    }
    if category:
        error_payload['category'] = category
    if detail is not None:
        error_payload['detail'], _ = sanitize_value(detail)
    if exception is not None:
        error_payload['type'] = type(exception).__name__
        stack = ''.join(traceback.format_exception(type(exception), exception, exception.__traceback__))
        error_payload['traceback'] = truncate_text(stack, config.LOG_STACK_PREVIEW_LIMIT)[0]
    context['error'] = error_payload


def finalize_request_log(handler):
    context = get_request_log(handler)
    if not context or context.get('finalized'):
        return

    context['finalized'] = True
    finished_at = datetime.now().astimezone()
    duration_ms = int((time.perf_counter() - context['start_perf']) * 1000)
    payload = {
        'timestamp': context['startedAt'],
        'timestampMs': context['startedAtMs'],
        'startedAt': context['startedAt'],
        'startedAtMs': context['startedAtMs'],
        'finishedAt': finished_at.isoformat(timespec='milliseconds'),
        'finishedAtMs': int(finished_at.timestamp() * 1000),
        'requestId': context['requestId'],
        'channel': 'backend-api',
        'method': context['method'],
        'path': context['path'],
        'query': context['query'],
        'clientIp': context['clientIp'],
        'durationMs': duration_ms,
        'request': context.get('request') or {},
        'response': context.get('response'),
        'error': context.get('error'),
    }
    _append_log_line(payload)


def sanitize_url(url):
    if not url:
        return url

    parsed = urlparse(str(url))
    if not parsed.query:
        return str(url)

    query_items = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key.lower() in _SENSITIVE_QUERY_KEYS:
            query_items.append((key, '[REDACTED]'))
        else:
            safe_value, _ = sanitize_text(value)
            query_items.append((key, safe_value))

    return urlunparse(parsed._replace(query=urlencode(query_items, doseq=True)))


def sanitize_headers(headers):
    if headers is None:
        return None

    if hasattr(headers, 'items'):
        items = headers.items()
    else:
        items = headers

    sanitized = {}
    for key, value in items:
        if not key:
            continue
        normalized = str(key).lower()
        if normalized in _SENSITIVE_HEADER_KEYS:
            sanitized[str(key)] = '[REDACTED]'
        else:
            safe_value, _ = sanitize_text(str(value))
            sanitized[str(key)] = safe_value
    return sanitized


def summarize_body(body, content_type=None, total_bytes=None, partial=False):
    body_bytes = total_bytes
    if body is None:
        return {
            'bodyPreview': None,
            'bodyTruncated': False,
            'bodyBytes': body_bytes or 0,
        }

    if isinstance(body, bytes):
        if body_bytes is None:
            body_bytes = len(body)
        if not _is_textual_content_type(content_type) and not _looks_like_text(body):
            return {
                'bodyPreview': f'[binary content omitted; type={content_type or "application/octet-stream"}; bytes={body_bytes}]',
                'bodyTruncated': body_bytes > 0,
                'bodyBytes': body_bytes,
            }
        text = body.decode('utf-8', errors='replace')
    else:
        text = str(body)
        if body_bytes is None:
            body_bytes = len(text.encode('utf-8', errors='replace'))

    if not partial and _is_json_content_type(content_type):
        try:
            parsed = json.loads(text)
            preview, truncated = sanitize_value(parsed)
            return {
                'bodyPreview': preview,
                'bodyTruncated': truncated,
                'bodyBytes': body_bytes,
            }
        except Exception:
            pass

    if not partial and _is_form_content_type(content_type):
        preview, truncated = sanitize_form_encoded(text)
        return {
            'bodyPreview': preview,
            'bodyTruncated': truncated,
            'bodyBytes': body_bytes,
        }

    safe_text, text_truncated = sanitize_text(text)
    body_truncated = text_truncated or (partial and body_bytes > len(text.encode('utf-8', errors='replace')))
    return {
        'bodyPreview': safe_text,
        'bodyTruncated': body_truncated,
        'bodyBytes': body_bytes,
    }


def sanitize_form_encoded(text):
    try:
        pairs = parse_qsl(text, keep_blank_values=True)
    except Exception:
        safe_text, truncated = sanitize_text(text)
        return safe_text, truncated

    payload = {}
    any_truncated = False
    for key, value in pairs:
        if key.lower() in _SENSITIVE_QUERY_KEYS:
            safe_value = '[REDACTED]'
        else:
            safe_value, truncated = sanitize_text(value)
            any_truncated = any_truncated or truncated

        if key in payload:
            if isinstance(payload[key], list):
                payload[key].append(safe_value)
            else:
                payload[key] = [payload[key], safe_value]
        else:
            payload[key] = safe_value
    return payload, any_truncated


def sanitize_value(value):
    if isinstance(value, dict):
        sanitized = {}
        any_truncated = False
        for key, item in value.items():
            if str(key).lower() in _SENSITIVE_BODY_KEYS:
                sanitized[key] = '[REDACTED]'
                continue
            safe_item, truncated = sanitize_value(item)
            sanitized[key] = safe_item
            any_truncated = any_truncated or truncated
        return sanitized, any_truncated

    if isinstance(value, list):
        sanitized = []
        any_truncated = False
        for item in value:
            safe_item, truncated = sanitize_value(item)
            sanitized.append(safe_item)
            any_truncated = any_truncated or truncated
        return sanitized, any_truncated

    if isinstance(value, str):
        return sanitize_text(value)

    if value is None or isinstance(value, (int, float, bool)):
        return value, False

    return sanitize_text(value)


def sanitize_text(text):
    value = str(text)
    lowered = value.lower()
    if lowered.startswith('data:image/') and ';base64,' in lowered:
        prefix, encoded = value.split(',', 1)
        mime = prefix[5:].split(';', 1)[0]
        return f'[data-url omitted; mime={mime}; encodedLength={len(encoded)}]', True
    return truncate_text(value, config.LOG_TEXT_PREVIEW_LIMIT)


def truncate_text(text, limit):
    value = str(text)
    if len(value) <= limit:
        return value, False
    remaining = len(value) - limit
    return f'{value[:limit]}... [truncated {remaining} chars]', True


def _append_log_line(payload):
    line = json.dumps(payload, ensure_ascii=False) + '\n'
    path = config.get_log_file_path()
    with _LOG_WRITE_LOCK:
        with open(path, 'a', encoding='utf-8') as file:
            file.write(line)


def _is_json_content_type(content_type):
    lowered = (content_type or '').lower()
    return 'application/json' in lowered or lowered.endswith('+json')


def _is_form_content_type(content_type):
    lowered = (content_type or '').lower()
    return 'application/x-www-form-urlencoded' in lowered


def _is_textual_content_type(content_type):
    lowered = (content_type or '').lower()
    if not lowered:
        return False
    if lowered.startswith('text/'):
        return True
    return any(token in lowered for token in ('json', 'xml', 'javascript', 'html', 'form-urlencoded'))


def _looks_like_text(data):
    sample = data[: min(len(data), config.LOG_BINARY_SNIFF_BYTES)]
    if not sample:
        return True
    if b'\x00' in sample:
        return False

    printable = 0
    for byte in sample:
        if byte in (9, 10, 13) or 32 <= byte <= 126:
            printable += 1
    return printable / len(sample) >= 0.85
