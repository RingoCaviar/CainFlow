import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
from functools import lru_cache

from backend import config


MAX_FRAME_BYTES = 96 * 1024 * 1024
COMMAND_TIMEOUT = 12
RUN_TIMEOUT = 30 * 60


class CanvasWorkerError(Exception):
    def __init__(self, message, code='runtime_failed'):
        super().__init__(message)
        self.code = code


@lru_cache(maxsize=8)
def _node_version(executable):
    try:
        result = subprocess.run(
            [executable, '--version'], stdin=subprocess.DEVNULL, capture_output=True,
            timeout=2, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return int(result.stdout.decode('ascii').strip().removeprefix('v').split('.')[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def resolve_node():
    configured = os.environ.get('CAINFLOW_NODE_PATH')
    if configured and not Path(configured).is_absolute():
        return None
    executable = configured or shutil.which('node')
    if executable and _node_version(executable) >= 22:
        return executable
    return None


class CanvasWorker:
    def __init__(self):
        self._process = None
        self._write_lock = threading.Lock()
        self._stop = None
        self._closed = threading.Event()

    def _send(self, message):
        data = json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(',', ':')).encode('ascii')
        if len(data) > MAX_FRAME_BYTES:
            raise CanvasWorkerError('工作流运行数据超过本地运行时的大小限制。', 'result_too_large')
        self._process.stdin.write(data + b'\n')
        self._process.stdin.flush()

    def stop(self, node_ids=None):
        with self._write_lock:
            if self._closed.is_set():
                return False
            if self._stop and self._stop.get('stop'):
                return False
            if node_ids:
                previous = (self._stop or {}).get('stopNodes', [])
                self._stop = {'stopNodes': list(dict.fromkeys([*previous, *node_ids]))}
            else:
                self._stop = {'stop': True}
            if self._process is not None:
                try:
                    self._send({'stopNodes': node_ids} if node_ids else self._stop)
                except OSError:
                    return False
            return True

    def _reply(self, callbacks, frame):
        if self._closed.is_set():
            return
        number = frame['id']
        try:
            result = callbacks[frame['method']](frame['args'])
            reply = {'id': number, 'result': result}
        except Exception as error:
            reply = {
                'id': number, 'errorCode': getattr(error, 'code', None) or 'runtime_io_failed',
                'error': str(error) if isinstance(error, CanvasWorkerError) else '工作流运行时无法读取或保存所需数据。',
            }
        with self._write_lock:
            if not self._closed.is_set():
                try:
                    self._send(reply)
                except (OSError, CanvasWorkerError):
                    self._closed.set()

    def execute(self, command, callbacks):
        executable = resolve_node()
        if not executable:
            raise CanvasWorkerError('Canvas MCP 需要 Node.js 22 或更新版本，请检查本地服务的运行配置。', 'runtime_unavailable')
        script = Path(config.STATIC_ROOT) / 'js/features/canvas-mcp/saved-canvas-worker.mjs'
        child_env = {key: value for key, value in os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH', 'CAINFLOW_MCP_TOKEN'}}
        frames = queue.Queue()
        timeout = RUN_TIMEOUT if command['method'] == 'execute' else COMMAND_TIMEOUT
        deadline = time.monotonic() + timeout
        try:
            with self._write_lock:
                self._process = subprocess.Popen(
                    [executable, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, env=child_env, cwd=script.parent,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                threading.Thread(target=self._read_frames, args=(frames,), daemon=True).start()
                self._send(command)
                if self._stop:
                    self._send(self._stop)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self._closed.is_set():
                    raise CanvasWorkerError('本地工作流运行时没有完成请求。', 'runtime_timeout')
                try:
                    frame = frames.get(timeout=min(1, remaining))
                except queue.Empty:
                    continue
                if frame is None:
                    raise CanvasWorkerError('本地工作流运行时已退出。')
                if 'response' in frame:
                    return frame['response']
                if 'error' in frame:
                    raise CanvasWorkerError(frame['error'], frame.get('errorCode', 'runtime_failed'))
                if frame.get('method') == 'requestProvider':
                    threading.Thread(target=self._reply, args=(callbacks, frame), daemon=True).start()
                else:
                    self._reply(callbacks, frame)
        except (OSError, ValueError, TypeError, KeyError) as error:
            raise CanvasWorkerError('无法连接本地工作流运行时。') from error
        finally:
            self._closed.set()
            if self._process is not None:
                with self._write_lock:
                    if self._process.poll() is None:
                        self._process.terminate()
                    try:
                        self._process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self._process.kill()
                        self._process.wait()
                    self._process.stdin.close()
                    self._process.stdout.close()

    def _read_frames(self, frames):
        try:
            with self._process.stdout as stream:
                while not self._closed.is_set():
                    line = stream.readline(MAX_FRAME_BYTES + 1)
                    if not line or len(line) > MAX_FRAME_BYTES:
                        break
                    frames.put(json.loads(line))
        except (OSError, ValueError):
            pass
        finally:
            frames.put(None)
