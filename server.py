import http.server
import socketserver
import urllib.request
import urllib.error
import time
import ssl
import socket
import select
import threading
import sys
import os
import json
import webbrowser
import ipaddress
from urllib.parse import urlparse, unquote

PORT = 8767
WORKFLOWS_DIR = 'workflows'

# Proxy state
ACTIVE_PROXY = {
    "enabled": False,
    "ip": "127.0.0.1",
    "port": "7890"
}

def check_proxy_health(ip, port):
    proxy_url = f"http://{ip}:{port}"
    proxy_handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    opener = urllib.request.build_opener(proxy_handler, urllib.request.HTTPSHandler(context=ctx))
    try:
        start_time = time.perf_counter()
        req = urllib.request.Request("https://www.google.com", method="HEAD")
        opener.open(req, timeout=5.0)
        end_time = time.perf_counter()
        latency = int((end_time - start_time) * 1000)
        return True, latency
    except urllib.error.HTTPError as e:
        return True, "HTTP Error"
    except Exception as e:
        return False, str(e)

if not os.path.exists(WORKFLOWS_DIR):
    os.makedirs(WORKFLOWS_DIR)

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

def is_safe_url(url):
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False
        host = parsed.hostname
        if not host:
            return False

        # Attempt to resolve the host to confirm it's not pointing to local/private network
        try:
            # socket.getaddrinfo returns a list of 5-tuples. We need the IP from the sockaddr (index 4, element 0).
            addr_info = socket.getaddrinfo(host, None)
            for res in addr_info:
                ip_str = res[4][0]
                # Filter out IPv6 addresses if they contain '%' (interface index), which ipaddress doesn't like
                ip_str = ip_str.split('%')[0]
                ip = ipaddress.ip_address(ip_str)
                if ip.is_private or ip.is_loopback:
                    return False
        except (socket.gaierror, ValueError):
            # If DNS fails, it might be a literal IP. Let's try parsing it directly.
            try:
                ip = ipaddress.ip_address(host)
                if ip.is_private or ip.is_loopback:
                    return False
            except ValueError:
                # If it's not a valid IP and DNS failed, we'll consider it unsafe/invalid
                return False
        
        return True
    except Exception:
        return False

def get_safe_path(name):
    # Strip any path info to prevent traversal
    safe_name = os.path.basename(name)
    if not safe_name or safe_name in ('.', '..'):
        return None
    filepath = os.path.join(WORKFLOWS_DIR, f"{safe_name}.json")
    # Verify the absolute path is still within WORKFLOWS_DIR
    abs_root = os.path.abspath(WORKFLOWS_DIR)
    abs_file = os.path.abspath(filepath)
    if not abs_file.startswith(abs_root):
        return None
    return filepath

