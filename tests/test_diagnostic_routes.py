import json
import unittest
from unittest import mock

from backend.routes import diagnostic_routes


class Handler:
    path = '/api/diagnostics'


class DiagnosticRouteTests(unittest.TestCase):
    def test_get_exposes_status_through_one_seam(self):
        handler = Handler()
        with mock.patch.object(diagnostic_routes.diagnostic_service, 'status', return_value={'level': 'standard'}), mock.patch.object(diagnostic_routes, 'write_json') as write_json:
            self.assertTrue(diagnostic_routes.handle_get(handler))
        write_json.assert_called_once_with(handler, {'success': True, 'status': {'level': 'standard'}})

    def test_post_sets_level(self):
        handler = Handler()
        with mock.patch.object(diagnostic_routes, 'read_json_body', return_value={'action': 'set-level', 'level': 'compact'}), mock.patch.object(diagnostic_routes.diagnostic_service, 'set_level', return_value={'level': 'compact'}), mock.patch.object(diagnostic_routes, 'write_json') as write_json:
            self.assertTrue(diagnostic_routes.handle_post(handler))
        write_json.assert_called_once_with(handler, {'success': True, 'policy': {'level': 'compact'}})

    def test_post_clear_preserves_per_adapter_result(self):
        handler = Handler()
        result = {'adapters': {'backend': {'success': True}}}
        with mock.patch.object(diagnostic_routes, 'read_json_body', return_value={'action': 'clear', 'scope': 'all'}), mock.patch.object(diagnostic_routes.diagnostic_service, 'clear', return_value=result), mock.patch.object(diagnostic_routes, 'write_json') as write_json:
            self.assertTrue(diagnostic_routes.handle_post(handler))
        write_json.assert_called_once_with(handler, {'success': True, **result})

    def test_post_records_a_bounded_workflow_diagnostic(self):
        handler = Handler()
        intent = {'kind': 'workflow-duplicate-identity-repaired', 'error': 'duplicate'}
        result = {'recorded': True, 'sampledOut': False, 'warning': False}
        with mock.patch.object(diagnostic_routes, 'read_json_body', return_value={'action': 'record', 'intent': intent}), mock.patch.object(diagnostic_routes.diagnostic_service, 'record', return_value=result) as record, mock.patch.object(diagnostic_routes, 'write_json') as write_json:
            self.assertTrue(diagnostic_routes.handle_post(handler))
        record.assert_called_once_with(intent)
        write_json.assert_called_once_with(handler, {'success': True, **result})


if __name__ == '__main__':
    unittest.main()
