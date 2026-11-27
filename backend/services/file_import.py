import base64
import codecs
import mimetypes
import os
import sqlite3
import stat
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from backend import config


if os.name == 'nt':
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    _create_file = _kernel.CreateFileW
    _create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                             wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _create_file.restype = wintypes.HANDLE
    _close_handle = _kernel.CloseHandle
    _close_handle.argtypes = [wintypes.HANDLE]
    _invalid_handle = wintypes.HANDLE(-1).value
    _generic_read = 0x80000000
    _share_read_write_delete = 7
    _open_existing = 3
    _normal_file = 0x80


def _open_original_bytes(path):
    if os.name != 'nt':
        return path.open('rb')
    # The Windows CRT drops the sharing-violation code from its Python exception.
    handle = _create_file(str(path), _generic_read, _share_read_write_delete, None, _open_existing, _normal_file, None)
    if handle == _invalid_handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except OSError:
        _close_handle(handle)
        raise
    try:
        return os.fdopen(fd, 'rb')
    except OSError:
        os.close(fd)
        raise


MAX_TEXT_BYTES = 4 * 1024 * 1024
TEXT_EXTENSIONS = {'.md', '.markdown', '.txt'}
IMAGE_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
}
VIDEO_MIME = {'.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
              '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo'}
MAX_IMAGE_BYTES = 24 * 1024 * 1024
WINDOWS_EXECUTABLE_EXTENSIONS = {
    '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
    '.ws', '.wsf', '.wsh', '.msi', '.msp', '.msix', '.appinstaller', '.scr', '.pif', '.cpl',
    '.msc', '.hta', '.reg', '.lnk', '.url', '.appref-ms',
}


def file_import_version(info):
    return f'{info.st_dev:x}-{info.st_ino:x}-{info.st_size:x}-{info.st_mtime_ns:x}-{info.st_ctime_ns:x}'


class FileImportError(ValueError):
    def __init__(self, message, code='unavailable'):
        super().__init__(message)
        self.code = code


class FileImports:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.database = self.directory / 'file-imports.db'

    def _connect(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database)
        connection.execute('''CREATE TABLE IF NOT EXISTS file_imports (
            id TEXT PRIMARY KEY, workflow TEXT NOT NULL, node TEXT NOT NULL, path TEXT NOT NULL
        )''')
        return connection

    def register(self, workflow, node, path):
        if not all(isinstance(value, str) and 0 < len(value) <= 200 for value in (workflow, node)):
            raise FileImportError('无法确定文件所关联的工作流或节点。')
        try:
            path = Path(path).absolute()
            if path.resolve() != path:
                raise FileImportError('请拖入原文件本身。')
        except (OSError, ValueError) as error:
            raise FileImportError('找不到原文件或无法访问。') from error
        if not path.is_file():
            raise FileImportError('请选择可读取的普通文件。')
        try:
            with _open_original_bytes(path) as source:
                info = self._info(path, os.fstat(source.fileno()))
        except OSError as error:
            raise FileImportError('无法读取所选文件。') from error
        reference = uuid.uuid4().hex
        with closing(self._connect()) as connection, connection:
            connection.execute('INSERT INTO file_imports VALUES (?, ?, ?, ?)', (reference, workflow, node, str(path)))
        return {'id': reference, **info}

    @staticmethod
    def _info(path, info):
        suffix = path.suffix.lower()
        kind = ('text' if suffix in TEXT_EXTENSIONS else 'image' if suffix in IMAGE_MIME
                else 'video' if suffix in VIDEO_MIME else 'file')
        mime = IMAGE_MIME.get(suffix) or VIDEO_MIME.get(suffix) or (
            'text/plain' if kind == 'text' else mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        )
        return {
            'name': path.name, 'kind': kind, 'mime': mime, 'size': info.st_size,
            'version': file_import_version(info),
        }

    def _path(self, workflow, node, reference):
        if not self.database.is_file():
            raise FileImportError('找不到文件关联。')
        with closing(self._connect()) as connection:
            row = connection.execute(
                'SELECT path FROM file_imports WHERE id = ? AND workflow = ? AND node = ?',
                (reference, workflow, node),
            ).fetchone()
        if row is None:
            raise FileImportError('找不到文件关联。')
        path = Path(row[0])
        try:
            if path.resolve() != path or not stat.S_ISREG(path.stat().st_mode):
                raise FileImportError('原文件位置需要重新确认。')
        except FileNotFoundError as error:
            raise FileImportError('找不到原文件。', 'missing') from error
        except PermissionError as error:
            raise FileImportError(
                '原文件正在被占用。' if getattr(error, 'winerror', None) in (32, 33) else '没有权限读取原文件。',
                'busy' if getattr(error, 'winerror', None) in (32, 33) else 'denied',
            ) from error
        except OSError as error:
            raise FileImportError('无法访问原文件。') from error
        return path

    @contextmanager
    def open_content(self, workflow, node, reference, version=None):
        path = self._path(workflow, node, reference)
        try:
            with _open_original_bytes(path) as source:
                snapshot = os.fstat(source.fileno())
                if not stat.S_ISREG(snapshot.st_mode) or path.resolve() != path:
                    raise FileImportError('原文件位置需要重新确认。')
                info = self._info(path, snapshot)
                if version and version != info['version']:
                    raise FileImportError('原文件已变更，请重新运行。', 'changed')
                yield source, info
        except FileNotFoundError as error:
            raise FileImportError('找不到原文件。', 'missing') from error
        except PermissionError as error:
            busy = getattr(error, 'winerror', None) in (32, 33)
            raise FileImportError('原文件正在被占用。' if busy else '没有权限读取原文件。', 'busy' if busy else 'denied') from error
        except OSError as error:
            raise FileImportError('无法读取原文件。') from error

    def info(self, workflow, node, reference):
        with self.open_content(workflow, node, reference) as (_, info):
            return info

    def read_value(self, workflow, node, reference, kind, version=None):
        with self.open_content(workflow, node, reference, version) as (source, info):
            if kind != info['kind']:
                raise FileImportError('原文件类型与输出端口不兼容。', 'type_conflict')
            if kind in ('file', 'video'):
                return info
            limit = MAX_TEXT_BYTES if kind == 'text' else MAX_IMAGE_BYTES
            if info['size'] > limit:
                raise FileImportError(f'原文件超过 {limit // (1024 * 1024)} MiB 的读取上限。')
            value = source.read(limit + 1)
            if (len(value) > limit or file_import_version(os.fstat(source.fileno())) != info['version']
                    or self.info(workflow, node, reference)['version'] != info['version']):
                raise FileImportError('原文件在读取期间发生变化，请重跑。', 'changed')
        if kind == 'image':
            return f"data:{info['mime']};base64,{base64.b64encode(value).decode('ascii')}"
        encoding = 'utf-16' if value.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else 'utf-8-sig'
        try:
            return value.decode(encoding)
        except UnicodeError as error:
            raise FileImportError('无法读取文本编码，请使用 UTF-8 或带 BOM 的 UTF-16。') from error

    def read_text(self, workflow, node, reference):
        return self.read_value(workflow, node, reference, 'text')

    def open_original(self, workflow, node, reference):
        path = self._path(workflow, node, reference)
        if path.suffix.lower() in WINDOWS_EXECUTABLE_EXTENSIONS:
            raise FileImportError('此格式会由系统执行，请在资源管理器中处理。', 'executable')
        try:
            os.startfile(path)
        except OSError as error:
            raise FileImportError('系统无法打开原文件。') from error
        return True


def file_imports():
    return FileImports(Path(config.DATA_DIR) / '.file-imports')
