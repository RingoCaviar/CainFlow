import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from urllib.parse import quote

from backend import config


SCHEMA_VERSION = 3
STORAGE_MODE_VERSION = 1
INTEGRITY_REPORT_VERSION = 1
MAX_SAFETY_STATE_BYTES = 64 * 1024
FAST_CHECK_BUDGET_SECONDS = 1.0
SAFETY_STATES = {'healthy', 'scan_required', 'scanning', 'gc_suspended', 'repair_required'}
HISTORY_MAX_ENTRIES = 1000
HISTORY_RETENTION_DAYS = 365
DEFAULT_MEDIA_CACHE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024
DOCUMENT_NAMES = {
    'session', 'ui_bootstrap', 'prompt_library', 'logs_state',
    'request_statistics', 'update_state', 'network_detection',
    'notice_state', 'export_settings', 'viewport_state'
}


class StorageError(Exception):
    pass


class StorageService:
    def __init__(self, database_path=None, assets_dir=None, temp_dir=None, exports_dir=None,
                 fast_check_budget_seconds=FAST_CHECK_BUDGET_SECONDS,
                 transition_fault_injector=None):
        self.database_path = database_path or config.DATABASE_PATH
        self.assets_dir = assets_dir or config.ASSETS_DIR
        self.temp_dir = temp_dir or config.DATA_TEMP_DIR
        self.exports_dir = exports_dir or config.EXPORTS_DIR
        self._lock = threading.RLock()
        self._initialized = False
        self._safety_status = None
        self._fast_check_budget_seconds = max(0, float(fast_check_budget_seconds))
        self._transition_fault_injector = transition_fault_injector or (lambda _stage: None)

    def initialize(self):
        with self._lock:
            if self._initialized:
                return
            fast_check_started = time.monotonic()
            for path in (os.path.dirname(self.database_path), self.assets_dir, self.temp_dir, self.exports_dir):
                os.makedirs(path, exist_ok=True)
            schema_version = self._read_schema_version()
            fast_check_timed_out = time.monotonic() - fast_check_started > self._fast_check_budget_seconds
            if schema_version == 'unreadable':
                reason = ('gc_suspended', 'fast_check_timeout') if fast_check_timed_out else ('repair_required', 'database_unreadable')
                self._initialize_safety_status(reason)
                self._quarantine_corrupt_database()
                self._create_schema()
                self._initialized = True
                return
            if schema_version is not None and schema_version > SCHEMA_VERSION:
                reason = ('gc_suspended', 'fast_check_timeout') if fast_check_timed_out else ('repair_required', 'unknown_schema_version')
                self._initialize_safety_status(reason)
                self._initialized = True
                return
            schema_structure_changed = (
                schema_version == SCHEMA_VERSION and not self._has_expected_schema_structure()
            )
            fast_check_timed_out = (
                fast_check_timed_out
                or time.monotonic() - fast_check_started > self._fast_check_budget_seconds
            )
            forced_state = None
            if schema_version is not None and schema_version != SCHEMA_VERSION:
                forced_state = ('scan_required', 'schema_version_changed')
            elif schema_structure_changed:
                forced_state = ('scan_required', 'schema_structure_changed')
            if fast_check_timed_out:
                forced_state = ('gc_suspended', 'fast_check_timeout')
            # Existing stores publish their bounded structural verdict before any
            # potentially unbounded schema repair or legacy reference backfill.
            if schema_version is not None:
                self._initialize_safety_status(forced_state)
            try:
                self._create_schema()
            except sqlite3.DatabaseError:
                self._quarantine_corrupt_database()
                self._create_schema()
            if schema_version is None:
                self._initialize_safety_status(forced_state)
            self._initialized = True

    def _read_schema_version(self):
        if not os.path.exists(self.database_path):
            return None
        connection = sqlite3.connect(f'file:{quote(os.path.abspath(self.database_path))}?mode=ro', uri=True, timeout=0.25)
        try:
            row = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return int(row[0]) if row else None
        except sqlite3.OperationalError as error:
            return None if 'no such table' in str(error).lower() else 'unreadable'
        except (sqlite3.DatabaseError, TypeError, ValueError):
            return 'unreadable'
        finally:
            connection.close()

    def _has_expected_schema_structure(self):
        required = {
            'meta', 'documents', 'assets', 'history', 'media_asset_refs',
            'media_asset_owners', 'media_asset_owner_items', 'media_asset_transitions',
            'media_workflow_revisions',
            'media_workflow_owner_lists',
        }
        try:
            connection = sqlite3.connect(f'file:{quote(os.path.abspath(self.database_path))}?mode=ro', uri=True, timeout=0.25)
            try:
                tables = {
                    row[0] for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
                return required.issubset(tables)
            finally:
                connection.close()
        except sqlite3.DatabaseError:
            return False

    @property
    def _safety_path(self):
        return f'{self.database_path}.media-safety.json'

    def _storage_identities(self):
        instance_id = os.path.normcase(os.path.abspath(self.database_path))
        if os.path.exists(self.database_path):
            try:
                connection = sqlite3.connect(f'file:{quote(os.path.abspath(self.database_path))}?mode=ro', uri=True, timeout=0.25)
                try:
                    row = connection.execute("SELECT value FROM meta WHERE key='storage_instance_id'").fetchone()
                    if row and row[0]:
                        instance_id = str(row[0])
                finally:
                    connection.close()
            except sqlite3.DatabaseError:
                pass
        database_identity = hashlib.sha256(instance_id.encode('utf-8')).hexdigest()
        normalized_directory = os.path.normcase(os.path.abspath(self.assets_dir))
        directory_identity = hashlib.sha256(normalized_directory.encode('utf-8')).hexdigest()
        combined = f'{database_identity}|{directory_identity}|{STORAGE_MODE_VERSION}'
        return database_identity, directory_identity, hashlib.sha256(combined.encode('utf-8')).hexdigest()

    def _write_safety_status(self, status):
        directory = os.path.dirname(self._safety_path)
        os.makedirs(directory, exist_ok=True)
        fd, temporary_path = tempfile.mkstemp(prefix='media-safety-', dir=directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                json.dump(status, output, ensure_ascii=False, separators=(',', ':'))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, self._safety_path)
        finally:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)

    def _initialize_safety_status(self, forced_state=None):
        database_identity, directory_identity, identity = self._storage_identities()
        status = None
        safety_state_unreadable = False
        try:
            if os.path.getsize(self._safety_path) > MAX_SAFETY_STATE_BYTES:
                raise OSError('Safety state exceeds bounded fast-check size')
            with open(self._safety_path, encoding='utf-8') as source:
                status = json.load(source)
        except FileNotFoundError:
            pass
        except (OSError, json.JSONDecodeError):
            safety_state_unreadable = True
        required_fields = {
            'storageIdentity', 'databaseIdentity', 'directoryIdentity', 'storageModeVersion',
            'storageEpoch', 'state', 'reason', 'detectedAt', 'reportVersion',
            'recoveryConditions', 'cleanShutdown',
        }
        safety_state_invalid = isinstance(status, dict) and (
            not required_fields.issubset(status)
            or status.get('state') not in SAFETY_STATES
            or status.get('storageModeVersion') != STORAGE_MODE_VERSION
            or status.get('reportVersion') != INTEGRITY_REPORT_VERSION
            or not all(isinstance(status.get(key), str) and status.get(key)
                       for key in ('storageIdentity', 'databaseIdentity', 'directoryIdentity', 'storageEpoch', 'reason'))
            or not isinstance(status.get('detectedAt'), int)
            or not isinstance(status.get('recoveryConditions'), list)
            or not isinstance(status.get('cleanShutdown'), bool)
        )
        if isinstance(status, dict) and not safety_state_invalid:
            status = {key: status[key] for key in required_fields}
        if safety_state_invalid:
            status = None
        now = int(time.time() * 1000)
        identity_changed = isinstance(status, dict) and status.get('storageIdentity') != identity
        unclean_shutdown = isinstance(status, dict) and status.get('cleanShutdown') is False
        if not isinstance(status, dict) or identity_changed:
            status = {
                'storageIdentity': identity,
                'databaseIdentity': database_identity,
                'directoryIdentity': directory_identity,
                'storageModeVersion': STORAGE_MODE_VERSION,
                'storageEpoch': str(uuid.uuid4()),
                'state': 'scan_required',
                'reason': 'storage_identity_changed' if identity_changed else 'first_use',
                'detectedAt': now,
                'reportVersion': INTEGRITY_REPORT_VERSION,
                'recoveryConditions': ['complete_integrity_scan'],
            }
        elif unclean_shutdown and status.get('state') in {'healthy', 'scan_required'}:
            status.update({
                'state': 'gc_suspended',
                'reason': 'unclean_shutdown',
                'detectedAt': now,
                'recoveryConditions': ['complete_integrity_scan'],
            })
        status.setdefault('databaseIdentity', database_identity)
        status.setdefault('directoryIdentity', directory_identity)
        if safety_state_unreadable:
            forced_state = ('repair_required', 'safety_state_unreadable')
        elif safety_state_invalid:
            forced_state = ('repair_required', 'safety_state_invalid')
        if forced_state:
            recovery_conditions = ['complete_integrity_scan']
            if forced_state[1] == 'unknown_schema_version':
                recovery_conditions.insert(0, 'use_supported_application_version')
            status.update({
                'state': forced_state[0],
                'reason': forced_state[1],
                'detectedAt': now,
                'recoveryConditions': recovery_conditions,
            })
        status['cleanShutdown'] = False
        self._safety_status = status
        self._write_safety_status(status)

    def get_storage_safety_status(self):
        self.initialize()
        return {key: value for key, value in self._safety_status.items() if key != 'cleanShutdown'}

    def mark_clean_shutdown(self):
        self.initialize()
        with self._lock:
            self._safety_status['cleanShutdown'] = True
            self._write_safety_status(self._safety_status)

    def _physical_reclamation_allowed(self):
        return bool(self._safety_status and self._safety_status.get('state') == 'healthy')

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
                CREATE TABLE IF NOT EXISTS media_asset_refs (
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    asset_key TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(owner_type, owner_id, asset_key),
                    FOREIGN KEY(asset_key) REFERENCES assets(asset_key) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_media_asset_refs_asset ON media_asset_refs(asset_key);
                CREATE TABLE IF NOT EXISTS media_asset_owners (
                    workflow_id TEXT NOT NULL,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    generation INTEGER NOT NULL,
                    document_revision INTEGER NOT NULL,
                    tombstoned INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(workflow_id, owner_type, owner_id)
                );
                CREATE TABLE IF NOT EXISTS media_asset_owner_items (
                    workflow_id TEXT NOT NULL,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    asset_key TEXT NOT NULL,
                    PRIMARY KEY(workflow_id, owner_type, owner_id, position),
                    FOREIGN KEY(workflow_id, owner_type, owner_id)
                        REFERENCES media_asset_owners(workflow_id, owner_type, owner_id) ON DELETE CASCADE,
                    FOREIGN KEY(asset_key) REFERENCES assets(asset_key) ON DELETE RESTRICT
                );
                CREATE INDEX IF NOT EXISTS idx_media_asset_owner_items_asset
                    ON media_asset_owner_items(asset_key);
                CREATE TABLE IF NOT EXISTS media_asset_transitions (
                    idempotency_key TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    target_digest TEXT NOT NULL,
                    expected_generation INTEGER NOT NULL,
                    document_revision INTEGER NOT NULL,
                    storage_epoch TEXT NOT NULL,
                    status TEXT NOT NULL,
                    result_generation INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media_workflow_revisions (
                    workflow_id TEXT PRIMARY KEY,
                    document_revision INTEGER NOT NULL,
                    storage_epoch TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media_workflow_owner_lists (
                    workflow_id TEXT NOT NULL,
                    document_revision INTEGER NOT NULL,
                    owner_type TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    target_digest TEXT NOT NULL,
                    PRIMARY KEY(workflow_id, document_revision, owner_type, owner_id),
                    FOREIGN KEY(workflow_id) REFERENCES media_workflow_revisions(workflow_id) ON DELETE CASCADE
                );
            ''')
            # Existing history rows predate the reference index.  Backfill them
            # idempotently so an upgrade never makes retained history collectible.
            now = int(time.time() * 1000)
            db.execute('''
                INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                SELECT 'history', CAST(id AS TEXT), asset_key, ? FROM history
            ''', (now,))
            db.execute('''
                INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                SELECT 'history-thumbnail', CAST(id AS TEXT), thumb_asset_key, ? FROM history
                WHERE thumb_asset_key IS NOT NULL
            ''', (now,))
            db.execute(
                'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                ('schema_version', str(SCHEMA_VERSION)),
            )
            db.execute(
                'INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)',
                ('storage_instance_id', str(uuid.uuid4())),
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
        return self._put_asset(asset_key, body, mime_type, kind)

    def _put_asset(self, asset_key, body, mime_type, kind, media_owner=None):
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
        now = int(time.time() * 1000)
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if media_owner:
                exists = db.execute('SELECT 1 FROM assets WHERE asset_key=?', (asset_key,)).fetchone()
                if not exists and self._media_cache_bytes(db) + len(body) > self.get_media_cache_limit():
                    raise StorageError('Media cache limit reached; no unreferenced media asset could be reclaimed')
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
            db.execute('''
                INSERT INTO assets(asset_key, sha256, kind, mime_type, size_bytes, relative_path, created_at)
                VALUES(?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_key) DO UPDATE SET
                    sha256=excluded.sha256, kind=excluded.kind, mime_type=excluded.mime_type,
                    size_bytes=excluded.size_bytes, relative_path=excluded.relative_path
            ''', (asset_key, digest, kind, mime_type or 'application/octet-stream', len(body), relative_path, now))
            if media_owner:
                self._transition_fault_injector('media_materialized')
                db.execute('''INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                    VALUES(?, ?, ?, ?)''', (*media_owner, asset_key, now))
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
        if not self._physical_reclamation_allowed():
            return False
        with self._lock, self._connect() as db:
            row = db.execute('SELECT relative_path FROM assets WHERE asset_key=?', (str(asset_key),)).fetchone()
            if not row:
                return False
            ref_count = db.execute('SELECT COUNT(*) FROM media_asset_refs WHERE asset_key=?', (str(asset_key),)).fetchone()[0]
            if ref_count:
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

    def get_media_cache_limit(self):
        value = self.get_meta('media_cache_limit_bytes', DEFAULT_MEDIA_CACHE_LIMIT_BYTES)
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return DEFAULT_MEDIA_CACHE_LIMIT_BYTES

    def set_media_cache_limit(self, limit_bytes):
        try:
            limit = int(limit_bytes)
        except (TypeError, ValueError) as error:
            raise StorageError('Media cache limit must be a whole number of bytes') from error
        if limit < 0:
            raise StorageError('Media cache limit cannot be negative')
        self.set_meta('media_cache_limit_bytes', limit)
        return limit

    def _media_cache_bytes(self, db):
        return db.execute('''
            SELECT COALESCE(SUM(size_bytes), 0) FROM assets
            WHERE kind='media'
        ''').fetchone()[0]

    def add_media_reference(self, owner_type, owner_id, asset_key):
        self.initialize()
        owner_type, owner_id, asset_key = (str(value or '').strip() for value in (owner_type, owner_id, asset_key))
        if not owner_type or not owner_id or not asset_key:
            raise StorageError('Media asset reference owner and asset key are required')
        with self._lock, self._connect() as db:
            if not db.execute('SELECT 1 FROM assets WHERE asset_key=?', (asset_key,)).fetchone():
                raise StorageError('Media asset does not exist')
            db.execute('''
                INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                VALUES(?, ?, ?, ?)
            ''', (owner_type, owner_id, asset_key, int(time.time() * 1000)))
        return self.get_asset_info(asset_key)

    def remove_media_reference(self, owner_type, owner_id, asset_key=None):
        self.initialize()
        with self._lock, self._connect() as db:
            if asset_key:
                db.execute('DELETE FROM media_asset_refs WHERE owner_type=? AND owner_id=? AND asset_key=?',
                           (str(owner_type), str(owner_id), str(asset_key)))
            else:
                db.execute('DELETE FROM media_asset_refs WHERE owner_type=? AND owner_id=?',
                           (str(owner_type), str(owner_id)))
        return self.cleanup_unreferenced_media_assets()

    def get_media_owner_reference_list(self, workflow_id, owner_type, owner_id):
        self.initialize()
        with self._connect() as db:
            owner = db.execute('''
                SELECT generation, document_revision, workflow_id, tombstoned
                FROM media_asset_owners WHERE workflow_id=? AND owner_type=? AND owner_id=?
            ''', (str(workflow_id), str(owner_type), str(owner_id))).fetchone()
            if not owner:
                return None
            asset_keys = [row[0] for row in db.execute('''
                SELECT asset_key FROM media_asset_owner_items
                WHERE workflow_id=? AND owner_type=? AND owner_id=? ORDER BY position
            ''', (str(workflow_id), str(owner_type), str(owner_id)))]
        return {
            'workflowId': owner['workflow_id'],
            'generation': owner['generation'],
            'documentRevision': owner['document_revision'],
            'tombstoned': bool(owner['tombstoned']),
            'assetKeys': asset_keys,
        }

    @staticmethod
    def _reference_list_digest(asset_keys):
        return hashlib.sha256(
            json.dumps(list(asset_keys), ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        ).hexdigest()

    def record_media_workflow_revision(self, workflow_id, document_revision, storage_epoch,
                                       owner_reference_lists):
        self.initialize()
        workflow_id = str(workflow_id or '').strip()
        if not workflow_id or str(storage_epoch) != str(self._safety_status['storageEpoch']):
            raise StorageError('Current workflow identity and storage epoch are required')
        revision = int(document_revision)
        manifests = []
        for item in owner_reference_lists or []:
            owner_type = str(item.get('ownerType') or '').strip()
            owner_id = str(item.get('ownerId') or '').strip()
            keys = [str(key or '').strip() for key in (item.get('assetKeys') or [])]
            if not owner_type or not owner_id or any(not key for key in keys):
                raise StorageError('Workflow Media asset manifest is invalid')
            manifests.append((owner_type, owner_id, self._reference_list_digest(keys)))
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT document_revision FROM media_workflow_revisions WHERE workflow_id=?',
                                 (workflow_id,)).fetchone()
            if current and revision < current['document_revision']:
                raise StorageError('Workflow document revision cannot move backwards')
            if current and revision == current['document_revision']:
                existing = {
                    (row['owner_type'], row['owner_id'], row['target_digest'])
                    for row in db.execute('''SELECT owner_type, owner_id, target_digest
                        FROM media_workflow_owner_lists
                        WHERE workflow_id=? AND document_revision=?''', (workflow_id, revision))
                }
                if existing != set(manifests):
                    raise StorageError('Workflow document revision is already bound to different media references')
            db.execute('''INSERT INTO media_workflow_revisions(workflow_id, document_revision, storage_epoch, updated_at)
                VALUES(?, ?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET
                    document_revision=excluded.document_revision, storage_epoch=excluded.storage_epoch,
                    updated_at=excluded.updated_at''',
                (workflow_id, revision, str(storage_epoch), int(time.time() * 1000)))
            db.execute('DELETE FROM media_workflow_owner_lists WHERE workflow_id=?', (workflow_id,))
            db.executemany('''INSERT INTO media_workflow_owner_lists(
                    workflow_id, document_revision, owner_type, owner_id, target_digest
                ) VALUES(?, ?, ?, ?, ?)''', [
                    (workflow_id, revision, owner_type, owner_id, digest)
                    for owner_type, owner_id, digest in manifests
                ])
        return revision

    @staticmethod
    def _formal_reference_owner_id(workflow_id, owner_type, owner_id):
        identity = json.dumps([workflow_id, owner_type, owner_id], ensure_ascii=False, separators=(',', ':'))
        return f'owner:{hashlib.sha256(identity.encode("utf-8")).hexdigest()}'

    def replace_media_owner_references(self, *, workflow_id, owner_type, owner_id,
                                       operation_id, idempotency_key, expected_generation,
                                       document_revision, storage_epoch, asset_keys, cancelled=False):
        self.initialize()
        workflow_id, owner_type, owner_id, operation_id, idempotency_key = (
            str(value or '').strip() for value in
            (workflow_id, owner_type, owner_id, operation_id, idempotency_key)
        )
        keys = [str(key or '').strip() for key in (asset_keys or [])]
        if not all((workflow_id, owner_type, owner_id, operation_id, idempotency_key)) or any(not key for key in keys):
            raise StorageError('Complete Media asset owner transition identity is required')
        expected_generation = int(expected_generation)
        document_revision = int(document_revision)
        now = int(time.time() * 1000)
        target_digest = self._reference_list_digest(keys)
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            transition = db.execute('''SELECT * FROM media_asset_transitions
                WHERE idempotency_key=?''', (idempotency_key,)).fetchone()
            if transition:
                binding = (
                    workflow_id, owner_type, owner_id, operation_id, target_digest,
                    expected_generation, document_revision, str(storage_epoch),
                )
                persisted_binding = tuple(transition[key] for key in (
                    'workflow_id', 'owner_type', 'owner_id', 'operation_id', 'target_digest',
                    'expected_generation', 'document_revision', 'storage_epoch',
                ))
                if binding != persisted_binding:
                    raise StorageError('Idempotency key is already bound to different transition content')
                if transition['status'] == 'completed':
                    return {'status': 'already-committed', 'generation': transition['result_generation']}
                if transition['status'] == 'cancelled':
                    return {'status': 'cancelled', 'generation': transition['result_generation']}
                if transition['status'] in {'stale', 'needs-reconciliation'}:
                    return {'status': transition['status'], 'generation': transition['result_generation']}
                if transition['status'] in {'owner-promoted', 'old-references-released'}:
                    db.execute("UPDATE media_asset_transitions SET status='needs-reconciliation' WHERE idempotency_key=?",
                               (idempotency_key,))
                    return {
                        'status': 'needs-reconciliation',
                        'generation': transition['result_generation'],
                    }
            else:
                db.execute('''INSERT INTO media_asset_transitions(
                        idempotency_key, workflow_id, owner_type, owner_id, operation_id, target_digest,
                        expected_generation, document_revision, storage_epoch, status, result_generation, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?)''',
                    (idempotency_key, workflow_id, owner_type, owner_id, operation_id, target_digest,
                     expected_generation, document_revision, str(storage_epoch), now))
            owner = db.execute('''SELECT generation, document_revision FROM media_asset_owners
                WHERE workflow_id=? AND owner_type=? AND owner_id=?''',
                (workflow_id, owner_type, owner_id)).fetchone()
            generation = owner['generation'] if owner else 0
            workflow_revision = db.execute('''SELECT document_revision, storage_epoch
                FROM media_workflow_revisions WHERE workflow_id=?''', (workflow_id,)).fetchone()
            manifest = db.execute('''SELECT target_digest FROM media_workflow_owner_lists
                WHERE workflow_id=? AND document_revision=? AND owner_type=? AND owner_id=?''',
                (workflow_id, document_revision, owner_type, owner_id)).fetchone()
            stale = (
                str(storage_epoch) != str(self._safety_status['storageEpoch'])
                or not workflow_revision
                or workflow_revision['storage_epoch'] != str(storage_epoch)
                or workflow_revision['document_revision'] != document_revision
                or not manifest or manifest['target_digest'] != target_digest
                or generation != expected_generation
                or (owner and document_revision <= owner['document_revision'])
            )
            if stale:
                db.execute("UPDATE media_asset_transitions SET status='stale', result_generation=? WHERE idempotency_key=?",
                           (generation, idempotency_key))
                return {'status': 'stale', 'generation': generation}
            if cancelled:
                db.execute("UPDATE media_asset_transitions SET status='cancelled' WHERE idempotency_key=?",
                           (idempotency_key,))
                return {'status': 'cancelled', 'generation': generation}
            missing = [key for key in set(keys) if not db.execute(
                'SELECT 1 FROM assets WHERE asset_key=?', (key,)
            ).fetchone()]
            if missing:
                db.execute("UPDATE media_asset_transitions SET status='needs-reconciliation' WHERE idempotency_key=?",
                           (idempotency_key,))
                return {'status': 'needs-reconciliation', 'generation': generation}
            transition_owner_id = f'transition:{hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()}'
            db.executemany('''INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                VALUES('media-transition', ?, ?, ?)''', [
                    (transition_owner_id, key, now) for key in dict.fromkeys(keys)
                ])
        self._transition_fault_injector('new_owner_established')

        reference_owner_id = self._formal_reference_owner_id(workflow_id, owner_type, owner_id)
        with self._lock, self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            current_owner = db.execute('''SELECT generation, document_revision FROM media_asset_owners
                WHERE workflow_id=? AND owner_type=? AND owner_id=?''',
                (workflow_id, owner_type, owner_id)).fetchone()
            current_generation = current_owner['generation'] if current_owner else 0
            current_revision = db.execute('''SELECT document_revision, storage_epoch
                FROM media_workflow_revisions WHERE workflow_id=?''', (workflow_id,)).fetchone()
            current_manifest = db.execute('''SELECT target_digest FROM media_workflow_owner_lists
                WHERE workflow_id=? AND document_revision=? AND owner_type=? AND owner_id=?''',
                (workflow_id, document_revision, owner_type, owner_id)).fetchone()
            current_transition = db.execute('SELECT status FROM media_asset_transitions WHERE idempotency_key=?',
                                            (idempotency_key,)).fetchone()
            if (current_generation != expected_generation or not current_revision
                    or current_revision['document_revision'] != document_revision
                    or current_revision['storage_epoch'] != str(storage_epoch)
                    or not current_manifest or current_manifest['target_digest'] != target_digest
                    or not current_transition or current_transition['status'] != 'prepared'):
                db.execute("UPDATE media_asset_transitions SET status='stale', result_generation=? WHERE idempotency_key=?",
                           (current_generation, idempotency_key))
                db.execute("DELETE FROM media_asset_refs WHERE owner_type='media-transition' AND owner_id=?",
                           (transition_owner_id,))
                return {'status': 'stale', 'generation': current_generation}
            old_keys = [row[0] for row in db.execute('''SELECT asset_key FROM media_asset_refs
                WHERE owner_type=? AND owner_id=?''', (owner_type, reference_owner_id))]
            next_generation = generation + 1
            db.execute('''INSERT INTO media_asset_owners(
                    owner_type, owner_id, workflow_id, generation, document_revision, tombstoned, updated_at
                ) VALUES(?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(workflow_id, owner_type, owner_id) DO UPDATE SET
                    generation=excluded.generation,
                    document_revision=excluded.document_revision, tombstoned=0, updated_at=excluded.updated_at
            ''', (owner_type, owner_id, workflow_id, next_generation, document_revision, now))
            db.execute('''DELETE FROM media_asset_owner_items
                WHERE workflow_id=? AND owner_type=? AND owner_id=?''',
                (workflow_id, owner_type, owner_id))
            db.executemany('''INSERT INTO media_asset_owner_items(
                    workflow_id, owner_type, owner_id, position, asset_key
                ) VALUES(?, ?, ?, ?, ?)''', [
                    (workflow_id, owner_type, owner_id, position, key) for position, key in enumerate(keys)
                ])
            db.executemany('''INSERT INTO media_asset_refs(owner_type, owner_id, asset_key, created_at)
                VALUES(?, ?, ?, ?) ON CONFLICT(owner_type, owner_id, asset_key) DO NOTHING''', [
                    (owner_type, reference_owner_id, key, now) for key in dict.fromkeys(keys)
                ])
            db.execute('''UPDATE media_asset_transitions
                SET status='owner-promoted', result_generation=? WHERE idempotency_key=?''',
                (next_generation, idempotency_key))
        self._transition_fault_injector('owner_promoted')

        target_set = set(keys)
        for old_key in old_keys:
            if old_key in target_set:
                continue
            with self._lock, self._connect() as db:
                db.execute('''DELETE FROM media_asset_refs
                    WHERE owner_type=? AND owner_id=? AND asset_key=?
                    AND NOT EXISTS (
                        SELECT 1 FROM media_asset_owner_items
                        WHERE workflow_id=? AND owner_type=? AND owner_id=? AND asset_key=?
                    )''',
                    (owner_type, reference_owner_id, old_key,
                     workflow_id, owner_type, owner_id, old_key))
            self._transition_fault_injector('partial_old_reference_released')
        with self._lock, self._connect() as db:
            db.execute("UPDATE media_asset_transitions SET status='old-references-released' WHERE idempotency_key=?",
                       (idempotency_key,))
            db.execute("DELETE FROM media_asset_refs WHERE owner_type='media-transition' AND owner_id=?",
                       (transition_owner_id,))
            db.execute("UPDATE media_asset_transitions SET status='completed' WHERE idempotency_key=?",
                       (idempotency_key,))
        return {'status': 'committed', 'generation': next_generation}

    def put_media_asset(self, body, mime_type, owner_type, owner_id):
        """Store one canonical Media asset and atomically attach an owner reference."""
        owner_type, owner_id = (str(value or '').strip() for value in (owner_type, owner_id))
        if not owner_type or not owner_id:
            raise StorageError('Media asset reference owner and asset key are required')
        if not isinstance(body, (bytes, bytearray)) or not body:
            raise StorageError('Asset body is empty')
        digest = hashlib.sha256(bytes(body)).hexdigest()
        asset_key = f'media:{digest}'
        self.initialize()
        # A cache write may reclaim only assets with no durable owner first;
        # referenced results are never evicted to make room for another result.
        self.cleanup_unreferenced_media_assets()
        return self._put_asset(asset_key, body, mime_type, 'media', media_owner=(owner_type, owner_id))

    def cleanup_unreferenced_media_assets(self):
        self.initialize()
        with self._connect() as db:
            keys = [row[0] for row in db.execute('''
                SELECT asset_key FROM assets WHERE kind IN ('media', 'history', 'thumbnail') AND NOT EXISTS (
                    SELECT 1 FROM media_asset_refs WHERE media_asset_refs.asset_key=assets.asset_key
                )
            ''')]
        if not self._physical_reclamation_allowed():
            return {
                'assetsDeleted': 0,
                'orphanFilesDeleted': 0,
                'gcSuspended': True,
                'candidatesRetained': len(keys),
            }
        deleted = sum(1 for key in keys if self.delete_asset(key))
        return {
            'assetsDeleted': deleted,
            'orphanFilesDeleted': self.cleanup_orphan_files(),
            'gcSuspended': False,
            'candidatesRetained': 0,
        }

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
            db.execute('INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at) VALUES(?, ?, ?, ?)',
                       ('history', str(history_id), asset_key, int(time.time() * 1000)))
            if thumb_asset_key:
                db.execute('INSERT OR IGNORE INTO media_asset_refs(owner_type, owner_id, asset_key, created_at) VALUES(?, ?, ?, ?)',
                           ('history-thumbnail', str(history_id), thumb_asset_key, int(time.time() * 1000)))
        self.trim_history()
        return history_id

    def _history_row_to_dict(self, row):
        item = json.loads(row['metadata_json'])
        thumb_info = self.get_asset_info(row['thumb_asset_key']) if row['thumb_asset_key'] else None
        item.update({
            'id': row['id'], 'timestamp': row['timestamp'], 'mediaType': row['media_type'],
            'imageAssetKey': row['asset_key'] if row['media_type'] == 'image' else '',
            'videoAssetKey': row['asset_key'] if row['media_type'] == 'video' else '',
            'thumbAssetKey': row['thumb_asset_key'] or '',
            'thumbSizeBytes': int(thumb_info['size_bytes']) if thumb_info else 0,
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
        with self._lock, self._connect() as db:
            db.execute('DELETE FROM history WHERE id=?', (int(history_id),))
            db.execute("DELETE FROM media_asset_refs WHERE owner_id=? AND owner_type IN ('history', 'history-thumbnail')", (str(history_id),))
        self.cleanup_unreferenced_media_assets()
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
        if not self._physical_reclamation_allowed():
            return 0
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
            if mode == 'node-orphans':
                placeholders = ','.join('?' for _ in keep_keys) or "''"
                db.execute(
                    f'''DELETE FROM media_asset_refs
                        WHERE owner_type = 'node' AND owner_id NOT IN ({placeholders})''',
                    tuple(keep_keys),
                )
            elif mode == 'image-import':
                db.execute("DELETE FROM media_asset_refs WHERE owner_type='workflow-import'")
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
            elif mode == 'node-orphans' and key not in history_keys and kind in {'node', 'node-list'} and key not in keep_keys:
                delete_keys.append(key)
            elif mode == 'orphans' and key.startswith('history:') and key not in history_keys:
                delete_keys.append(key)
            elif mode == 'orphans' and kind == 'thumbnail' and key not in history_keys:
                delete_keys.append(key)
            elif mode == 'media-orphans' and kind == 'media':
                delete_keys.append(key)
        deleted = sum(1 for key in delete_keys if self.delete_asset(key))
        media_cleanup = self.cleanup_unreferenced_media_assets()
        return {
            'assetsDeleted': deleted + media_cleanup['assetsDeleted'],
            'orphanFilesDeleted': media_cleanup['orphanFilesDeleted']
        }

    def release_workflow_media_references(self, workflow_id):
        workflow_id = str(workflow_id or '').strip()
        if not workflow_id:
            return {'referencesDeleted': 0, **self.cleanup_unreferenced_media_assets()}
        with self._connect() as db:
            cursor = db.execute('''DELETE FROM media_asset_refs
                WHERE owner_type IN ('workflow-node', 'workflow-import', 'workflow-undo')
                    AND substr(owner_id, 1, length(?) + 1) = ? || ':' ''',
                (workflow_id, workflow_id))
        cleanup = self.cleanup_unreferenced_media_assets()
        return {'referencesDeleted': cursor.rowcount, **cleanup}

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
        if not self._physical_reclamation_allowed():
            raise StorageError('Physical media reclamation is suspended until integrity verification completes')
        with self._lock, self._connect() as db:
            db.execute('DELETE FROM history')
            db.execute('DELETE FROM assets')
            db.execute('DELETE FROM documents')
            db.execute("DELETE FROM meta WHERE key NOT IN ('schema_version', 'storage_instance_id')")
        if os.path.isdir(self.assets_dir):
            shutil.rmtree(self.assets_dir)
        os.makedirs(self.assets_dir, exist_ok=True)
        self.clear_temporary()

    def get_stats(self, workflow_id=''):
        self.initialize()
        with self._connect() as db:
            documents = db.execute('SELECT COUNT(*) FROM documents').fetchone()[0]
            assets, asset_bytes = db.execute('SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM assets').fetchone()
            media_assets, media_bytes = db.execute("SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind='media'").fetchone()
            actual_media_bytes = db.execute('''
                SELECT COALESCE(SUM(size_bytes), 0) FROM (
                    SELECT relative_path, MAX(size_bytes) AS size_bytes
                    FROM assets
                    GROUP BY relative_path
                )
            ''').fetchone()[0]
            media_references = db.execute('SELECT COUNT(*) FROM media_asset_refs').fetchone()[0]
            history = db.execute('SELECT COUNT(*) FROM history').fetchone()[0]
            document_bytes = db.execute('SELECT COALESCE(SUM(LENGTH(value_json)), 0) FROM documents').fetchone()[0]
            history_bytes = db.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind IN ('history', 'thumbnail')").fetchone()[0]
            import_bytes = db.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM assets WHERE kind='image-import'").fetchone()[0]
            reference_distribution = {}
            reference_params = []
            reference_filter = ''
            if workflow_id:
                reference_filter = "WHERE owner_type NOT IN ('workflow-node', 'workflow-import', 'workflow-undo') OR substr(owner_id, 1, length(?) + 1) = ? || ':'"
                reference_params.extend([workflow_id, workflow_id])
            for row in db.execute(f'''
                SELECT unique_refs.owner_type, COUNT(*) AS assets,
                    COALESCE(SUM(unique_assets.size_bytes), 0) AS bytes
                FROM (
                    SELECT DISTINCT owner_type, asset_key FROM media_asset_refs
                    {reference_filter}
                ) AS unique_refs
                JOIN assets AS unique_assets ON unique_assets.asset_key = unique_refs.asset_key
                GROUP BY unique_refs.owner_type
            ''', reference_params):
                reference_distribution[row['owner_type']] = {
                    'assets': row['assets'], 'bytes': row['bytes']
                }
        return {
            'documents': documents, 'documentBytes': document_bytes,
            'assets': assets, 'assetBytes': asset_bytes, 'history': history,
            'historyBytes': history_bytes, 'imageImportBytes': import_bytes,
            'nodeAssetBytes': max(0, asset_bytes - history_bytes - import_bytes),
            'totalBytes': asset_bytes + document_bytes,
            'mediaAssets': media_assets, 'mediaBytes': media_bytes,
            'actualMediaBytes': actual_media_bytes,
            'mediaReferenceDistribution': reference_distribution,
            'mediaReferences': media_references, 'mediaCacheLimitBytes': self.get_media_cache_limit(),
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
