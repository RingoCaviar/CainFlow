import io
import json
import socket
import struct
import unittest
import zlib
from unittest.mock import patch, MagicMock

from backend.services import search_image_service as service
from backend.routes import media_routes


def png(width=1, height=1):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b'')


def upstream(data, status=200, **headers):
    response = MagicMock(status=status)
    response.getheader.side_effect = lambda key: headers.get(key)
    response.read1.side_effect = io.BytesIO(data).read1
    connection = MagicMock()
    return connection, response


class SearchImageTests(unittest.TestCase):
    def test_public_address_validation_and_credentials(self):
        for url in ('file:///x', 'http://u:p@example.com/x', 'http://@example.com/x', 'http://example.com/\nheader', 'https://'):
            with self.assertRaises(ValueError):
                service.resolve_public_url(url)
        for ips in [('127.0.0.1',), ('10.0.0.1',), ('169.254.169.254',), ('::1',), ('fc00::1',), ('ff02::1',), ('224.0.0.1',), ('::ffff:127.0.0.1',), ('93.184.216.34', '192.168.0.1')]:
            addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443)) for ip in ips]
            with patch.object(service.socket, 'getaddrinfo', return_value=addresses), self.assertRaisesRegex(ValueError, '不允许'):
                service.resolve_public_url('https://image.test/a.png')
        with patch.object(service.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            parsed, port, ip = service.resolve_public_url('https://image.test/a.png')
            self.assertEqual((parsed.hostname, port, ip), ('image.test', 443, '93.184.216.34'))

    def test_validated_ip_is_pinned_to_connection_without_ambient_credentials(self):
        with patch.object(service, 'resolve_public_url', return_value=(service.urlsplit('https://image.test/a.png'), 443, '93.184.216.34')), \
             patch.dict(service.state.ACTIVE_PROXY, {'enabled': False}), \
             patch.object(service._TlsConnection, 'request') as request, \
             patch.object(service._TlsConnection, 'getresponse', return_value='response'), \
             patch.object(service.socket, 'create_connection') as connect:
            connection, _ = service.open_public_image('https://image.test/a.png', 10)
            connection._create_connection(('image.test', 443), 10)
            self.assertEqual(connect.call_args.args[0], ('93.184.216.34', 443))
            headers = request.call_args.kwargs['headers']
            self.assertEqual(headers['Host'], 'image.test')
            self.assertNotIn('Authorization', headers)
            self.assertNotIn('Cookie', headers)
            self.assertEqual(connection.target_hostname, 'image.test')

    def test_redirects_are_revalidated_and_bounded(self):
        first = upstream(b'', status=302, Location='http://127.0.0.1/private')
        calls = []
        def open_image(url, timeout):
            calls.append(url)
            if len(calls) == 1:
                return first
            service.resolve_public_url(url)
        with self.assertRaises(ValueError):
            service.read_search_image('https://public.test/image', open_image=open_image)
        self.assertEqual(calls, ['https://public.test/image', 'http://127.0.0.1/private'])
        first[0].close.assert_called()
        count = 0
        def loop(url, timeout):
            nonlocal count
            count += 1
            return upstream(b'', status=301, Location='/same')
        with self.assertRaisesRegex(ValueError, '重定向'):
            service.read_search_image('https://public.test/image', open_image=loop)
        self.assertEqual(count, 4)

    def test_proxy_tunnels_only_to_validated_ip_and_never_adds_credentials(self):
        with patch.object(service, 'resolve_public_url', return_value=(service.urlsplit('http://image.test/p.png'), 80, '93.184.216.34')), \
             patch.dict(service.state.ACTIVE_PROXY, {'enabled': True, 'ip': '127.0.0.1', 'port': 7890, 'apikey': 'must-not-forward'}), \
             patch.object(service.http.client.HTTPConnection, 'request') as request, \
             patch.object(service.http.client.HTTPConnection, 'getresponse', return_value='response'):
            connection, _ = service.open_public_image('http://image.test/p.png', 10)
            self.assertEqual((connection.host, connection.port), ('127.0.0.1', 7890))
            self.assertEqual((connection._tunnel_host, connection._tunnel_port), ('93.184.216.34', 80))
            self.assertNotIn('Authorization', request.call_args.kwargs['headers'])
            self.assertNotIn('Authorization', connection._tunnel_headers)
            self.assertNotIn('Proxy-Authorization', connection._tunnel_headers)
            self.assertNotIn('Cookie', connection._tunnel_headers)

    def test_png_body_validation_size_type_and_pixel_limits(self):
        self.assertEqual(service.validate_image_bytes(png()), 'image/png')
        for data in (b'<html>not an image</html>', png()[:-5], png(100000, 100000), png()[:25] + b'BROKEN' + png()[31:]):
            with self.assertRaises(ValueError):
                service.validate_image_bytes(data)
        cases = [
            upstream(png(), **{'Content-Length': str(service.MAX_IMAGE_BYTES + 1)}),
            upstream(png(), **{'Content-Type': 'text/html'}),
            upstream(b'fake png', **{'Content-Type': 'image/png'}),
            upstream(png(), status=404)
        ]
        for connection, response in cases:
            with self.assertRaises(ValueError):
                service.read_search_image('https://image.test/a', open_image=lambda *args: (connection, response))
            response.close.assert_called()
        connection, response = upstream(png(), **{'Content-Type': 'image/png'})
        self.assertEqual(service.read_search_image('https://image.test/a', open_image=lambda *args: (connection, response)), (png(), 'image/png'))

    def test_stream_limit_applies_without_content_length_and_deadline_is_checked(self):
        with patch.object(service, 'MAX_IMAGE_BYTES', 32), self.assertRaisesRegex(ValueError, '20 MiB'):
            service.read_search_image('https://image.test/a', open_image=lambda *args: upstream(png()))
        with patch.object(service.time, 'monotonic', side_effect=[0, 21]), self.assertRaises(TimeoutError):
            service.read_search_image('https://image.test/a', open_image=lambda *args: self.fail('expired'))

    def test_route_returns_only_validated_image_bytes_and_safe_errors(self):
        handler = MagicMock(path='/api/media/search-image', headers={'content-length': '0'})
        with patch.object(media_routes, 'read_json_body', return_value={'url': 'https://image.test/a'}), \
             patch.object(media_routes, 'read_search_image', return_value=(png(), 'image/png')), \
             patch.object(media_routes, 'write_bytes') as write:
            self.assertTrue(media_routes.handle_post(handler))
            self.assertEqual(write.call_args.kwargs['content_type'], 'image/png')
            self.assertEqual(write.call_args.kwargs['headers']['X-Content-Type-Options'], 'nosniff')
        with patch.object(media_routes, 'read_json_body', return_value={'url': 'http://127.0.0.1/'}), \
             patch.object(media_routes, 'read_search_image', side_effect=ValueError('blocked')), \
             patch.object(media_routes, 'write_error') as write:
            media_routes.handle_post(handler)
            self.assertEqual(write.call_args.args[1:3], (422, 'blocked'))


if __name__ == '__main__':
    unittest.main()
