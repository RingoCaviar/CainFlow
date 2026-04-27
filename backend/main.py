import os
import socket
import socketserver
import sys
import webbrowser

from backend import config
from backend.handler import ProxyHTTPRequestHandler
from backend.services.security_service import load_allowed_hosts

socket.setdefaulttimeout(300)
socketserver.TCPServer.allow_reuse_address = True


def print_port_error_and_exit():
    print('\n' + '=' * 50)
    print(f' ERROR: 端口 {config.PORT} 已被占用')
    print('=' * 50)
    print(f' 提示: CainFlow 无法在端口 {config.PORT} 上启动。')
    print(' 可能原因:')
    print(' 1. 您已经运行了一个 CainFlow 实例。')
    print(' 2. 另一个程序正在使用该端口。')
    print('\n 解决方法:')
    print(' 请关闭占用该端口的程序，或重启电脑后再试。')
    print('=' * 50 + '\n')
    sys.exit(1)


def print_banner():
    cyan = '\033[1;36m'
    white = '\033[1;37m'
    gray = '\033[90m'
    reset = '\033[0m'
    banner = rf"""{cyan}
  ____      _      ___   _   _   _____   _        ___  __        __
 / ___|    / \    |_ _| | \ | | |  ___| | |      / _ \ \ \      / /
| |       / _ \    | |  |  \| | | |_    | |     | | | | \ \ /\ / / 
| |___   / ___ \   | |  | |\  | |  _|   | |___  | |_| |  \ V  V /  
 \____| /_/   \_\ |___| |_| \_| |_|     |_____|  \___/    \_/\_/   
{reset}"""
    print(banner)
    print(f' {white}> CainFlow v2.7.5 已就绪{reset}')
    print(f' {white}> 正在监听: {cyan}http://127.0.0.1:{config.PORT}{reset}')
    print(f'\n {gray}[提示] 如果浏览器未自动启动，请按住 {white}Ctrl{gray} 并点击上方链接即可。{reset}\n')


def run():
    os.chdir(config.STATIC_ROOT)
    config.ensure_runtime_dirs()
    load_allowed_hosts()
    if config.is_port_in_use(config.PORT):
        print_port_error_and_exit()

    try:
        with socketserver.ThreadingTCPServer(('127.0.0.1', config.PORT), ProxyHTTPRequestHandler) as httpd:
            print_banner()
            webbrowser.open(f'http://127.0.0.1:{config.PORT}')
            httpd.serve_forever()
    except Exception as exc:
        print(f'\n[ERROR] 无法启动服务器: {exc}')
        sys.exit(1)


"""负责启动 CainFlow 本地 HTTP 服务并初始化运行环境。"""