class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence common noise requests to keep the log clean
        path = str(args[0]) if len(args) > 0 else ""
        noise_patterns = [
            '/favicon.ico', 'layui', 'laydate', 'layer.css', 'code.css', 
            'main.js', 'app.js', 'utils.js', 'api.js', 'workflow.js', 'nodes.js', 'theme/default'
        ]
        if any(pattern in path for pattern in noise_patterns):
            return
        super().log_message(format, *args)

    def do_GET(self):
        if self.path == '/api/workflows':
            try:
                files = [f[:-5] for f in os.listdir(WORKFLOWS_DIR) if f.endswith('.json')]
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(files).encode())
                return
            except Exception as e:
                self.send_error(500, str(e))
                return
        
        if self.path == '/api/proxy':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(ACTIVE_PROXY).encode())
            return
        
        if self.path.startswith('/api/workflows/'):
            name = unquote(self.path[len('/api/workflows/'):])
            filepath = get_safe_path(name)
            if filepath and os.path.exists(filepath):
                try:
                    with open(filepath, 'rb') as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(content)
                    return
                except Exception as e:
                    self.send_error(500, str(e))
                    return
            else:
                self.send_error(404, "Workflow not found")
                return

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
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.end_headers()

    def do_POST(self):
        global ACTIVE_PROXY
        
        if self.path == '/api/test_proxy':
            try:
                length = int(self.headers.get('content-length', 0))
                body = self.rfile.read(length)
                proxy_cfg = json.loads(body)
                success, result = check_proxy_health(proxy_cfg.get("ip", "127.0.0.1"), proxy_cfg.get("port", "7890"))
                if success:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    latency = result if isinstance(result, int) else 0
                    self.wfile.write(json.dumps({"success": True, "latency": latency}).encode())
                else:
                    self.send_error(500, f"Cannot connect via proxy: {result}")
            except Exception as e:
                self.send_error(500, str(e))
            return

        if self.path == '/api/proxy':
            try:
                length = int(self.headers.get('content-length', 0))
                body = self.rfile.read(length)
                new_state = json.loads(body)
                if "enabled" in new_state: ACTIVE_PROXY["enabled"] = new_state["enabled"]
                if "ip" in new_state: ACTIVE_PROXY["ip"] = str(new_state["ip"])
                if "port" in new_state: ACTIVE_PROXY["port"] = str(new_state["port"])
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")
            except Exception as e:
                self.send_error(500, str(e))
            return
        if self.path == '/proxy':
            target_url = self.headers.get('x-target-url')
            target_method = self.headers.get('x-target-method', 'POST')
            if not target_url:
                self.send_error(400, "Missing x-target-url header")
                return
            
            if not is_safe_url(target_url):
                self.send_error(403, "Forbidden: Target URL is not allowed")
                return

            length = int(self.headers.get('content-length', 0))
            body = self.rfile.read(length) if length > 0 else None

            req_headers = {}
            for k, v in self.headers.items():
                k_lower = k.lower()
                if k_lower not in ['host', 'x-target-url', 'x-target-method', 'content-length', 'connection', 'origin', 'referer', 'accept-encoding']:
                    req_headers[k] = v
            
            # Ensure a default User-Agent if not provided
            if 'user-agent' not in [k.lower() for k in req_headers.keys()]:
                req_headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CainFlow/2.5.0'

            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            try:
                # Use provided method
                req = urllib.request.Request(target_url, data=body, headers=req_headers, method=target_method)
                
                # Apply Proxy if enabled (Check x-proxy headers first, then global state)
                header_proxy_enabled = self.headers.get('x-proxy-enabled')
                if header_proxy_enabled is not None:
                    proxy_enabled = header_proxy_enabled.lower() == 'true'
                    proxy_host = self.headers.get('x-proxy-host', ACTIVE_PROXY.get("ip"))
                    proxy_port = self.headers.get('x-proxy-port', ACTIVE_PROXY.get("port"))
                else:
                    proxy_enabled = ACTIVE_PROXY.get("enabled")
                    proxy_host = ACTIVE_PROXY.get("ip")
                    proxy_port = ACTIVE_PROXY.get("port")

                opener = None
                if proxy_enabled:
                    proxy_url = f"http://{proxy_host}:{proxy_port}"
                    proxy_handler = urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url})
                    opener = urllib.request.build_opener(proxy_handler, urllib.request.HTTPSHandler(context=ctx))
                
                # 保底机制：在单独线程执行请求，主线程监控客户端连接是否还在
                api_response = {"status": None, "headers": None, "body": None, "error": None, "handle": None}
                def perform_request():
                    try:
                        if opener:
                            resp = opener.open(req)
                        else:
                            resp = urllib.request.urlopen(req, context=ctx)
                        api_response["handle"] = resp
                        api_response["status"] = resp.status
                        api_response["headers"] = resp.getheaders()
                        api_response["body"] = resp.read()
                    except urllib.error.HTTPError as e:
                        api_response["status"] = e.code
                        api_response["headers"] = e.headers.items()
                        api_response["body"] = e.read()
                    except Exception as e:
                        api_response["error"] = e

                thread = threading.Thread(target=perform_request)
                thread.daemon = True
                thread.start()

                while thread.is_alive():
                    # 轮询探测客户端 (浏览器) 是否还连着
                    r, _, _ = select.select([self.request], [], [], 0.5)
                    if r:
                        try:
                            peek = self.request.recv(1, socket.MSG_PEEK)
                            if not peek:
                                print(f"检测到客户端断开，终止代理请求: {target_url}")
                                if api_response["handle"]:
                                    api_response["handle"].close()
                                return 
                        except ConnectionResetError:
                            print(f"检测到客户端连接重置，停止请求")
                            if api_response["handle"]:
                                api_response["handle"].close()
                            return
                        except Exception:
                            pass
                    thread.join(0.1)

                if api_response["error"]:
                    raise api_response["error"]

                # 写回响应
                self.send_response(api_response["status"])
                for k, v in api_response["headers"]:
                    kl = k.lower()
                    if kl not in [
                        'transfer-encoding', 'connection', 'access-control-allow-origin',
                        'content-disposition', 'content-security-policy', 'x-content-type-options'
                    ]:
                        self.send_header(k, v)
                self.end_headers()
                if api_response["body"]:
                    self.wfile.write(api_response["body"])

            except urllib.error.URLError as e:
                # 连接错误
                self.send_error(504, f"API Connection Error: {str(e)}")
            except Exception as e:
                self.send_error(500, str(e))

        
        elif self.path.startswith('/api/workflows/'):
            name = unquote(self.path[len('/api/workflows/'):])
            
            rename_to = self.headers.get('x-rename-to')
            if rename_to:
                rename_to = unquote(rename_to)
                old_path = get_safe_path(name)
                new_path = get_safe_path(rename_to)
                try:
                    if old_path and new_path and os.path.exists(old_path):
                        os.rename(old_path, new_path)
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b"OK")
                    else:
                        self.send_error(404, "Original workflow not found")
                except Exception as e:
                    self.send_error(500, str(e))
                return

            length = int(self.headers.get('content-length', 0))
            body = self.rfile.read(length) if length > 0 else None
            filepath = get_safe_path(name)
            if not filepath:
                self.send_error(400, "Invalid workflow name")
                return
            try:
                with open(filepath, 'wb') as f:
                    f.write(body)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404, "Not Found")

    def do_DELETE(self):
        if self.path.startswith('/api/workflows/'):
            name = unquote(self.path[len('/api/workflows/'):])
            filepath = get_safe_path(name)
            try:
                if filepath and os.path.exists(filepath):
                    os.remove(filepath)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"Deleted")
                else:
                    self.send_error(404, "Workflow not found")
            except Exception as e:
                self.send_error(500, str(e))
        else:
            self.send_error(404, "Not Found")

