import gzip
import hashlib
import json
import os
import re
import threading
from datetime import datetime, timedelta, timezone


LEVEL_SAMPLE_RATES = {'compact': 0.01, 'standard': 0.10, 'detailed': 1.0}
SENSITIVE_KEYS = {
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'key', 'api_key', 'apikey', 'api-key', 'x-api-key', 'tt-api-key',
    'token', 'access_token',
}
LEGACY_LOG_PATTERN = re.compile(r'^backend-\d{4}-\d{2}-\d{2}\.jsonl$')
SEGMENT_PATTERN = re.compile(r'^diagnostic-(error|success)-\d{8}T\d{6}-\d+\.jsonl(?:\.gz)?$')


class DiagnosticService:
    """Owns bounded diagnostic policy and its filesystem adapter."""

    def __init__(self, log_dir, *, budget_bytes, canvas_budget_bytes, segment_bytes, record_bytes, retention_days):
        self.log_dir = os.path.abspath(log_dir)
        self.budget_bytes = int(budget_bytes)
        self.canvas_budget_bytes = int(canvas_budget_bytes)
        self.segment_bytes = int(segment_bytes)
        self.record_bytes = int(record_bytes)
        self.retention_days = int(retention_days)
        self.policy_path = os.path.join(self.log_dir, 'diagnostic-policy.json')
        self._lock = threading.RLock()
        self._level = 'standard'
        self._migrated_legacy_retention = False
        self._warning_emitted = False
        self._last_error = None
        self._last_cleanup = None
        self._sequence = 0
        self._active_paths = {}

    def initialize(self, legacy_settings=None):
        os.makedirs(self.log_dir, exist_ok=True)
        with self._lock:
            self._load_policy()
            if isinstance(legacy_settings, dict) and 'logRetentionDays' in legacy_settings:
                legacy_settings.pop('logRetentionDays', None)
                self._level = 'standard'
                self._migrated_legacy_retention = True
                self._save_policy()
            self._remove_expired()
            self._migrate_legacy_files()
            self.enforce_budget()
        return self.policy()

    def policy(self):
        return {
            'level': self._level,
            'sampleRate': LEVEL_SAMPLE_RATES[self._level],
            'budgetBytes': self.budget_bytes,
            'recordBytes': self.record_bytes,
            'retentionDays': self.retention_days,
            'migratedLegacyRetention': self._migrated_legacy_retention,
        }

    def set_level(self, level):
        normalized = str(level or '').strip().lower()
        if normalized not in LEVEL_SAMPLE_RATES:
            raise ValueError('Unknown diagnostic level')
        with self._lock:
            self._level = normalized
            self._save_policy()
        return self.policy()

    def should_record(self, is_error, stable_id):
        if is_error:
            return True
        digest = hashlib.sha256(str(stable_id or '').encode('utf-8')).digest()
        bucket = int.from_bytes(digest[:8], 'big') / float(2**64)
        return bucket < LEVEL_SAMPLE_RATES[self._level]

    def record(self, intent, *, force=False):
        is_error = bool(intent.get('error'))
        stable_id = intent.get('requestId') or intent.get('id') or ''
        if not force and not self.should_record(is_error, stable_id):
            return {'recorded': False, 'sampledOut': True, 'warning': False}
        try:
            with self._lock:
                os.makedirs(self.log_dir, exist_ok=True)
                payload = self._bounded_payload(intent, is_error)
                priority = 'error' if is_error else 'success'
                path = self._active_segment(priority)
                line = json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n'
                if os.path.exists(path) and os.path.getsize(path) + len(line.encode('utf-8')) > self.segment_bytes:
                    self._close_segment(priority, path)
                    path = self._active_segment(priority, fresh=True)
                with open(path, 'a', encoding='utf-8') as handle:
                    handle.write(line)
                self._remove_expired()
                self.enforce_budget()
            self._warning_emitted = False
            return {'recorded': True, 'sampledOut': False, 'warning': False}
        except Exception as error:
            warning = not self._warning_emitted
            self._warning_emitted = True
            self._last_error = {'at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'message': str(error)}
            return {'recorded': False, 'sampledOut': False, 'warning': warning, 'error': str(error)}

    def status(self):
        with self._lock:
            used = sum(entry['size'] for entry in self._entries())
            return {
                **self.policy(),
                'totalBudgetBytes': self.budget_bytes + self.canvas_budget_bytes,
                'adapters': {
                    'backend': {'budgetBytes': self.budget_bytes, 'recordBytes': self.record_bytes, 'retentionDays': self.retention_days, 'usedBytes': used},
                    'canvas': {'budgetBytes': self.canvas_budget_bytes, 'recordBytes': self.record_bytes, 'retentionDays': self.retention_days},
                },
                'usedBytes': used,
                'remainingBytes': max(0, self.budget_bytes - used),
                'lastCleanup': self._last_cleanup,
                'degraded': self._last_error is not None,
                'lastError': self._last_error,
            }

    def clear(self, scope='all'):
        if scope not in {'all', 'backend'}:
            return {'adapters': {'backend': {'success': False, 'error': 'Unsupported scope'}}}
        failures = []
        with self._lock:
            for entry in self._entries():
                try:
                    os.remove(entry['path'])
                except OSError as error:
                    failures.append({'file': entry['name'], 'error': str(error)})
            self._active_paths.clear()
        return {'adapters': {'backend': {'success': not failures, 'failures': failures}}}

    def enforce_budget(self):
        with self._lock:
            entries = self._entries()
            total = sum(entry['size'] for entry in entries)
            deleted = []
            for priority in ('success', 'error', 'legacy'):
                candidates = sorted(
                    (entry for entry in entries if entry['priority'] == priority),
                    key=lambda entry: (entry['mtime'], entry['name']),
                )
                for entry in candidates:
                    if total <= self.budget_bytes:
                        break
                    try:
                        os.remove(entry['path'])
                        total -= entry['size']
                        deleted.append(entry['name'])
                        for key, active in list(self._active_paths.items()):
                            if active == entry['path']:
                                self._active_paths.pop(key, None)
                    except OSError:
                        continue
            self._last_cleanup = {
                'at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'deletedFiles': len(deleted),
                'usedBytes': total,
            }
            return self._last_cleanup

    def _bounded_payload(self, intent, is_error):
        sanitized = self._sanitize(intent)
        if not is_error and self._level != 'detailed':
            for section_name in ('request', 'response'):
                section = sanitized.get(section_name)
                if isinstance(section, dict):
                    section.pop('body', None)
                    section.pop('bodyPreview', None)
        sanitized['diagnosticPriority'] = 'error' if is_error else 'success'
        sanitized.setdefault('timestamp', datetime.now(timezone.utc).isoformat(timespec='milliseconds'))
        sanitized['truncated'] = False
        encoded = json.dumps(sanitized, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) <= self.record_bytes:
            return sanitized
        summary = {
            'timestamp': sanitized.get('timestamp'),
            'requestId': sanitized.get('requestId'),
            'channel': sanitized.get('channel'),
            'method': sanitized.get('method'),
            'path': sanitized.get('path'),
            'durationMs': sanitized.get('durationMs'),
            'response': self._sanitize(sanitized.get('response')),
            'error': self._sanitize(sanitized.get('error')),
            'diagnosticPriority': sanitized['diagnosticPriority'],
            'originalBytes': len(encoded),
            'truncated': True,
        }
        while len(json.dumps(summary, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > self.record_bytes:
            if summary.get('response') is not None:
                summary['response'] = '[truncated]'
            elif summary.get('error') is not None:
                summary['error'] = str(summary['error'])[:128]
            else:
                break
        return summary

    def _sanitize(self, value):
        if isinstance(value, dict):
            return {
                str(key): ('[REDACTED]' if str(key).lower() in SENSITIVE_KEYS else self._sanitize(item))
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._sanitize(item) for item in value]
        if isinstance(value, str) and value.lower().startswith('data:'):
            return f'[data-url omitted; chars={len(value)}]'
        return value

    def _active_segment(self, priority, fresh=False):
        path = self._active_paths.get(priority)
        if path and not fresh and os.path.exists(path):
            return path
        self._sequence += 1
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
        path = os.path.join(self.log_dir, f'diagnostic-{priority}-{stamp}-{self._sequence}.jsonl')
        self._active_paths[priority] = path
        return path

    def _close_segment(self, priority, path):
        gz_path = path + '.gz'
        with open(path, 'rb') as source, gzip.open(gz_path, 'wb') as target:
            target.write(source.read())
        os.remove(path)
        self._active_paths.pop(priority, None)

    def _entries(self):
        try:
            names = os.listdir(self.log_dir)
        except FileNotFoundError:
            return []
        entries = []
        for name in names:
            priority = None
            match = SEGMENT_PATTERN.match(name)
            if match:
                priority = match.group(1)
            elif LEGACY_LOG_PATTERN.match(name):
                priority = 'legacy'
            if priority is None:
                continue
            path = os.path.join(self.log_dir, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            entries.append({'name': name, 'path': path, 'priority': priority, 'size': stat.st_size, 'mtime': stat.st_mtime})
        return entries

    def _remove_expired(self):
        cutoff = datetime.now(timezone.utc) - timedelta(days=self.retention_days)
        for entry in self._entries():
            if datetime.fromtimestamp(entry['mtime'], timezone.utc) < cutoff:
                try:
                    os.remove(entry['path'])
                except OSError:
                    pass

    def _migrate_legacy_files(self):
        # Legacy daily logs remain readable during the first cleanup and are
        # treated as lowest-priority records until the new budget converges.
        self.enforce_budget()

    def _load_policy(self):
        try:
            with open(self.policy_path, 'r', encoding='utf-8') as handle:
                level = json.load(handle).get('level')
            if level in LEVEL_SAMPLE_RATES:
                self._level = level
        except (OSError, ValueError, TypeError):
            pass

    def _save_policy(self):
        os.makedirs(self.log_dir, exist_ok=True)
        temporary = self.policy_path + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as handle:
            json.dump({'level': self._level}, handle, ensure_ascii=False)
        os.replace(temporary, self.policy_path)
