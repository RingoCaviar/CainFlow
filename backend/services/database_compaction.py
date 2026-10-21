"""Best-effort physical SQLite maintenance; never decides which records to delete."""

import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time


BACKGROUND_MIN_FREE_BYTES = 1024 * 1024
BACKGROUND_MIN_FREE_RATIO = 0.2
MAX_COMPACTION_SECONDS = 3.0
BUSY_TIMEOUT_SECONDS = 0.05


def _open_database(path):
    # A missing database must not be silently replaced with an empty one.
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True,
                           timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None)


def compact_sqlite_database(path, *, can_compact, background=False):
    """Compact only in a short exclusive idle window, or return a retryable result.

    EXCLUSIVE locking remains in force between COMMIT and VACUUM. This also
    fences a new integrity-scan lease while the caller checks durable cursors;
    VACUUM can renumber implicit rowids, so a resumable scan must not overlap.
    The connection closes on every exit, releasing its exclusive locking mode.
    """
    db = None
    result = {'status': 'deferred', 'reason': '', 'beforeBytes': 0,
              'afterBytes': 0, 'reclaimedBytes': 0, 'freeBytes': 0}

    def finish(status, reason):
        result.update(status=status, reason=reason)
        try:
            result['afterBytes'] = os.path.getsize(path)
        except OSError:
            result['afterBytes'] = result['beforeBytes']
        result['reclaimedBytes'] = max(0, result['beforeBytes'] - result['afterBytes'])
        return result

    try:
        result['beforeBytes'] = os.path.getsize(path)
        db = _open_database(path)
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA locking_mode=EXCLUSIVE')
        db.execute('BEGIN EXCLUSIVE')
        db.execute('COMMIT')
        blocker = can_compact(db)
        if blocker:
            return finish('deferred', blocker)

        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        pages = db.execute('PRAGMA page_count').fetchone()[0]
        free_pages = db.execute('PRAGMA freelist_count').fetchone()[0]
        result['freeBytes'] = free_pages * page_size
        if not free_pages:
            return finish('skipped', 'no-free-pages')
        if background and (result['freeBytes'] < BACKGROUND_MIN_FREE_BYTES
                           or free_pages / max(1, pages) < BACKGROUND_MIN_FREE_RATIO):
            return finish('skipped', 'below-threshold')

        # VACUUM may need two database sizes for its temporary copy and journal.
        # Check both possible volumes; SQLite still handles a later disk-full
        # failure transactionally. Never replace/unlink the database or WAL.
        required = pages * page_size * 2 + 1024 * 1024
        for directory in {str(Path(path).resolve().parent), tempfile.gettempdir()}:
            if shutil.disk_usage(directory).free < required:
                return finish('deferred', 'insufficient-space')
        if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            return finish('deferred', 'busy')
        result['beforeBytes'] = os.path.getsize(path)
        deadline = time.monotonic() + MAX_COMPACTION_SECONDS
        db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        db.execute('VACUUM')
        db.set_progress_handler(None, 0)
        if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            return finish('deferred', 'busy')
        return finish('completed', 'compacted')
    except sqlite3.Error as error:
        code = getattr(error, 'sqlite_errorcode', 0) & 0xff
        reason = {sqlite3.SQLITE_BUSY: 'busy', sqlite3.SQLITE_LOCKED: 'busy',
                  sqlite3.SQLITE_FULL: 'insufficient-space',
                  sqlite3.SQLITE_INTERRUPT: 'time-budget'}.get(code, 'sqlite-error')
        return finish('deferred', reason)
    except OSError:
        return finish('deferred', 'io-error')
    finally:
        if db is not None:
            db.set_progress_handler(None, 0)
            db.close()
