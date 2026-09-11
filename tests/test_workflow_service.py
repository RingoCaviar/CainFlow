import json
import os
import tempfile
import unittest
from unittest import mock

from backend.services import workflow_service


class WorkflowMediaRevisionTests(unittest.TestCase):
    def test_compare_and_swap_rejects_a_stale_workflow_writer(self):
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(workflow_service.config, 'WORKFLOWS_DIR', root):
            with mock.patch.object(workflow_service, 'get_safe_path', return_value=os.path.join(root, 'flow.json')):
                first = json.dumps({'workflowId': 'wf', 'mediaOwnershipRevision': 1}).encode()
                second = json.dumps({'workflowId': 'wf', 'mediaOwnershipRevision': 2}).encode()
                stale = json.dumps({'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'stale': True}).encode()
                workflow_service.save_workflow('flow', first, 0)
                workflow_service.save_workflow('flow', second, 1)
                with self.assertRaisesRegex(RuntimeError, 'revision conflict'):
                    workflow_service.save_workflow('flow', stale, 1)
                self.assertEqual(second, workflow_service.load_workflow('flow'))


if __name__ == '__main__':
    unittest.main()