socketserver.TCPServer.allow_reuse_address = True

try:
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), ProxyHTTPRequestHandler) as httpd:
        # ASCII Banner & Modern Terminal UI
        CYAN = "\033[1;36m"
        WHITE = "\033[1;37m"
        GRAY = "\033[90m"
        RESET = "\033[0m"

        banner = rf"""{CYAN}
  ____      _      ___   _   _   _____   _        ___  __        __
 / ___|    / \    |_ _| | \ | | |  ___| | |      / _ \ \ \      / /
| |       / _ \    | |  |  \| | | |_    | |     | | | | \ \ /\ / / 
| |___   / ___ \   | |  | |\  | |  _|   | |___  | |_| |  \ V  V /  
 \____| /_/   \_\ |___| |_| \_| |_|     |_____|  \___/    \_/\_/   
{RESET}"""
        print(banner)
        print(f" {WHITE}> CainFlow v2.6.0 已就绪{RESET}")
        print(f" {WHITE}> 正在监听: {CYAN}http://127.0.0.1:{PORT}{RESET}")
        print(f"\n {GRAY}[提示] 如果浏览器未自动启动，请按住 {WHITE}Ctrl{GRAY} 并点击上方链接即可。{RESET}\n")
        
        webbrowser.open(f"http://127.0.0.1:{PORT}")
        httpd.serve_forever()
except Exception as e:
    print(f"\n[ERROR] 无法启动服务器: {e}")
    sys.exit(1)

