import json
import tempfile
import unittest

from tests import test_runtime_cache as runtime_tests
from tests import test_storage_service as storage_tests


class PromptAgentMediaTests(unittest.TestCase):
    def make_service(self, root):
        return runtime_tests.RuntimeCacheTests().make_service(root)

    def session(self, key, workflow_id='wf', run_id='run'):
        return {'workflowTabs': [{'workflowId': workflow_id, 'data': {
            'workflowId': workflow_id, 'nodes': [], 'promptAgent': {
                'archivedMessages': [{'runs': [{'runId': run_id, 'mediaAssetKeys': [key, key]}]}]}}}]}

    def test_session_atomically_retains_agent_results_after_operation_and_node_removal(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            operation = json.dumps(['wf', 'prompt-agent-result:run', 'run'], separators=(',', ':'))
            asset = service.put_media_asset_list(['data:image/png;base64,YQ=='], 'workflow-operation', operation)[0]
            key = asset['asset_key']
            service.put_document('session', self.session(key))
            service.cancel_media_operation_owner(operation)
            # A fresh service reads the durable session and references without
            # any generation node or explicit workflow JSON save.
            service = self.make_service(root)
            service.cleanup_unreferenced_media_assets()
            self.assertIsNotNone(service.get_asset(key))
            self.assertEqual(1, service.get_stats('wf')['mediaReferenceDistribution']['prompt-agent-result']['assets'])
            storage_tests.StorageServiceTests().finish_integrity_scan(service, [])
            self.assertIsNotNone(service.get_asset(key))
            service.put_document('session', {'workflowTabs': []})
            with service._connect() as db:
                self.assertEqual(0, db.execute("SELECT COUNT(*) FROM media_asset_refs WHERE owner_type='prompt-agent-result'").fetchone()[0])

    def test_clearing_session_preserves_independent_saved_workflow_result_owner(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            asset = service.put_media_asset(b'image', 'image/png', 'history', 'seed')
            key = asset['asset_key']
            epoch = service.get_storage_safety_status()['storageEpoch']
            service.record_media_workflow_revision('wf', 1, epoch, [{
                'ownerType': 'prompt-agent-result', 'ownerId': 'run', 'assetKeys': [key]}])
            service.replace_media_owner_references(workflow_id='wf', owner_type='prompt-agent-result', owner_id='run',
                operation_id='save', idempotency_key='save', expected_generation=0, document_revision=1,
                storage_epoch=epoch, asset_keys=[key])
            service.put_document('session', self.session(key))
            service.remove_media_reference('history', 'seed')
            service.put_document('session', {'workflowTabs': []})
            self.assertIsNotNone(service.get_asset(key))
            self.assertEqual([key], service.get_media_owner_reference_list('wf', 'prompt-agent-result', 'run')['assetKeys'])
            service.release_workflow_media_references('wf')
            with service._connect() as db:
                self.assertEqual(0, db.execute("SELECT COUNT(*) FROM media_asset_refs WHERE owner_type='prompt-agent-result'").fetchone()[0])

    def test_recovery_and_integrity_collect_archived_run_with_order_and_duplicate_positions(self):
        with tempfile.TemporaryDirectory() as root:
            service = self.make_service(root)
            operation = json.dumps(['wf', 'prompt-agent-result:run', 'run'], separators=(',', ':'))
            asset = service.put_media_asset_list(['data:image/png;base64,YQ==', 'data:image/png;base64,YQ=='], 'workflow-operation', operation)[0]
            key = asset['asset_key']
            workflow = self.session(key)['workflowTabs'][0]['data']
            workflow['mediaOwnershipRevision'] = 1
            workflow['promptAgent']['archivedMessages'][0]['runs'][0]['mediaOwnershipTemporaryOwners'] = [
                {'ownerId': operation, 'assetKeys': [key, key]}]
            self.assertEqual({'completed': 1, 'unresolved': 0}, service.recover_workflow_operation_owners([workflow]))
            self.assertEqual([key, key], service.get_media_owner_reference_list('wf', 'prompt-agent-result', 'run')['assetKeys'])
            self.assertEqual([key, key], service._workflow_media_references([workflow])[0]['assetKeys'])
            storage_tests.StorageServiceTests().finish_integrity_scan(service, [workflow])


if __name__ == '__main__':
    unittest.main()
