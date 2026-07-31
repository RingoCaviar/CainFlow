import unittest
from types import SimpleNamespace

from backend.services.system_notification_service import (
    MAX_NOTIFICATION_BODY_LENGTH,
    normalize_notification_payload,
    send_system_notification,
)


class SystemNotificationServiceTests(unittest.TestCase):
    def test_normalizes_payload(self):
        payload = normalize_notification_payload(' CainFlow ', ' done ', '')
        self.assertEqual(payload['title'], 'CainFlow')
        self.assertEqual(payload['body'], 'done')
        self.assertEqual(payload['tag'], 'cainflow-workflow-run')

    def test_rejects_oversized_body(self):
        with self.assertRaises(ValueError):
            normalize_notification_payload('CainFlow', 'x' * (MAX_NOTIFICATION_BODY_LENGTH + 1))

    def test_non_windows_is_unsupported(self):
        self.assertEqual(
            send_system_notification('CainFlow', platform='linux'),
            {'success': False, 'channel': 'unsupported'},
        )

    def test_windows_success_uses_hidden_subprocess_contract(self):
        calls = []

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        result = send_system_notification('CainFlow', '完成', 'test', platform='win32', run=fake_run)
        self.assertEqual(result, {'success': True, 'channel': 'windows-native'})
        self.assertEqual(calls[0][1]['env']['CAINFLOW_TOAST_BODY'], '完成')
        self.assertEqual(calls[0][1]['timeout'], 8)

    def test_windows_command_failure_is_reported(self):
        def fake_run(command, **kwargs):
            return SimpleNamespace(returncode=1, stdout='', stderr='toast blocked')

        result = send_system_notification('CainFlow', platform='win32', run=fake_run)
        self.assertFalse(result['success'])
        self.assertEqual(result['channel'], 'windows-native')
        self.assertIn('toast blocked', result['error'])


if __name__ == '__main__':
    unittest.main()
