import base64
import select
import socket
import ssl
import threading
import urllib.error
import urllib.request
from http.client import RemoteDisconnected
from urllib.parse import unquote

from backend import config, state
from backend.services.http_helpers import read_request_body, write_error
from backend.services.log_service import (
    finalize_request_log,
    sanitize_headers,
    sanitize_url,
    set_error_data,
    set_request_data,
    set_response_data,
)
from backend.services.security_service import is_safe_url


def _is_client_disconnect_error(error):
    return isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError))


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


def _get_header_value(headers, name, default=None):
    lowered_name = name.lower()
    for key, value in headers:
        if str(key).lower() == lowered_name:
            return value
    return default


def handle_proxy_request(handler):
    target_url_b64 = handler.headers.get('x-target-url-b64')
    target_url = None
    if target_url_b64:
        try:
            padding = '=' * (-len(target_url_b64) % 4)
            target_url = base64.urlsafe_b64decode(f'{target_url_b64}{padding}'.encode('ascii')).decode('utf-8')
        except Exception:
            write_error(handler, 400, 'Invalid x-target-url-b64 header')
            return
    else:
        target_url = handler.headers.get('x-target-url')
        if target_url:
            target_url = unquote(target_url)
    target_method = handler.headers.get('x-target-method', 'POST')
    set_request_data(handler, targetUrl=sanitize_url(target_url), targetMethod=target_method)

    if not target_url:
        write_error(handler, 400, 'Missing x-target-url header')
        return
    if not is_safe_url(target_url):
        write_error(handler, 403, 'Forbidden: Target URL is not allowed')
        return

    body = read_request_body(handler, default=None)

    req_headers = {}
    for key, value in handler.headers.items():
        lowered = key.lower()
        if lowered not in ['host', 'x-target-url', 'x-target-url-b64', 'x-target-method', 'content-length', 'connection', 'origin', 'referer', 'accept-encoding']:
            req_headers[key] = value

    req_headers['Connection'] = 'keep-alive'
    if 'user-agent' not in [header.lower() for header in req_headers.keys()]:
        req_headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CainFlow/2.7.6.1'

    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    try:
        request = urllib.request.Request(target_url, data=body, headers=req_headers, method=target_method)

        header_proxy_enabled = handler.headers.get('x-proxy-enabled')
        if header_proxy_enabled is not None:
            proxy_enabled = header_proxy_enabled.lower() == 'true'
            proxy_host = handler.headers.get('x-proxy-host', state.ACTIVE_PROXY.get('ip'))
            proxy_port = handler.headers.get('x-proxy-port', state.ACTIVE_PROXY.get('port'))
        else:
            proxy_enabled = state.ACTIVE_PROXY.get('enabled')
            proxy_host = state.ACTIVE_PROXY.get('ip')
            proxy_port = state.ACTIVE_PROXY.get('port')

        opener = None
        if proxy_enabled:
            proxy_url = f'http://{proxy_host}:{proxy_port}'
            proxy_handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
            opener = urllib.request.build_opener(proxy_handler, urllib.request.HTTPSHandler(context=context))

        try:
            raw_timeout = handler.headers.get('x-proxy-timeout', '300')
            timeout_val = max(1.0, min(float(raw_timeout), 1800.0))
        except (ValueError, TypeError):
            timeout_val = 300.0

        set_request_data(
            handler,
            upstreamRequestHeaders=sanitize_headers(req_headers),
            proxy={
                'enabled': proxy_enabled,
                'host': str(proxy_host),
                'port': str(proxy_port),
            },
            timeoutSeconds=timeout_val,
        )

        upstream = {'response': None, 'status': 500, 'headers': [], 'error': None}
        client_disconnected = threading.Event()

        def open_upstream():
            try:
                if opener:
                    response = opener.open(request, timeout=timeout_val)
                else:
                    response = urllib.request.urlopen(request, context=context, timeout=timeout_val)
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
            ready, _, _ = select.select([handler.request], [], [], 0.5)
            if ready:
                try:
                    peek = handler.request.recv(1, socket.MSG_PEEK)
                    if not peek:
                        client_disconnected.set()
                        if upstream['response']:
                            upstream['response'].close()
                        set_error_data(handler, 'Client disconnected before upstream response completed', category='client_disconnect')
                        set_response_data(handler, status=499)
                        finalize_request_log(handler)
                        return
                except ConnectionResetError:
                    client_disconnected.set()
                    if upstream['response']:
                        upstream['response'].close()
                    set_error_data(handler, 'Client disconnected before upstream response completed', category='client_disconnect')
                    set_response_data(handler, status=499)
                    finalize_request_log(handler)
                    return
                except Exception:
                    pass
            thread.join(0.1)

        if client_disconnected.is_set():
            return
        if upstream['error']:
            raise upstream['error']

        response_handle = upstream['response']
        response_headers_to_send = []
        for key, value in upstream['headers']:
            lowered = str(key).lower()
            if lowered not in [
                'content-length',
                'transfer-encoding',
                'connection',
                'keep-alive',
                'trailer',
                'upgrade',
                'access-control-allow-origin',
                'content-disposition',
                'content-security-policy',
                'x-content-type-options',
            ]:
                response_headers_to_send.append((key, value))

        content_type = _get_header_value(upstream['headers'], 'Content-Type')
        handler.send_response(upstream['status'])
        for key, value in response_headers_to_send:
            handler.send_header(key, value)
        handler.end_headers()

        preview = bytearray()
        total_bytes = 0

        try:
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
                set_error_data(handler, 'Client disconnected while streaming the upstream response', detail=error, exception=error, category='client_disconnect')
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

    except urllib.error.URLError as error:
        if _is_client_disconnect_error(error):
            set_error_data(handler, 'Client disconnected during proxy request', detail=error, exception=error, category='client_disconnect')
            finalize_request_log(handler)
            return
        if _is_upstream_disconnect_error(error):
            write_error(handler, 502, 'Upstream connection closed', error)
            return
        write_error(handler, 504, 'API Connection Error', error)
    except socket.timeout:
        write_error(handler, 504, 'API Connection Timeout')
    except Exception as error:
        if _is_client_disconnect_error(error):
            set_error_data(handler, 'Client disconnected during proxy request', detail=error, exception=error, category='client_disconnect')
            finalize_request_log(handler)
            return
        if _is_upstream_disconnect_error(error):
            write_error(handler, 502, 'Upstream connection closed', error)
            return
        write_error(handler, 500, 'Proxy request failed', error)


"""Securely forwards frontend proxy requests to upstream AI services."""
