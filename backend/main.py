import os
import csv
import socket
import socketserver
import subprocess
import sys
import webbrowser

from backend import config
from backend.handler import ProxyHTTPRequestHandler
from backend.services.security_service import load_allowed_hosts
from backend.services.update_service import cleanup_update_temp_files

socket.setdefaulttimeout(300)
socketserver.TCPServer.allow_reuse_address = True


def run_command(command):
    try:
        return subprocess.check_output(
            command,
            text=True,
            errors='replace',
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return ''


def address_has_port(address, port):
    return str(address).rsplit(':', 1)[-1] == str(port)


def get_process_name(pid):
    if os.name != 'nt' or not pid:
        return ''
    output = run_command(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'])
    rows = list(csv.reader(output.splitlines()))
    if rows and rows[0]:
        return rows[0][0]
    return ''


def get_process_command_line(pid):
    if os.name != 'nt' or not pid:
        return ''
    command = (
        f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' "
        "-ErrorAction SilentlyContinue; "
        "if ($p -and $p.CommandLine) { $p.CommandLine }"
    )
    return run_command([
        'powershell',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command,
    ]).strip()


def get_port_owner(port):
    if os.name != 'nt':
        return None

    output = run_command(['netstat', '-ano', '-p', 'tcp'])
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto, local_address, state, pid = parts[0], parts[1], parts[-2], parts[-1]
        if not proto.upper().startswith('TCP'):
            continue
        if state.upper() != 'LISTENING' or not address_has_port(local_address, port):
            continue
        return {
            'pid': pid,
            'name': get_process_name(pid) or 'Unknown',
            'command_line': get_process_command_line(pid),
        }

    return None


def is_cainflow_process(owner):
    if not owner:
        return False

    name = (owner.get('name') or '').lower()
    command_line = os.path.normcase(owner.get('command_line') or '').lower()
    app_dir = os.path.normcase(config.EXE_DIR).lower()
    static_root = os.path.normcase(config.STATIC_ROOT).lower()

    if name in {'cainflow.exe', 'cainflow_launcher.exe'} or name.startswith('cainflow'):
        return True
    if 'cainflow.exe' in command_line or 'cainflow_launcher.exe' in command_line:
        return True
    if 'server.py' in command_line and any(path and path in command_line for path in (app_dir, static_root)):
        return True
    if 'server.py' in command_line and 'cainflow' in command_line:
        return True

    return False


def shorten_text(value, limit=220):
    value = str(value or '')
    if len(value) <= limit:
        return value
    return value[:limit - 3] + '...'


def wait_for_manual_close():
    if os.environ.get('CAINFLOW_SKIP_FATAL_PAUSE') == '1':
        return
    if os.environ.get('CAINFLOW_LAUNCHED_FROM_BAT') == '1':
        return
    if not sys.stdin or not sys.stdin.isatty():
        return

    try:
        input(' 请手动关闭此窗口，或按 Enter 退出。')
    except (EOFError, KeyboardInterrupt):
        pass


def print_port_error_and_exit():
    owner = get_port_owner(config.PORT)
    already_running = is_cainflow_process(owner)

    print('\n' + '=' * 50)
    if already_running:
        print(' 启动冲突：CainFlow 已在运行')
    else:
        print(f' 启动冲突：端口 {config.PORT} 已被占用')
    print('=' * 50)

    if already_running:
        print(f' 已检测到 CainFlow 正在监听 http://{config.LOCAL_HOST}:{config.PORT}')
        print(' 请不要重复启动；如需重启，请先关闭已运行的 CainFlow 窗口或进程。')
    else:
        print(f' CainFlow 需要使用端口 {config.PORT}，但该端口当前不可用。')
        print(' 可能原因: 其他程序占用了该端口，或系统保留/权限限制导致无法绑定。')

    if owner:
        print('\n 占用进程:')
        print(f" - PID: {owner.get('pid') or 'Unknown'}")
        print(f" - 名称: {owner.get('name') or 'Unknown'}")
        if owner.get('command_line'):
            print(f" - 命令行: {shorten_text(owner.get('command_line'))}")
    else:
        print('\n 占用进程: 未能识别。')

    print('\n 解决方法:')
    if already_running:
        print(' 直接使用已打开的 CainFlow，或关闭旧实例后再重新启动。')
    else:
        print(' 请关闭占用该端口的程序，释放端口后再重新启动 CainFlow。')
    print('=' * 50 + '\n')
    wait_for_manual_close()
    sys.exit(1)


def print_startup_error_and_exit(exc):
    print('\n' + '=' * 50)
    print(' 启动失败：服务未能启动')
    print('=' * 50)
    print(f' 原因类型: {exc.__class__.__name__}')
    print(f' 详细信息: {exc}')
    print('\n 解决方法:')
    print(' 请根据上方错误信息处理后再重新启动 CainFlow。')
    print('=' * 50 + '\n')
    wait_for_manual_close()
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
    print(f' {white}> CainFlow v2.8.2 已就绪{reset}')
    print(f' {white}> 正在监听: {cyan}http://{config.HOST}:{config.PORT}{reset}')
    print(f' {white}> 本机访问: {cyan}http://{config.LOCAL_HOST}:{config.PORT}{reset}')
    print(f'\n {gray}[提示] 如果浏览器未自动启动，请按住 {white}Ctrl{gray} 并点击上方链接即可。{reset}\n')


def run():
    os.chdir(config.STATIC_ROOT)
    config.ensure_runtime_dirs()
    cleanup_update_temp_files()
    load_allowed_hosts()
    if config.is_port_in_use(config.PORT):
        print_port_error_and_exit()

    try:
        with socketserver.ThreadingTCPServer((config.HOST, config.PORT), ProxyHTTPRequestHandler) as httpd:
            print_banner()
            webbrowser.open(f'http://{config.LOCAL_HOST}:{config.PORT}')
            httpd.serve_forever()
    except Exception as exc:
        print_startup_error_and_exit(exc)


"""负责启动 CainFlow 本地 HTTP 服务并初始化运行环境。"""
