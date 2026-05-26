import os
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.client import RemoteDisconnected
from urllib.parse import quote, urlparse

from backend import config
from backend.services.log_service import finalize_request_log, set_error_data, set_request_data, set_response_data
from backend.services.security_service import build_upstream_opener, is_safe_url
from backend.services.version_service import get_app_user_agent


MULTIPART_MIN_BYTES = 8 * 1024 * 1024
MULTIPART_CHUNK_BYTES = 4 * 1024 * 1024
MULTIPART_MAX_WORKERS = 4
MULTIPART_SLOW_SPEED_BYTES_PER_SECOND = 768 * 1024


def _is_client_disconnect_error(error):
    return (
        isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError))
        and not isinstance(error, RemoteDisconnected)
    )


def _is_upstream_disconnect_error(error):
    if isinstance(error, RemoteDisconnected):
        return True

    reason = getattr(error, 'reason', None)
    if isinstance(reason, RemoteDisconnected):
        return True

    text = str(reason or error).lower()
    return (
        'remote end closed connection without response' in text
        or 'remotedisconnected' in text
        or 'upstream connection closed' in text
    )


def _guess_extension_from_content_type(content_type):
    lowered = str(content_type or '').lower()
    if 'video/webm' in lowered:
        return '.webm'
    if 'video/quicktime' in lowered:
        return '.mov'
    if 'video/x-msvideo' in lowered:
        return '.avi'
    if 'video/x-matroska' in lowered:
        return '.mkv'
    if 'video/mp4' in lowered:
        return '.mp4'
    return ''


def _is_video_content_type(content_type):
    lowered = str(content_type or '').lower()
    return lowered.startswith('video/')


def _looks_like_downloadable_video_url(target_url):
    parsed = urlparse(str(target_url or ''))
    if parsed.scheme not in ('http', 'https'):
        return False

    path = str(parsed.path or '').lower()
    if any(path.endswith(ext) for ext in ('.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v')):
        return True

    query_text = str(parsed.query or '')
    if any(token in query_text for token in ('Signature=', 'Expires=', 'response-content-disposition=', 'download=')):
        return True

    host = str(parsed.netloc or '').lower()
    if 'flow-content.google' in host or 'storage.googleapis.com' in host:
        return True

    return False


def _looks_like_video_bytes(sample, content_type=''):
    if not sample:
        return False

    data = bytes(sample[:64])
    lowered = str(content_type or '').lower()

    if len(data) >= 12 and data[4:8] == b'ftyp':
        return True
    if len(data) >= 4 and data[:4] == b'\x1a\x45\xdf\xa3':
        return True
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'AVI ':
        return True
    if 'mp2t' in lowered and len(data) >= 1 and data[0] == 0x47:
        return True
    return False


def _sanitize_filename(value, fallback='video'):
    cleaned = ''.join(
        ch if ch not in '\\/:*?"<>|\r\n\t' and ord(ch) >= 32 else ' '
        for ch in str(value or '')
    )
    cleaned = ' '.join(cleaned.split()).strip().rstrip('. ')
    cleaned = cleaned[:120].strip()
    return cleaned or fallback


def _build_download_filename(url, filename='', content_type=''):
    safe_name = _sanitize_filename(filename, 'video')
    parsed = urlparse(str(url or ''))
    path_name = os.path.basename(parsed.path or '')
    _, path_ext = os.path.splitext(path_name)
    ext = path_ext or _guess_extension_from_content_type(content_type) or '.mp4'
    if not safe_name.lower().endswith(ext.lower()):
        safe_name = f'{safe_name}{ext}'
    return safe_name


def _build_content_disposition(filename):
    safe_name = str(filename or 'video.mp4')
    ascii_name = safe_name.encode('ascii', errors='ignore').decode('ascii').strip()
    ascii_name = ascii_name.replace('"', '').replace('\\', '').strip().rstrip('. ')
    if not ascii_name:
        _, ext = os.path.splitext(safe_name)
        ascii_name = f'video{ext or ".mp4"}'
    encoded_name = quote(safe_name, safe='')
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded_name}'


def _get_header(headers, name, default=''):
    target = str(name or '').lower()
    for key, value in headers or []:
        if str(key).lower() == target:
            return value
    return default


