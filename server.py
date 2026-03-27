import http.server
import socketserver
import urllib.request
import urllib.error
import ssl

PORT = 8767

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence common noise requests to keep the log clean
        path = args[0] if len(args) > 0 else ""
        noise_patterns = [
            '/favicon.ico', 'layui', 'laydate', 'layer.css', 'code.css', 
            'main.js', 'app.js', 'utils.js', 'api.js', 'workflow.js', 'nodes.js', 'theme/default'
        ]
        if any(pattern in path for pattern in noise_patterns):
            return
        super().log_message(format, *args)

    def do_GET(self):
        # Silence ghost requests from extensions/probes before they hit the base file-fetching logic
        noise_patterns = [
            '/favicon.ico', 'layui', 'laydate', 'layer.css', 'code.css', 
            'main.js', 'app.js', 'utils.js', 'api.js', 'workflow.js', 'nodes.js', 'theme/default'
        ]
        if any(pattern in self.path for pattern in noise_patterns):
            self.send_response(404)
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.end_headers()

    def do_POST(self):
        if self.path == '/proxy':
            target_url = self.headers.get('x-target-url')
            if not target_url:
                self.send_error(400, "Missing x-target-url header")
                return

            length = int(self.headers.get('content-length', 0))
            body = self.rfile.read(length) if length > 0 else None

            req_headers = {}
            for k, v in self.headers.items():
                k_lower = k.lower()
                if k_lower not in ['host', 'x-target-url', 'content-length', 'connection', 'origin', 'referer', 'accept-encoding']:
                    req_headers[k] = v

            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            try:
                req = urllib.request.Request(target_url, data=body, headers=req_headers, method='POST')
                with urllib.request.urlopen(req, context=ctx) as response:
                    resp_body = response.read()
                    self.send_response(response.status)
                    for k, v in response.getheaders():
                        if k.lower() not in ['transfer-encoding', 'connection', 'access-control-allow-origin']:
                            self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(resp_body)
            except urllib.error.HTTPError as e:
                resp_body = e.read()
                self.send_response(e.code)
                for k, v in e.headers.items():
                    if k.lower() not in ['transfer-encoding', 'connection', 'access-control-allow-origin']:
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404, "Not Found")

# Allow port reuse to prevent address already in use error
socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("127.0.0.1", PORT), ProxyHTTPRequestHandler) as httpd:
    print(f"CainFlow Server with Native CORS Proxy running at http://127.0.0.1:{PORT}")
    httpd.serve_forever()
