import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from urllib.parse import quote

from backend import config


SCHEMA_VERSION = 1
HISTORY_MAX_ENTRIES = 1000
HISTORY_RETENTION_DAYS = 365
DOCUMENT_NAMES = {
    'session', 'ui_bootstrap', 'prompt_library', 'logs_state',
    'request_statistics', 'update_state', 'network_detection',
    'notice_state', 'export_settings'
}


class StorageError(Exception):
    pass


class StorageService:
    def __init__(self, database_path=None, assets_dir=None, temp_dir=None, exports_dir=None):
        self.database_path = database_path or config.DATABASE_PATH
        self.assets_dir = assets_dir or config.ASSETS_DIR
        self.temp_dir = temp_dir or config.DATA_TEMP_DIR
        self.exports_dir = exports_dir or config.EXPORTS_DIR
        self._lock = threading.RLock()
        self._initialized = False

    def initialize(self):
        with self._lock:
            if self._initialized:
                return
            for path in (os.path.dirname(self.database_path), self.assets_dir, self.temp_dir, self.exports_dir):
                os.makedirs(path, exist_ok=True)
            try:
                self._create_schema()
            except sqlite3.DatabaseError:
                self._quarantine_corrupt_database()
                self._create_schema()
            self._initialized = True

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=15)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('PRAGMA synchronous=NORMAL')
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _create_schema(self):
        with self._connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    name TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    asset_key TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    relative_path TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets(sha256);
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY,
                    timestamp INTEGER NOT NULL,
                    media_type TEXT NOT NULL,
                    asset_key TEXT NOT NULL,
                    thumb_asset_key TEXT,
                    metadata_json TEXT NOT NULL,
                    FOREIGN KEY(asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE,
                    FOREIGN KEY(thumb_asset_key) REFERENCES assets(asset_key) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
            ''')
            db.execute(
                'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                ('schema_version', str(SCHEMA_VERSION)),
            )

    def _quarantine_corrupt_database(self):
        if not os.path.exists(self.database_path):
            return
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        destination = f'{self.database_path}.corrupt-{stamp}'
        os.replace(self.database_path, destination)
        for suffix in ('-wal', '-shm'):
            source = self.database_path + suffix
            if os.path.exists(source):
                os.replace(source, destination + suffix)

    def _ensure_document_name(self, name):
        if name not in DOCUMENT_NAMES:
            raise StorageError('Unknown storage document')

    def get_document(self, name, default=None):
        self.initialize()
        self._ensure_document_name(name)
        with self._connect() as db:
            row = db.execute('SELECT value_json, updated_at FROM documents WHERE name=?', (name,)).fetchone()
        if not row:
            return {'value': default, 'updatedAt': 0}
        return {'value': json.loads(row['value_json']), 'updatedAt': row['updated_at']}

    def put_document(self, name, value):
        self.initialize()
        self._ensure_document_name(name)
        serialized = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        updated_at = int(time.time() * 1000)
        with self._lock, self._connect() as db:
            db.execute('''
                INSERT INTO documents(name, value_json, updated_at) VALUES(?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
            ''', (name, serialized, updated_at))
        return updated_at

    def get_meta(self, key, default=''):
        self.initialize()
        with self._connect() as db:
            row = db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return row['value'] if row else default

    def set_meta(self, key, value):
        self.initialize()
        with self._lock, self._connect() as db:
            db.execute(
                'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, str(value)),
            )

    def has_user_data(self):
        self.initialize()
        with self._connect() as db:
            document_count = db.execute('SELECT COUNT(*) FROM documents').fetchone()[0]
            history_count = db.execute('SELECT COUNT(*) FROM history').fetchone()[0]
            asset_count = db.execute('SELECT COUNT(*) FROM assets').fetchone()[0]
        return document_count + history_count + asset_count > 0

    def backup_database(self, label='backup'):
        self.initialize()
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        destination = f'{self.database_path}.{label}-{stamp}'
        target = sqlite3.connect(destination)
        try:
            with self._lock, self._connect() as source:
                source.backup(target)
                target.commit()
        finally:
            target.close()
        return destination

    def _asset_relative_path(self, digest, mime_type):
        extension = mimetypes.guess_extension(mime_type or '') or '.bin'
        extension = '.jpg' if extension == '.jpe' else extension
        return os.path.join(digest[:2], f'{digest}{extension}').replace(os.sep, '/')

    def put_asset(self, asset_key, body, mime_type='application/octet-stream', kind='asset'):
        self.initialize()
        asset_key = str(asset_key or '').strip()
        if not asset_key or len(asset_key) > 300:
            raise StorageError('Invalid asset key')
        if not isinstance(body, (bytes, bytearray)) or not body:
            raise StorageError('Asset body is empty')
        body = bytes(body)
        digest = hashlib.sha256(body).hexdigest()
        relative_path = self._asset_relative_path(digest, mime_type)
        destination = os.path.join(self.assets_dir, *relative_path.split('/'))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        if not os.path.exists(destination):
            fd, temporary_path = tempfile.mkstemp(prefix='asset-', dir=self.temp_dir)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(body)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary_path, destination)
            finally:
                if os.path.exists(temporary_path):
                    os.remove(temporary_path)
        now = int(time.time() * 1000)
        with self._lock, self._connect() as db:
            db.execute('''
                INSERT INTO assets(asset_key, sha256, kind, mime_type, size_bytes, relative_path, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_key) DO UPDATE SET
                    sha256=excluded.sha256, kind=excluded.kind, mime_type=excluded.mime_type,
                    size_bytes=excluded.size_bytes, relative_path=excluded.relative_path
            ''', (asset_key, digest, kind, mime_type or 'application/octet-stream', len(body), relative_path, now))
        return self.get_asset_info(asset_key)

    def get_asset_info(self, asset_key):
        self.initialize()
        with self._connect() as db:
            row = db.execute('SELECT * FROM assets WHERE asset_key=?', (str(asset_key),)).fetchone()
        return dict(row) if row else None

    def get_asset(self, asset_key):
        info = self.get_asset_info(asset_key)
        if not info:
            return None
        path = os.path.join(self.assets_dir, *info['relative_path'].split('/'))
        try:
            with open(path, 'rb') as file:
                return info, file.read()
        except OSError:
            return None

    def delete_asset(self, asset_key):
        self.initialize()
        with self._lock, self._connect() as db:
            row = db.execute('SELECT relative_path FROM assets WHERE asset_key=?', (str(asset_key),)).fetchone()
            if not row:
                return False
            try:
                db.execute('DELETE FROM assets WHERE asset_key=?', (str(asset_key),))
            except sqlite3.IntegrityError:
                return False
            remaining = db.execute('SELECT COUNT(*) FROM assets WHERE relative_path=?', (row['relative_path'],)).fetchone()[0]
        if remaining == 0:
            try:
                os.remove(os.path.join(self.assets_dir, *row['relative_path'].split('/')))
            except OSError:
                pass
        return True

    def save_history(self, entry):
        self.initialize()
        history_id = int(entry.get('id') or int(time.time() * 1000) * 1000)
        timestamp = int(entry.get('timestamp') or time.time() * 1000)
        media_type = 'video' if entry.get('mediaType') == 'video' else 'image'
        asset_key = str(entry.get('videoAssetKey') or entry.get('imageAssetKey') or f'history:{history_id}')
        thumb_asset_key = str(entry.get('thumbAssetKey') or '') or None
        if not self.get_asset_info(asset_key):
            raise StorageError('History media asset does not exist')
        metadata = dict(entry)
        metadata.update({'id': history_id, 'timestamp': timestamp, 'mediaType': media_type})
        metadata.pop('image', None)
        metadata.pop('video', None)
        metadata.pop('videoBlob', None)
        metadata.pop('thumb', None)
        with self._lock, self._connect() as db:
            db.execute('''
                INSERT INTO history(id, timestamp, media_type, asset_key, thumb_asset_key, metadata_json)
                VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp, media_type=excluded.media_type,
                    asset_key=excluded.asset_key, thumb_asset_key=excluded.thumb_asset_key,
                    metadata_json=excluded.metadata_json
            ''', (history_id, timestamp, media_type, asset_key, thumb_asset_key,
                  json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))))
        self.trim_history()
        return history_id

    def _history_row_to_dict(self, row):
        item = json.loads(row['metadata_json'])
        item.update({
            'id': row['id'], 'timestamp': row['timestamp'], 'mediaType': row['media_type'],
            'imageAssetKey': row['asset_key'] if row['media_type'] == 'image' else '',
            'videoAssetKey': row['asset_key'] if row['media_type'] == 'video' else '',
            'thumbAssetKey': row['thumb_asset_key'] or '',
        })
        if row['thumb_asset_key']:
            item['thumb'] = f"/api/storage/assets/{quote(row['thumb_asset_key'], safe='')}"
        return item

    def list_history(self, limit=0):
        self.initialize()
        sql = 'SELECT * FROM history ORDER BY timestamp DESC'
        params = ()
        if limit > 0:
            sql += ' LIMIT ?'
            params = (int(limit),)
        with self._connect() as db:
            rows = db.execute(sql, params).fetchall()
        return [self._history_row_to_dict(row) for row in rows]

    def get_history(self, history_id):
        self.initialize()
        with self._connect() as db:
            row = db.execute('SELECT * FROM history WHERE id=?', (int(history_id),)).fetchone()
        return self._history_row_to_dict(row) if row else None

    def delete_history(self, history_id):
        entry = self.get_history(history_id)
        if not entry:
            return False
        keys = [entry.get('imageAssetKey'), entry.get('videoAssetKey'), entry.get('thumbAssetKey')]
        with self._lock, self._connect() as db:
            db.execute('DELETE FROM history WHERE id=?', (int(history_id),))
        for key in filter(None, keys):
            self.delete_asset(key)
        return True

    def clear_history(self):
        for entry in self.list_history():
            self.delete_history(entry['id'])
        return True

    def trim_history(self, max_entries=HISTORY_MAX_ENTRIES, retention_days=HISTORY_RETENTION_DAYS):
        cutoff = int((datetime.now() - timedelta(days=max(1, retention_days))).timestamp() * 1000)
        entries = self.list_history()
        for index, entry in enumerate(entries):
            if index >= max_entries or int(entry.get('timestamp') or 0) < cutoff:
                self.delete_history(entry['id'])

    def cleanup_orphan_files(self):
        self.initialize()
        with self._connect() as db:
            referenced = {row[0] for row in db.execute('SELECT DISTINCT relative_path FROM assets')}
        deleted = 0
        for root, _, filenames in os.walk(self.assets_dir):
            for filename in filenames:
                path = os.path.join(root, filename)
                relative = os.path.relpath(path, self.assets_dir).replace(os.sep, '/')
                if relative not in referenced:
                    try:
                        os.remove(path)
                        deleted += 1
                    except OSError:
                        pass
        return deleted

    def cleanup_assets(self, mode, keep_keys=None):
        self.initialize()
        keep_keys = {str(key) for key in (keep_keys or []) if str(key)}
        with self._connect() as db:
            history_keys = {
                value for row in db.execute('SELECT asset_key, thumb_asset_key FROM history')
                for value in row if value
            }
            rows = db.execute('SELECT asset_key, kind FROM assets').fetchall()
        delete_keys = []
        for row in rows:
            key, kind = row['asset_key'], row['kind']
            if mode == 'all':
                delete_keys.append(key)
            elif mode == 'image-import' and (kind == 'image-import' or key.startswith('image-import:')):
                delete_keys.append(key)
            elif mode == 'image-import-orphans' and (kind == 'image-import' or key.startswith('image-import:')) and key not in keep_keys:
                delete_keys.append(key)
            elif mode == 'nodes' and key not in history_keys and kind not in {'image-import', 'thumbnail'}:
                delete_keys.append(key)
            elif mode == 'node-orphans' and key not in history_keys and kind not in {'image-import', 'thumbnail'} and key not in keep_keys:
                delete_keys.append(key)
            elif mode == 'orphans' and key.startswith('history:') and key not in history_keys:
                delete_keys.append(key)
            elif mode == 'orphans' and kind == 'thumbnail' and key not in history_keys:
                delete_keys.append(key)
        deleted = sum(1 for key in delete_keys if self.delete_asset(key))
        return {'assetsDeleted': deleted, 'orphanFilesDeleted': self.cleanup_orphan_files()}

    def clear_temporary(self):
        deleted = 0
        stale_before = time.time() - 5 * 60
        for name in os.listdir(self.temp_dir):
            path = os.path.join(self.temp_dir, name)
            try:
                if os.path.getmtime(path) > stale_before:
                    continue
                if os.path.isdir(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
                deleted += 1
            except OSError:
                pass
        return {'temporaryDeleted': deleted, 'orphanAssetsDeleted': self.cleanup_orphan_files()}

    def factory_reset(self):
        self.initialize()
        with self._lock, self._connect() as db:
            db.execute('DELETE FROM history')
            db.execute('DELETE FROM assets')
            db.execute('DELETE FROM documents')
            db.execute("DELETE FROM meta WHERE key != 'schema_version'")
        if os.path.isdir(self.assets_dir):
            shutil.rmtree(self.assets_dir)
        os.makedirs(self.assets_dir, exist_ok=True)
        self.clear_temporary()

    def get_stats(self):
        self.initialize()
        with self._connect() as db:
            documents = db.execute('SELECT COUNT(*) FROM documents').fetchone()[0]
            assets, asset_bytes = db.execute('SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM assets').fetchone()
            history = db.execute('SELECT COUNT(*) FROM history').fetchone()[0]
            document_bytes = db.execute('SELECT COALESCE(SUM(LENGTH(value_json)), 0) FROM documents').fetchone()[0]
            history_bytes = db.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind IN ('history', 'thumbnail')").fetchone()[0]
            import_bytes = db.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind='image-import'").fetchone()[0]
        return {
            'documents': documents, 'documentBytes': document_bytes,
            'assets': assets, 'assetBytes': asset_bytes, 'history': history,
            'historyBytes': history_bytes, 'imageImportBytes': import_bytes,
            'nodeAssetBytes': max(0, asset_bytes - history_bytes - import_bytes),
            'totalBytes': asset_bytes + document_bytes,
        }

    def get_export_directory(self):
        configured = self.get_document('export_settings', {}).get('value') or {}
        return configured.get('directory') or self.exports_dir

    def set_export_directory(self, path):
        path = str(path or '').strip()
        resolved = self.exports_dir if not path else os.path.abspath(path)
        if path and not os.path.isabs(path):
            raise StorageError('Export directory must be an absolute path')
        os.makedirs(resolved, exist_ok=True)
        probe = os.path.join(resolved, '.cainflow-write-test')
        try:
            with open(probe, 'wb') as file:
                file.write(b'ok')
            os.remove(probe)
        except OSError as error:
            raise StorageError(f'Export directory is not writable: {error}') from error
        self.put_document('export_settings', {'directory': resolved})
        return resolved

    def export_media(self, filename, body):
        directory = self.get_export_directory()
        if not os.path.isdir(directory) or not os.access(directory, os.W_OK):
            raise StorageError('Configured export directory is unavailable or not writable')
        safe_name = os.path.basename(str(filename or 'CainFlow-media.bin')).strip() or 'CainFlow-media.bin'
        base, extension = os.path.splitext(safe_name)
        candidate = os.path.join(directory, safe_name)
        index = 1
        while os.path.exists(candidate):
            candidate = os.path.join(directory, f'{base}-{index}{extension}')
            index += 1
        with open(candidate, 'wb') as file:
            file.write(body)
        return candidate


storage_service = StorageService()