def _parse_content_length(value):
    try:
        parsed = int(str(value or '').strip())
        return parsed if parsed > 0 else None
    except Exception:
        return None


def _supports_range_download(headers, content_length):
    if not content_length or content_length < MULTIPART_MIN_BYTES:
        return False
    accept_ranges = str(_get_header(headers, 'accept-ranges') or '').lower()
    content_range = str(_get_header(headers, 'content-range') or '').lower()
    return accept_ranges == 'bytes' or content_range.startswith('bytes ')


def _download_range(opener, target_url, base_headers, start, end):
    range_headers = dict(base_headers or {})
    range_headers['Range'] = f'bytes={start}-{end}'
    range_headers['Connection'] = 'close'
    request = urllib.request.Request(target_url, headers=range_headers, method='GET')
    response = opener.open(request, timeout=300.0)
    try:
        status = int(getattr(response, 'status', 0) or 0)
        if status != 206:
            raise ValueError(f'远程源不支持分段下载：Range {start}-{end} 返回 HTTP {status}')
        data = response.read()
        expected = end - start + 1
        if len(data) != expected:
            raise ValueError(f'分段下载长度不匹配：Range {start}-{end} 期望 {expected} B，实际 {len(data)} B')
        return start, data
    finally:
        response.close()


def _stream_multipart_download(handler, opener, target_url, base_headers, total_size, response_headers_to_send, content_type):
    handler.send_response(200)
    for key, value in response_headers_to_send:
        handler.send_header(key, value)
    handler.end_headers()
    handler.close_connection = True

    ranges = []
    start = 0
    while start < total_size:
        end = min(total_size - 1, start + MULTIPART_CHUNK_BYTES - 1)
        ranges.append((start, end))
        start = end + 1

    preview = bytearray()
    total_bytes = 0
    pending = {}
    next_index = 0
    next_to_write = 0

    set_request_data(
        handler,
        multipartDownload={
            'enabled': True,
            'workers': MULTIPART_MAX_WORKERS,
            'chunkBytes': MULTIPART_CHUNK_BYTES,
            'totalBytes': total_size,
            'chunkCount': len(ranges),
        },
    )

    try:
        with ThreadPoolExecutor(max_workers=MULTIPART_MAX_WORKERS) as executor:
            futures = {}

            def submit_more():
                nonlocal next_index
                while next_index < len(ranges) and len(futures) < MULTIPART_MAX_WORKERS:
                    start_pos, end_pos = ranges[next_index]
                    future = executor.submit(_download_range, opener, target_url, base_headers, start_pos, end_pos)
                    futures[future] = start_pos
                    next_index += 1

            submit_more()
            while futures:
                for future in as_completed(list(futures.keys())):
                    futures.pop(future)
                    range_start, data = future.result()
                    pending[range_start] = data
                    submit_more()

                    while next_to_write in pending:
                        chunk = pending.pop(next_to_write)
                        total_bytes += len(chunk)
                        remaining = config.LOG_BODY_PREVIEW_BYTES - len(preview)
                        if remaining > 0:
                            preview.extend(chunk[:remaining])
                        handler.wfile.write(chunk)
                        handler.wfile.flush()
                        next_to_write += len(chunk)
                    break
    except Exception as error:
        if _is_client_disconnect_error(error):
            set_response_data(
                handler,
                status=200,
                headers=response_headers_to_send,
                body=bytes(preview),
                content_type=content_type,
                total_bytes=total_bytes,
                partial=total_bytes > len(preview),
                bytesSent=total_bytes,
                multipartDownload=True,
            )
            set_error_data(handler, 'Client disconnected during multipart media download', detail=error, exception=error, category='client_disconnect')
            finalize_request_log(handler)
            return
        raise

    set_response_data(
        handler,
        status=200,
        headers=response_headers_to_send,
        body=bytes(preview),
        content_type=content_type,
        total_bytes=total_bytes,
        partial=total_bytes > len(preview),
        bytesSent=total_bytes,
        multipartDownload=True,
    )
    finalize_request_log(handler)


