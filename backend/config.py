import os
import socket
import sys
from datetime import datetime

HOST = '0.0.0.0'
LOCAL_HOST = '127.0.0.1'
PORT = 8767
PROXY_STREAM_CHUNK_SIZE = 64 * 1024
LOG_FILE_PREFIX = 'backend'
LOG_BODY_PREVIEW_BYTES = 4096
LOG_TEXT_PREVIEW_LIMIT = 2000
LOG_STACK_PREVIEW_LIMIT = 4000
LOG_BINARY_SNIFF_BYTES = 256


def get_resource_path():
    if hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    return os.path.abspath('.')


def get_exe_dir():
    if hasattr(sys, 'frozen'):
        return os.path.dirname(sys.executable)
    return os.path.abspath('.')


STATIC_ROOT = get_resource_path()
EXE_DIR = get_exe_dir()
WORKFLOWS_DIR = os.path.join(EXE_DIR, 'workflows')
LOG_DIR = os.path.join(EXE_DIR, 'log')
ALLOWED_HOSTS_FILE = os.path.join(EXE_DIR, 'allowed_hosts.json')


def ensure_runtime_dirs():
    os.makedirs(WORKFLOWS_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)


def get_log_file_path(now=None):
    timestamp = now or datetime.now()
    return os.path.join(LOG_DIR, f'{LOG_FILE_PREFIX}-{timestamp:%Y-%m-%d}.jsonl')


def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((HOST, port))
        except socket.error:
            return True
        return False


"""Central backend runtime configuration for CainFlow."""
