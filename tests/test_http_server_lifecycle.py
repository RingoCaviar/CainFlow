import http.client
import threading
import unittest

from backend.main import create_server


class HttpServerLifecycleTests(unittest.TestCase):
    def test_public_server_closes_while_a_static_keepalive_client_is_idle(self):
        server = create_server(host='127.0.0.1', port=0)
        serving = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        serving.start()
        client = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=2)
        closed = threading.Event()

        def close_server():
            server.shutdown()
            server.server_close()
            closed.set()

        closer = threading.Thread(target=close_server, daemon=True)
        try:
            client.request('GET', '/favicon.ico')
            response = client.getresponse()
            self.assertEqual(response.version, 11)
            self.assertEqual(response.status, 404)
            self.assertEqual(response.read(), b'')
            self.assertIsNotNone(client.sock, 'the client deliberately keeps the static connection open')
            closer.start()
            self.assertTrue(closed.wait(0.5), 'closing the server must not wait for idle keep-alive clients')
        finally:
            client.close()
            if not closer.ident:
                closer.start()
            closer.join(timeout=2)
            serving.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
