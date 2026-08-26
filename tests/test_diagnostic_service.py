import gzip
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from backend.services.diagnostic_service import DiagnosticService


class DiagnosticServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.service = DiagnosticService(
            self.temp_dir.name,
            budget_bytes=24 * 1024,
            canvas_budget_bytes=3 * 1024,
            segment_bytes=4 * 1024,
            record_bytes=1024,
            retention_days=14,
        )

    def test_default_policy_is_standard_and_old_retention_value_migrates_once(self):
        legacy = {'logRetentionDays': 30}
        policy = self.service.initialize(legacy_settings=legacy)
        self.assertEqual(policy['level'], 'standard')
        self.assertTrue(policy['migratedLegacyRetention'])
        self.assertNotIn('logRetentionDays', legacy)

    def test_status_exposes_backend_authoritative_policy_for_each_adapter(self):
        status = self.service.status()
        self.assertEqual(status['totalBudgetBytes'], 27 * 1024)
        self.assertEqual(status['adapters']['backend']['budgetBytes'], 24 * 1024)
        self.assertEqual(status['adapters']['canvas']['budgetBytes'], 3 * 1024)
        self.assertEqual(status['adapters']['canvas']['recordBytes'], 1024)
        self.assertEqual(status['adapters']['canvas']['retentionDays'], 14)

    def test_sampling_is_deterministic_and_errors_are_always_recorded(self):
        self.service.set_level('compact')
        decisions = [self.service.should_record(False, 'same-request') for _ in range(5)]
        self.assertEqual(decisions, [decisions[0]] * 5)
        self.assertTrue(self.service.should_record(True, 'same-request'))

    def test_success_body_is_kept_only_at_detailed_level(self):
        intent = {
            'requestId': 'successful-request',
            'response': {'status': 200, 'body': {'answer': 'private'}, 'bodyPreview': 'private'},
        }
        self.service.set_level('standard')
        self.service.record(intent, force=True)
        standard = self._read_records()[-1]
        self.assertNotIn('body', standard['response'])
        self.assertNotIn('bodyPreview', standard['response'])

        self.service.set_level('detailed')
        self.service.record({**intent, 'requestId': 'detailed-request'}, force=True)
        detailed = self._read_records()[-1]
        self.assertEqual(detailed['response']['body'], {'answer': 'private'})
        self.assertEqual(detailed['response']['bodyPreview'], 'private')

    def test_record_is_sanitized_and_capped(self):
        payload = {
            'requestId': 'req_sensitive',
            'error': {'message': 'failed'},
            'request': {
                'headers': {'Authorization': 'Bearer secret'},
                'body': {'api_key': 'secret', 'prompt': 'x' * 5000},
            },
        }
        result = self.service.record(payload)
        self.assertTrue(result['recorded'])
        line = self._read_records()[0]
        encoded = json.dumps(line, ensure_ascii=False).encode('utf-8')
        self.assertLessEqual(len(encoded), 1024)
        self.assertNotIn('secret', encoded.decode('utf-8'))
        self.assertTrue(line['truncated'])

    def test_budget_prefers_errors_over_success_segments(self):
        for index in range(80):
            self.service.record({
                'requestId': f'success-{index}',
                'response': {'status': 200, 'bodyPreview': 's' * 700},
            }, force=True)
        self.service.record({
            'requestId': 'important-error',
            'error': {'message': 'must survive'},
        })
        self.service.enforce_budget()
        records = self._read_records()
        self.assertTrue(any(record.get('requestId') == 'important-error' for record in records))
        self.assertLessEqual(self.service.status()['usedBytes'], 24 * 1024)

    def test_closed_segments_are_gzipped(self):
        for index in range(30):
            self.service.record({
                'requestId': f'error-{index}',
                'error': {'message': 'boom' * 100},
            })
        self.assertTrue(any(name.endswith('.jsonl.gz') for name in os.listdir(self.temp_dir.name)))

    def test_initialize_removes_expired_and_converges_legacy_files_to_budget(self):
        old_path = os.path.join(self.temp_dir.name, 'backend-2025-01-01.jsonl')
        with open(old_path, 'w', encoding='utf-8') as handle:
            handle.write(json.dumps({'error': {'message': 'old'}}) + '\n')
        old_time = (datetime.now(timezone.utc) - timedelta(days=30)).timestamp()
        os.utime(old_path, (old_time, old_time))
        oversized = os.path.join(self.temp_dir.name, 'backend-2026-08-26.jsonl')
        with open(oversized, 'w', encoding='utf-8') as handle:
            handle.write('x' * (40 * 1024))
        self.service.initialize()
        self.assertFalse(os.path.exists(old_path))
        self.assertLessEqual(self.service.status()['usedBytes'], 24 * 1024)

    def test_record_removes_files_that_expire_during_a_long_running_process(self):
        self.service.initialize()
        expired_path = os.path.join(self.temp_dir.name, 'diagnostic-error-20250101T000000-99.jsonl')
        with open(expired_path, 'w', encoding='utf-8') as handle:
            handle.write(json.dumps({'error': {'message': 'expired'}}) + '\n')
        old_time = (datetime.now(timezone.utc) - timedelta(days=15)).timestamp()
        os.utime(expired_path, (old_time, old_time))

        self.service.record({'requestId': 'current', 'error': {'message': 'current'}})

        self.assertFalse(os.path.exists(expired_path))

    def test_clear_reports_backend_result(self):
        self.service.record({'requestId': 'error', 'error': {'message': 'boom'}})
        result = self.service.clear('all')
        self.assertEqual(result['adapters']['backend']['success'], True)
        self.assertEqual(self.service.status()['usedBytes'], 0)

    def test_record_failure_does_not_raise_and_is_reported_once(self):
        with mock.patch('builtins.open', side_effect=PermissionError('denied')):
            first = self.service.record({'requestId': 'one', 'error': {'message': 'boom'}})
            second = self.service.record({'requestId': 'two', 'error': {'message': 'boom'}})
        self.assertFalse(first['recorded'])
        self.assertTrue(first['warning'])
        self.assertFalse(second['warning'])

    def _read_records(self):
        records = []
        for name in sorted(os.listdir(self.temp_dir.name)):
            path = os.path.join(self.temp_dir.name, name)
            if name.endswith('.jsonl'):
                opener = open
            elif name.endswith('.jsonl.gz'):
                opener = gzip.open
            else:
                continue
            with opener(path, 'rt', encoding='utf-8') as handle:
                for line in handle:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return records


if __name__ == '__main__':
    unittest.main()
