"""Session-only history protection. Persistent workflow owners remain authoritative."""
import json
import os
import time

def process_has_exited(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 87
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except OSError:
        return False


class UndoMediaMixin:
    def undo_media_request(self, request):
        self.initialize()
        self.assert_storage_writable()
        action = request.get('action')
        page = request.get('pageId')
        if not isinstance(page, str) or not page or len(page) > 100:
            raise ValueError('Invalid undo page identity')
        runtime = self._undo_runtime_id
        prefix = f'undo-session:{runtime}:{page}:'
        if action == 'protect':
            record = request.get('recordId')
            keys = request.get('assetKeys', [])
            if not isinstance(record, str) or not record or len(record) > 300 or not isinstance(keys, list) or len(keys) > 20000:
                raise ValueError('Invalid undo record')
            if any(not isinstance(key, str) or not key.startswith('media:') or len(key) > 500 for key in keys):
                raise ValueError('Invalid undo asset')
            owner = prefix + record
            with self._lock, self._connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if self._undo_closing:
                    raise ValueError('Undo runtime is closing')
                if db.execute('SELECT 1 FROM meta WHERE key=?', (f'undo-ended:{runtime}:{page}',)).fetchone():
                    raise ValueError('Undo session has ended')
                missing = []
                for key in set(keys):
                    info = db.execute('SELECT relative_path FROM assets WHERE asset_key=?', (key,)).fetchone()
                    if not info or not os.path.isfile(os.path.join(self.assets_dir, info['relative_path'])):
                        missing.append(key)
                        continue
                    db.execute('INSERT OR IGNORE INTO media_asset_refs(owner_type,owner_id,asset_key,created_at) VALUES(?,?,?,?)',
                               ('session-undo', owner, key, int(time.time() * 1000)))
                db.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', (owner, json.dumps({
                    'runtime': runtime, 'pid': os.getpid(), 'page': page, 'workflow': request.get('workflowId', ''), 'record': record})))
            return {'protected': len(set(keys)) - len(missing), 'missing': missing}
        if action not in {'release', 'end'}:
            raise ValueError('Invalid undo action')
        if action == 'release' and (not isinstance(request.get('recordIds'), list) or any(not isinstance(item, str) for item in request['recordIds'])):
            raise ValueError('Invalid undo records')
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT key,value FROM meta WHERE key LIKE 'undo-session:%'").fetchall()
            owners = [row['key'] for row in rows if row['key'].startswith(prefix)
                      and (action == 'end' or json.loads(row['value']).get('record') in request.get('recordIds', []))]
            if action == 'end':
                db.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', (f'undo-ended:{runtime}:{page}', json.dumps({'runtime': runtime, 'pid': os.getpid()})))
            released = self._release_undo_owners(db, owners)
        result = self.cleanup_undo_candidates()
        if action == 'end':
            deadline = time.monotonic() + 2
            while result['pendingCount'] and result['assetsDeleted'] and time.monotonic() < deadline:
                batch = self.cleanup_undo_candidates()
                result = {**batch, 'assetsDeleted': result['assetsDeleted'] + batch['assetsDeleted']}
                if not batch['assetsDeleted']:
                    break
        return {'referencesReleased': released, **result}

    def _release_undo_owners(self, db, owners):
        released = 0
        for owner in owners:
            metadata = db.execute('SELECT value FROM meta WHERE key=?', (owner,)).fetchone()
            workflow = json.loads(metadata['value']).get('workflow') if metadata else None
            keys = db.execute("SELECT asset_key FROM media_asset_refs WHERE owner_type='session-undo' AND owner_id=?", (owner,)).fetchall()
            for row in keys:
                if workflow:
                    db.execute('INSERT OR IGNORE INTO media_gc_candidate_provenance(asset_key,workflow_id,observed_at) VALUES(?,?,?)',
                               (row['asset_key'], workflow, int(time.time() * 1000)))
                db.execute('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)', ('undo-pending:' + row['asset_key'], '"pending"'))
            released += db.execute("DELETE FROM media_asset_refs WHERE owner_type='session-undo' AND owner_id=?", (owner,)).rowcount
            db.execute('DELETE FROM meta WHERE key=?', (owner,))
        return released

    def recover_undo_sessions(self, ending=False):
        self.initialize()
        self.assert_storage_writable()
        with self._lock, self._connect() as db:
            if ending:
                self._undo_closing = True
            db.execute('BEGIN IMMEDIATE')
            owners = []
            for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'undo-session:%'").fetchall():
                data = json.loads(row['value'])
                if ending and data['runtime'] == self._undo_runtime_id:
                    owners.append(row['key'])
                elif data['runtime'] != self._undo_runtime_id:
                    if process_has_exited(int(data['pid'])):
                        owners.append(row['key'])
            released = self._release_undo_owners(db, owners)
            for row in db.execute("SELECT key,value FROM meta WHERE key LIKE 'undo-ended:%'").fetchall():
                data = json.loads(row['value'])
                if isinstance(data, dict) and ((ending and data['runtime'] == self._undo_runtime_id)
                        or (data['runtime'] != self._undo_runtime_id and process_has_exited(int(data['pid'])))):
                    db.execute('DELETE FROM meta WHERE key=?', (row['key'],))
        return {'referencesReleased': released, **self.cleanup_undo_candidates()}

    def cleanup_undo_candidates(self, limit=100):
        deleted = 0
        with self._lock, self._connect() as db:
            cursor = db.execute("SELECT value FROM meta WHERE key='undo-cleanup-cursor'").fetchone()
            rows = db.execute("SELECT key FROM meta WHERE key LIKE 'undo-pending:%' AND key>? ORDER BY key LIMIT ?", (cursor['value'] if cursor else '', limit)).fetchall()
            if not rows:
                rows = db.execute("SELECT key FROM meta WHERE key LIKE 'undo-pending:%' ORDER BY key LIMIT ?", (limit,)).fetchall()
            if rows:
                db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('undo-cleanup-cursor',?)", (rows[-1]['key'],))
        for row in rows:
            key = row['key'][len('undo-pending:'):]
            reason = 'safety-check-pending'
            try:
                with self._lock:
                    with self._connect() as db:
                        shared = db.execute('SELECT 1 FROM media_asset_refs WHERE asset_key=? UNION SELECT 1 FROM media_asset_owner_items WHERE asset_key=?', (key, key)).fetchone()
                        exists = db.execute('SELECT 1 FROM assets WHERE asset_key=?', (key,)).fetchone()
                    if shared or not exists or (self._cache_reclamation_verified() and self.delete_asset(key)):
                        deleted += int(bool(exists) and not shared)
                        with self._connect() as db:
                            db.execute('DELETE FROM meta WHERE key=?', (row['key'],))
                        continue
            except Exception:
                reason = 'cleanup-failed-retry'
            with self._connect() as db:
                db.execute('UPDATE meta SET value=? WHERE key=?', (json.dumps(reason), row['key']))
        return {'assetsDeleted': deleted, **self.undo_media_status()}

    def undo_media_status(self):
        with self._connect() as db:
            pending = db.execute("SELECT value,COUNT(*) AS count FROM meta WHERE key LIKE 'undo-pending:%' GROUP BY value").fetchall()
            protected = db.execute("SELECT COUNT(DISTINCT a.relative_path) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM (SELECT DISTINCT a.relative_path,a.size_bytes FROM assets a JOIN media_asset_refs r ON r.asset_key=a.asset_key WHERE r.owner_type='session-undo') a").fetchone()
        return {'protectedCount': protected['count'], 'protectedBytes': protected['bytes'],
                'pendingCount': sum(row['count'] for row in pending), 'pendingReasons': [json.loads(row['value']) for row in pending]}
