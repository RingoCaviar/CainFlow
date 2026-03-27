import http.server
import socketserver
import urllib.request
import urllib.error
import ssl
import socket
import sys
import webbrowser

PORT = 8767

def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except socket.error:
            return True
        return False

if is_port_in_use(PORT):
    print("\n" + "="*50)
    print(f" ERROR: 端口 {PORT} 已被占用！")
    print("="*50)
    print(f" 提示: CainFlow 无法在端口 {PORT} 上启动。")
    print(" 可能原因:")
    print(" 1. 您已经运行了一个 CainFlow 实例。")
    print(" 2. 另一个程序正在使用该端口。")
    print("\n 解决方法:")
    print(" 请关闭占用该端口的程序，或重启您的电脑，然后再次启动。")
    print("="*50 + "\n")
    sys.exit(1)

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

try:
    with socketserver.TCPServer(("127.0.0.1", PORT), ProxyHTTPRequestHandler) as httpd:
        print(f"CainFlow Server with Native CORS Proxy running at http://127.0.0.1:{PORT}")
        # Only open browser if server bound successfully
        webbrowser.open(f"http://127.0.0.1:{PORT}")
        httpd.serve_forever()
except Exception as e:
    print(f"\n[ERROR] 无法启动服务器: {e}")
    sys.exit(1)
