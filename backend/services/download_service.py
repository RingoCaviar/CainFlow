import os
import socket
import ssl
import threading
import urllib.error
import urllib.request
from http.client import RemoteDisconnected
from urllib.parse import quote, urlparse

from backend import config
from backend.services.log_service import finalize_request_log, set_error_data, set_request_data, set_response_data
from backend.services.security_service import build_upstream_opener, is_safe_url
from backend.services.version_service import get_app_user_agent


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

    if not _is_video_content_type(content_type):
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
    first_chunk = response_handle.read(config.PROXY_STREAM_CHUNK_SIZE)
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

    response_headers_to_send = [
        ('Content-Type', content_type or 'application/octet-stream'),
        ('Content-Disposition', _build_content_disposition(download_name)),
        ('Connection', 'close'),
    ]
    if content_length:
        response_headers_to_send.append(('Content-Length', str(content_length)))

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
                content_type=content_type,
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
        content_type=content_type,
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
