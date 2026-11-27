import codecs
import os
import sqlite3
import stat
import uuid
from contextlib import closing
from pathlib import Path

from backend import config


MAX_TEXT_BYTES = 4 * 1024 * 1024
TEXT_EXTENSIONS = {'.md', '.markdown', '.txt'}


class FileImportError(ValueError):
    pass


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
        if path.suffix.lower() not in TEXT_EXTENSIONS or not path.is_file():
            raise FileImportError('请选择 Markdown 或 TXT 文件。')
        reference = uuid.uuid4().hex
        with closing(self._connect()) as connection, connection:
            connection.execute('INSERT INTO file_imports VALUES (?, ?, ?, ?)', (reference, workflow, node, str(path)))
        return {'id': reference, 'name': path.name}

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
            raise FileImportError('找不到原文件。') from error
        except OSError as error:
            raise FileImportError('无法访问原文件。') from error
        return path

    def read_text(self, workflow, node, reference):
        path = self._path(workflow, node, reference)
        try:
            with path.open('rb') as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise FileImportError('原文件位置需要重新确认。')
                if before.st_size > MAX_TEXT_BYTES:
                    raise FileImportError('文本文件超过 4 MiB。')
                value = source.read(MAX_TEXT_BYTES + 1)
                after = path.stat()
                if path.resolve() != path:
                    raise FileImportError('原文件位置需要重新确认。')
            if len(value) > MAX_TEXT_BYTES:
                raise FileImportError('文本文件超过 4 MiB。')
            if not os.path.samestat(before, after) or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise FileImportError('原文件在读取期间发生变化，请重试。')
            encoding = 'utf-16' if value.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)) else 'utf-8-sig'
            return value.decode(encoding)
        except UnicodeError as error:
            raise FileImportError('无法读取文本编码，请使用 UTF-8 或带 BOM 的 UTF-16。') from error
        except FileNotFoundError as error:
            raise FileImportError('找不到原文件。') from error
        except OSError as error:
            raise FileImportError('无法读取原文件。') from error

    def open_original(self, workflow, node, reference):
        path = self._path(workflow, node, reference)
        try:
            os.startfile(path)
        except OSError as error:
            raise FileImportError('系统无法打开原文件。') from error
        return True


def file_imports():
    return FileImports(Path(config.DATA_DIR) / '.file-imports')
