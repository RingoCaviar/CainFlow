"""Bounded, credential-free public image reads for untrusted search results.

This intentionally does not use the general API proxy: that proxy permits user
configured private model servers. Each redirect is resolved and connected to a
validated public IP, preventing DNS rebinding between validation and connect.
"""
import concurrent.futures
import http.client
import ipaddress
import socket
import ssl
import struct
import time
import zlib
from urllib.parse import urljoin, urlsplit

from backend import state

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
TIMEOUT_SECONDS = 20
_dns_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix='search-image-dns')


def resolve_public_url(url, timeout=5):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(char) < 33 for char in url):
        raise ValueError('图片地址无效')
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError('仅支持无凭据的公共 HTTP(S) 图片地址')
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    future = _dns_pool.submit(socket.getaddrinfo, parsed.hostname, port, 0, socket.SOCK_STREAM)
    try:
        addresses = future.result(timeout=timeout)
    except Exception as error:
        future.cancel()
        raise ValueError('图片地址解析失败或超时') from error
    ips = [item[4][0] for item in addresses]
    addresses = [ipaddress.ip_address(ip) for ip in ips]
    if not addresses or any(not ip.is_global or ip.is_multicast or ip.is_reserved for ip in addresses):
        raise ValueError('不允许读取本机、私有网络或保留地址')
    return parsed, port, ips[0]


class _TlsConnection(http.client.HTTPConnection):
    def __init__(self, *args, target_hostname, deadline, **kwargs):
        super().__init__(*args, **kwargs)
        self.target_hostname = target_hostname
        self.deadline = deadline

    def connect(self):
        super().connect()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('图片读取超时')
        self.sock.settimeout(remaining)
        self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.target_hostname)


def open_public_image(url, timeout):
    deadline = time.monotonic() + timeout
    parsed, port, ip = resolve_public_url(url, timeout=min(5, timeout))
    timeout = deadline - time.monotonic()
    if timeout <= 0:
        raise TimeoutError('图片读取超时')
    proxy = state.ACTIVE_PROXY or {}
    host = str(proxy.get('ip') or '127.0.0.1') if proxy.get('enabled') else parsed.hostname
    connect_port = int(proxy.get('port') or 7890) if proxy.get('enabled') else port
    cls = _TlsConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    kwargs = {'target_hostname': parsed.hostname, 'deadline': deadline} if cls is _TlsConnection else {}
    connection = cls(host, connect_port, timeout=timeout, **kwargs)
    if proxy.get('enabled'):
        connection.set_tunnel(ip, port)
    else:
        # Keep original Host/SNI, but never resolve that hostname again on connect.
        connection._create_connection = lambda address, timeout, source_address=None: socket.create_connection((ip, port), timeout, source_address)
    path = parsed.path or '/'
    if parsed.query:
        path += '?' + parsed.query
    try:
        connection.request('GET', path, headers={'Host': parsed.netloc, 'Accept': 'image/png,image/jpeg,image/webp,image/gif', 'User-Agent': 'CainFlow-ImageReader', 'Connection': 'close'})
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('图片读取超时')
        if connection.sock:
            connection.sock.settimeout(remaining)
        return connection, connection.getresponse()
    except Exception:
        connection.close()
        raise


def validate_image_bytes(data):
    """Validate raster containers and dimensions; browser decoding gates import."""
    mime, width, height = '', 0, 0
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        offset, found_data, ended = 8, False, False
        while offset + 12 <= len(data):
            length = int.from_bytes(data[offset:offset + 4], 'big')
            kind = data[offset + 4:offset + 8]
            end = offset + 8 + length
            if end + 4 > len(data) or zlib.crc32(data[offset + 4:end]) != int.from_bytes(data[end:end + 4], 'big'):
                raise ValueError('PNG 内容损坏')
            if offset == 8:
                if kind != b'IHDR' or length != 13:
                    raise ValueError('PNG 图片头无效')
                width, height = struct.unpack('>II', data[offset + 8:offset + 16])
            found_data |= kind == b'IDAT'
            offset = end + 4
            if kind == b'IEND':
                ended = length == 0 and offset == len(data)
                break
        if not ended or not found_data:
            raise ValueError('PNG 内容不完整')
        mime = 'image/png'
    elif data.startswith(b'\xff\xd8') and data.endswith(b'\xff\xd9'):
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 255:
                break
            while offset < len(data) and data[offset] == 255:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            length = int.from_bytes(data[offset:offset + 2], 'big')
            if length < 2 or offset + length > len(data):
                raise ValueError('JPEG 内容损坏')
            if marker in (0xC0, 0xC1, 0xC2) and length >= 8:
                height, width = struct.unpack('>HH', data[offset + 3:offset + 7])
                break
            offset += length
        mime = 'image/jpeg'
    elif data[:6] in (b'GIF87a', b'GIF89a') and len(data) >= 14 and data.endswith(b';'):
        width, height = struct.unpack('<HH', data[6:10])
        mime = 'image/gif'
    elif len(data) >= 30 and data[:4] == b'RIFF' and data[8:12] == b'WEBP' and int.from_bytes(data[4:8], 'little') + 8 == len(data):
        if data[12:16] == b'VP8X':
            width = int.from_bytes(data[24:27], 'little') + 1
            height = int.from_bytes(data[27:30], 'little') + 1
        elif data[12:16] == b'VP8 ' and data[23:26] == b'\x9d\x01\x2a':
            width, height = (value & 0x3FFF for value in struct.unpack('<HH', data[26:30]))
        elif data[12:16] == b'VP8L' and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], 'little')
            width, height = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        mime = 'image/webp'
    if not mime or width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError('图片格式无效或尺寸过大，仅支持 PNG、JPEG、GIF、WebP')
    return mime


def read_search_image(url, *, open_image=open_public_image):
    deadline = time.monotonic() + TIMEOUT_SECONDS
    for redirect in range(4):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('图片读取超时')
        connection, response = open_image(url, remaining)
        try:
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location or redirect == 3:
                    raise ValueError('图片重定向过多或无效')
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f'图片下载失败（HTTP {response.status}）')
            content_type = (response.getheader('Content-Type') or '').split(';')[0].strip().lower()
            if content_type not in ('image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/octet-stream', ''):
                raise ValueError('远程返回的不是支持的图片')
            length = response.getheader('Content-Length')
            if length and int(length) > MAX_IMAGE_BYTES:
                raise ValueError('图片超过 20 MiB 限制')
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('图片读取超时')
                if connection.sock:
                    connection.sock.settimeout(remaining)
                chunk = response.read1(min(65536, MAX_IMAGE_BYTES + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise ValueError('图片超过 20 MiB 限制')
                chunks.append(chunk)
            data = b''.join(chunks)
            return data, validate_image_bytes(data)
        finally:
            response.close()
            connection.close()
    raise ValueError('图片重定向无效')