def stream_remote_download(handler, target_url, filename=''):
    if not target_url:
        raise ValueError('Missing target URL')
    if not is_safe_url(target_url):
        raise ValueError('目标地址无效，仅支持 http 或 https URL')

    set_request_data(handler, targetUrl=target_url, downloadFilename=_sanitize_filename(filename or 'video', 'video'))

    headers = {
        'Accept': '*/*',
        'User-Agent': get_app_user_agent(),
        'Connection': 'close',
    }
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    request = urllib.request.Request(target_url, headers=headers, method='GET')
    opener, resolved_proxy_info = build_upstream_opener()
    set_request_data(
        handler,
        upstreamRequestHeaders=headers,
        proxy={
            'enabled': resolved_proxy_info.get('enabled'),
            'host': resolved_proxy_info.get('host'),
            'port': resolved_proxy_info.get('port'),
            'mode': resolved_proxy_info.get('mode'),
        },
        timeoutSeconds=300.0,
    )

    upstream = {'response': None, 'status': 500, 'headers': [], 'error': None}
    client_disconnected = threading.Event()

    def open_upstream():
        try:
            response = opener.open(request, timeout=300.0)
            upstream['response'] = response
            upstream['status'] = response.status
            upstream['headers'] = list(response.getheaders())
        except urllib.error.HTTPError as error:
            upstream['response'] = error
            upstream['status'] = error.code
            upstream['headers'] = list(error.headers.items())
        except Exception as error:
            upstream['error'] = error

    thread = threading.Thread(target=open_upstream, daemon=True)
    thread.start()
    while thread.is_alive():
        thread.join(0.1)

    if client_disconnected.is_set():
        return
    if upstream['error']:
        raise upstream['error']

    response_handle = upstream['response']
    upstream_headers = upstream['headers']
    content_type = ''
    content_length = None
    for key, value in upstream_headers:
        lowered = str(key).lower()
        if lowered == 'content-type':
            content_type = value
        elif lowered == 'content-length':
            content_length = value

    if int(upstream['status'] or 0) < 200 or int(upstream['status'] or 0) >= 300:
        try:
            error_preview = response_handle.read(config.LOG_BODY_PREVIEW_BYTES)
        finally:
            if response_handle:
                response_handle.close()
        raise ValueError(
            f'远程源返回非成功状态：HTTP {upstream["status"]}，内容类型：{content_type or "unknown"}，响应预览：'
            f'{error_preview.decode("utf-8", errors="replace")[:400]}'
        )

    if not _is_video_content_type(content_type) and not _looks_like_downloadable_video_url(target_url):
        try:
            error_preview = response_handle.read(config.LOG_BODY_PREVIEW_BYTES)
        finally:
            if response_handle:
                response_handle.close()
        raise ValueError(
            f'远程源返回的不是视频文件，内容类型：{content_type or "unknown"}，响应预览：'
            f'{error_preview.decode("utf-8", errors="replace")[:400]}'
        )

    download_name = _build_download_filename(target_url, filename=filename, content_type=content_type)
    first_read_started_at = time.time()
    first_chunk = response_handle.read(config.PROXY_STREAM_CHUNK_SIZE)
    first_read_elapsed = max(0.001, time.time() - first_read_started_at)
    first_read_speed = len(first_chunk or b'') / first_read_elapsed
    if not _looks_like_video_bytes(first_chunk, content_type):
        try:
            remainder_preview = response_handle.read(config.LOG_BODY_PREVIEW_BYTES)
        finally:
            if response_handle:
                response_handle.close()
        preview_bytes = bytes(first_chunk[:config.LOG_BODY_PREVIEW_BYTES]) + bytes(remainder_preview[: max(0, config.LOG_BODY_PREVIEW_BYTES - len(first_chunk))])
        raise ValueError(
            f'远程源响应看起来不是有效视频文件，内容类型：{content_type or "unknown"}，响应预览：'
            f'{preview_bytes.decode("utf-8", errors="replace")[:400]}'
        )

    normalized_content_type = content_type or ''
    if not _is_video_content_type(normalized_content_type):
        guessed_ext = _guess_extension_from_content_type(normalized_content_type)
        if guessed_ext == '.webm':
            normalized_content_type = 'video/webm'
        elif guessed_ext == '.mov':
            normalized_content_type = 'video/quicktime'
        elif guessed_ext == '.avi':
            normalized_content_type = 'video/x-msvideo'
        elif guessed_ext == '.mkv':
            normalized_content_type = 'video/x-matroska'
        else:
            normalized_content_type = 'video/mp4'

    response_headers_to_send = [
        ('Content-Type', normalized_content_type),
        ('Content-Disposition', _build_content_disposition(download_name)),
        ('Connection', 'close'),
    ]
    if content_length:
        response_headers_to_send.append(('Content-Length', str(content_length)))

    parsed_content_length = _parse_content_length(content_length)
    can_use_multipart = (
        _supports_range_download(upstream_headers, parsed_content_length)
        and first_read_speed > 0
        and first_read_speed < MULTIPART_SLOW_SPEED_BYTES_PER_SECOND
    )
    if can_use_multipart:
        try:
            if response_handle:
                response_handle.close()
            set_request_data(
                handler,
                multipartDecision={
                    'enabled': True,
                    'reason': 'slow_initial_stream',
                    'initialSpeedBytesPerSecond': int(first_read_speed),
                    'thresholdBytesPerSecond': MULTIPART_SLOW_SPEED_BYTES_PER_SECOND,
                    'contentLength': parsed_content_length,
                },
            )
            _stream_multipart_download(
                handler,
                opener,
                target_url,
                headers,
                parsed_content_length,
                response_headers_to_send,
                normalized_content_type,
            )
            return
        except Exception as error:
            set_error_data(handler, 'Multipart media download failed', detail=error, exception=error, category='multipart_download')
            raise

    set_request_data(
        handler,
        multipartDecision={
            'enabled': False,
            'reason': 'fast_enough_or_unsupported',
            'initialSpeedBytesPerSecond': int(first_read_speed),
            'thresholdBytesPerSecond': MULTIPART_SLOW_SPEED_BYTES_PER_SECOND,
            'contentLength': parsed_content_length,
            'rangeSupported': _supports_range_download(upstream_headers, parsed_content_length),
        },
    )

    handler.send_response(upstream['status'])
    for key, value in response_headers_to_send:
        handler.send_header(key, value)
    handler.end_headers()
    handler.close_connection = True

    preview = bytearray()
    total_bytes = 0

    try:
        if first_chunk:
            total_bytes += len(first_chunk)
            remaining = config.LOG_BODY_PREVIEW_BYTES - len(preview)
            if remaining > 0:
                preview.extend(first_chunk[:remaining])
            handler.wfile.write(first_chunk)
            handler.wfile.flush()

        while True:
            chunk = response_handle.read(config.PROXY_STREAM_CHUNK_SIZE)
            if not chunk:
                break
            total_bytes += len(chunk)
            remaining = config.LOG_BODY_PREVIEW_BYTES - len(preview)
            if remaining > 0:
                preview.extend(chunk[:remaining])
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except Exception as error:
        if _is_client_disconnect_error(error):
            set_response_data(
                handler,
                status=upstream['status'],
                headers=response_headers_to_send,
                body=bytes(preview),
                content_type=normalized_content_type,
                total_bytes=total_bytes,
                partial=total_bytes > len(preview),
                bytesSent=total_bytes,
            )
            set_error_data(handler, 'Client disconnected while streaming the download response', detail=error, exception=error, category='client_disconnect')
            finalize_request_log(handler)
            return
        raise
    finally:
        if response_handle:
            response_handle.close()

    set_response_data(
        handler,
        status=upstream['status'],
        headers=response_headers_to_send,
        body=bytes(preview),
        content_type=normalized_content_type,
        total_bytes=total_bytes,
        partial=total_bytes > len(preview),
        bytesSent=total_bytes,
    )
    finalize_request_log(handler)


def classify_download_error(error):
    if _is_client_disconnect_error(error):
        return 499, 'Client disconnected during media download'
    if isinstance(error, urllib.error.HTTPError):
        return error.code, f'远程下载失败 ({error.code})'
    if isinstance(error, urllib.error.URLError):
        if _is_upstream_disconnect_error(error):
            return 502, 'Upstream connection closed'
        return 504, 'Media download connection error'
    if isinstance(error, socket.timeout):
        return 504, 'Media download timeout'
    if _is_upstream_disconnect_error(error):
        return 502, 'Upstream connection closed'
    if isinstance(error, ValueError):
        return 502, str(error)
    return 500, 'Media download failed'
