"""Directory-backed history. Originals are independent of the disposable media cache."""
import base64
import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import stat
import tempfile
import time
import uuid
from contextlib import contextmanager

from backend.services.storage_service import StorageError


IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'}
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'}
MIME_EXTENSIONS = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
                   'image/bmp': '.bmp', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm',
                   'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/x-msvideo': '.avi'}


class MediaLibrary:
    def __init__(self, storage):
        self.storage = storage
        self.database = storage.database_path + '.library'

    @contextmanager
    def _db(self):
        self.storage.initialize()
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute('CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, root TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER, mtime INTEGER, digest TEXT, status TEXT NOT NULL, UNIQUE(root,path))')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _root(self):
        return os.path.normcase(os.path.realpath(self.storage.get_export_directory()))

    @staticmethod
    def _linked(path):
        info = os.lstat(path)
        return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)

    def _path(self, row):
        root = row['root']
        path = os.path.abspath(os.path.join(root, row['path']))
        if os.path.commonpath([root, path]) != root or path == root:
            raise ValueError('文件路径超出保存目录')
        current = path
        while current != root:
            if self._linked(current):
                raise ValueError('不读取或删除目录链接中的文件')
            current = os.path.dirname(current)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        return path

    def save(self, entry, body):
        self.storage.assert_storage_writable()
        if not body:
            raise ValueError('媒体内容为空，未保存')
        mime = str(entry.get('mimeType') or '').split(';')[0].lower()
        extension = MIME_EXTENSIONS.get(mime)
        if not extension:
            raise ValueError('不支持的媒体文件格式')
        identifier = int(entry.get('id') or int(time.time() * 1000000))
        digest = hashlib.sha256(body).hexdigest()
        metadata = {key: value for key, value in entry.items() if key not in {'image', 'video', 'videoBlob', 'thumb', 'fileUrl', 'directory', 'relativePath'}}
        metadata.update(id=identifier, timestamp=entry.get('timestamp') or int(time.time() * 1000), mediaType='video' if mime.startswith('video/') else 'image')
        with self.storage._lock:
            root = self._root()
            os.makedirs(root, exist_ok=True)
            with self._db() as db:
                row = db.execute('SELECT * FROM files WHERE id=?', (identifier,)).fetchone()
                if row:
                    if row['digest'] != digest or row['status'] == 'deleted':
                        raise ValueError('保存请求已失效，请重试')
                    if row['status'] == 'ready':
                        path = self._path(row)
                        with open(path, 'rb') as file:
                            if hashlib.sha256(file.read()).hexdigest() != digest:
                                raise ValueError('已保存文件发生变化')
                        return self._item(row)
                    root = row['root']
                    filename = row['path']
                else:
                    prefix = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(entry.get('prompt') or '')).strip(' .')[:60] if entry.get('usePromptFilename') else ''
                    filename = f'{prefix or "CainFlow"}-{identifier}{extension}'
                    while os.path.lexists(os.path.join(root, filename)):
                        filename = f'CainFlow-{identifier}-{uuid.uuid4().hex[:8]}{extension}'
                    db.execute('INSERT INTO files(id,root,path,metadata,mime,digest,status) VALUES(?,?,?,?,?,?,?)',
                               (identifier, root, filename, json.dumps(metadata, ensure_ascii=False), mime, digest, 'pending'))
            destination = os.path.join(root, filename)
            if os.path.lexists(destination):
                self._path({'root': root, 'path': filename})
                with open(destination, 'rb') as file:
                    if hashlib.sha256(file.read()).hexdigest() != digest:
                        raise ValueError('迁移目标已被其他文件占用，原文件保留')
            else:
                descriptor, temporary = tempfile.mkstemp(prefix='.cainflow-', suffix='.part', dir=root)
                try:
                    with os.fdopen(descriptor, 'wb') as file:
                        file.write(body)
                        file.flush()
                        os.fsync(file.fileno())
                    with open(temporary, 'rb') as file:
                        if hashlib.sha256(file.read()).hexdigest() != digest:
                            raise OSError('写入校验失败')
                    # Same-directory hard link publishes atomically and never overwrites an existing file.
                    if os.name == 'nt':
                        # Windows rename is atomic, refuses existing destinations and works on FAT/exFAT.
                        os.rename(temporary, destination)
                    else:
                        os.link(temporary, destination)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
            info = os.stat(destination)
            with self._db() as db:
                db.execute("UPDATE files SET status='ready',size=?,mtime=? WHERE id=?", (info.st_size, info.st_mtime_ns, identifier))
                row = db.execute('SELECT * FROM files WHERE id=?', (identifier,)).fetchone()
            return self._item(row)

    def migrate_legacy(self):
        failures = []
        with self._db() as db:
            completed = {row['id'] for row in db.execute("SELECT id FROM files WHERE status != 'pending'")}
        for entry in self.storage.list_history():
            if entry['id'] in completed:
                continue
            try:
                asset = self.storage.get_asset(entry.get('videoAssetKey') or entry.get('imageAssetKey'))
                if not asset:
                    raise FileNotFoundError('旧历史原文件缺失')
                info, body = asset
                self.save({**entry, 'mimeType': info['mime_type']}, body)
            except (OSError, ValueError, StorageError) as error:
                failures.append({'id': entry['id'], 'message': str(error)})
        return failures

    def _item(self, row):
        metadata = json.loads(row['metadata'])
        media_type = 'video' if row['mime'].startswith('video/') else 'image'
        url = f"/api/storage/library/{row['id']}/file"
        metadata.update(fileVersion=f"{row['size']}:{row['mtime']}", id=row['id'], mediaType=media_type, fileUrl=url, directory=row['root'], relativePath=row['path'],
                        timestamp=metadata.get('timestamp') or row['mtime'] // 1000000,
                        videoMimeType=row['mime'] if media_type == 'video' else '', videoSizeBytes=row['size'] if media_type == 'video' else 0)
        # Directory originals are authoritative; cached media identities never replace them.
        metadata['thumb'] = metadata.get('thumb', '')
        metadata['hasImage'] = media_type == 'image'
        metadata['hasVideo'] = media_type == 'video'
        metadata['imageAssetKey'] = ''
        metadata['videoAssetKey'] = ''
        metadata['videoUrl'] = url if media_type == 'video' else ''
        metadata['thumbAssetKey'] = ''
        return metadata

    def list(self, limit=0):
        return self.list_page(limit)['items']

    def _scan_files(self, root):
        # DirEntry reuses filesystem metadata, including on Windows, without
        # separate lstat/stat calls for every entry. Never follow reparse points.
        pending = [root]
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(entry.path)
                    elif stat.S_ISREG(info.st_mode) and os.path.splitext(entry.name)[1].lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
                        yield os.path.relpath(entry.path, root), info

    def list_page(self, limit=0):
        root = self._root()
        if not os.path.isdir(root):
            raise FileNotFoundError('保存目录不存在或暂时不可访问')
        with self.storage._lock, self._db() as db:
            known = {row['path']: row for row in db.execute(
                "SELECT id,path,status,size,mtime,json_extract(metadata,'$.timestamp') AS timestamp FROM files WHERE root=?", (root,))}
            inserts, updates, tombstones, visible = [], [], [], []
            for relative, info in self._scan_files(root):
                row = known.get(relative)
                if row and row['status'] == 'pending':
                    continue
                if not row or row['status'] == 'deleted':
                    identifier = -int(uuid.uuid4().hex[:13], 16)
                    extension = os.path.splitext(relative)[1].lower()
                    mime = mimetypes.guess_type(relative)[0] or ('video/mp4' if extension in VIDEO_EXTENSIONS else 'image/png')
                    if row:
                        tombstones.append((relative + '.deleted-' + str(row['id']), row['id']))
                    inserts.append((identifier, root, relative, '{}', mime, info.st_size, info.st_mtime_ns))
                    timestamp = info.st_mtime_ns // 1000000
                else:
                    identifier = row['id']
                    changed = row['size'] != info.st_size or row['mtime'] != info.st_mtime_ns
                    if changed:
                        updates.append(('{}', info.st_size, info.st_mtime_ns, identifier))
                    timestamp = (row['timestamp'] if not changed else None) or info.st_mtime_ns // 1000000
                visible.append((timestamp, identifier))
            db.executemany('UPDATE files SET path=? WHERE id=?', tombstones)
            db.executemany("INSERT INTO files(id,root,path,metadata,mime,size,mtime,status) VALUES(?,?,?,?,?,?,?,'ready')", inserts)
            db.executemany('UPDATE files SET metadata=?,size=?,mtime=?,digest=NULL WHERE id=?', updates)
            visible.sort(reverse=True)
            selected = visible[:limit] if limit > 0 else visible
            ids = [identifier for _, identifier in selected]
            rows = {}
            for offset in range(0, len(ids), 500):
                batch = ids[offset:offset + 500]
                rows.update((row['id'], row) for row in db.execute(
                    'SELECT * FROM files WHERE id IN (' + ','.join('?' for _ in batch) + ')', batch))
            return {'items': [self._item(rows[identifier]) for identifier in ids], 'count': len(visible)}

    def _current_row(self, identifier):
        with self._db() as db:
            row = db.execute("SELECT * FROM files WHERE id=? AND status='ready'", (int(identifier),)).fetchone()
        if not row or row['root'] != self._root():
            return None
        try:
            self._path(row)
        except FileNotFoundError:
            return None
        return row

    def get(self, identifier):
        with self.storage._lock:
            row = self._current_row(identifier)
            return self._item(row) if row else None

    def read(self, identifier):
        with self.storage._lock:
            row = self._current_row(identifier)
            if not row:
                return None
            with open(self._path(row), 'rb') as file:
                return row['mime'], file.read()

    def update_thumbnail(self, identifier, thumb, version=None):
        if not isinstance(thumb, str) or len(thumb) > 700000 or not thumb.startswith(('data:image/webp;base64,', 'data:image/jpeg;base64,', 'data:image/png;base64,')):
            raise ValueError('缩略图格式无效')
        body = base64.b64decode(thumb.split(',', 1)[1], validate=True)
        with self.storage._lock:
            row = self._current_row(identifier)
            if not row:
                raise ValueError('文件不存在，请刷新历史')
            info = os.stat(self._path(row))
            if version != f"{row['size']}:{row['mtime']}" or (info.st_size, info.st_mtime_ns) != (row['size'], row['mtime']):
                raise ValueError('文件已变化，请刷新历史')
            metadata = json.loads(row['metadata'])
            metadata.update(thumb=thumb, thumbSizeBytes=len(body))
            with self._db() as db:
                db.execute('UPDATE files SET metadata=? WHERE id=?', (json.dumps(metadata, ensure_ascii=False), int(identifier)))

    def delete(self, identifier, version=None):
        with self.storage._lock:
            row = self._current_row(identifier)
            if not row:
                return False
            path = self._path(row)
            info = os.stat(path)
            if version != f"{row['size']}:{row['mtime']}" or (info.st_size, info.st_mtime_ns) != (row['size'], row['mtime']):
                raise ValueError('文件已变化，请刷新历史后重新确认删除')
            os.unlink(path)
            with self._db() as db:
                db.execute("UPDATE files SET status='deleted' WHERE id=?", (int(identifier),))
            # Only release the history cache owner. Other workflow/undo owners remain valid.
            self.storage.delete_history(identifier)
            return True
