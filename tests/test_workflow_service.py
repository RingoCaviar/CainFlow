import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from backend.services import workflow_service


class WorkflowMediaRevisionTests(unittest.TestCase):
    def test_strict_save_binds_existing_workflow_identity_under_the_revision_lock(self):
        with (
            tempfile.TemporaryDirectory() as root,
            mock.patch.object(workflow_service.config, 'WORKFLOWS_DIR', root)
        ):
            first = b'{"workflowId":"original","mediaOwnershipRevision":1}'
            wrong = b'{"workflowId":"other","mediaOwnershipRevision":2}'
            second = b'{"workflowId":"original","mediaOwnershipRevision":2}'
            workflow_service.save_workflow('flow', first, 0)
            with self.assertRaisesRegex(RuntimeError, 'identity conflict'):
                workflow_service.save_workflow('flow', wrong, 1, strict_revision=True)
            self.assertEqual(first, workflow_service.load_workflow('flow'))
            self.assertEqual(2, workflow_service.save_workflow('flow', second, 1, strict_revision=True))

    def test_create_only_preserves_existing_legacy_document_and_prevents_racing_creates(self):
        with (
            tempfile.TemporaryDirectory() as root,
            mock.patch.object(workflow_service.config, 'WORKFLOWS_DIR', root)
        ):
            legacy = b'{"nodes":[{"id":"keep"}]}'
            blank = b'{"workflowId":"blank","mediaOwnershipRevision":1,"nodes":[],"connections":[]}'
            workflow_service.save_workflow('legacy', legacy)
            with self.assertRaises(FileExistsError):
                workflow_service.save_workflow('legacy', blank, 0, create_only=True)
            self.assertEqual(legacy, workflow_service.load_workflow('legacy'))

            def create_blank():
                try:
                    workflow_service.save_workflow('race', blank, 0, create_only=True)
                    return True
                except FileExistsError:
                    return False

            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertCountEqual([True, False], pool.map(lambda _: create_blank(), range(2)))
            self.assertEqual(blank, workflow_service.load_workflow('race'))

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
