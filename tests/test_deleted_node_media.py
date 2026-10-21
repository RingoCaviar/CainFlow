import json
import os
import tempfile
import time
import unittest
from unittest import mock

from backend.services.storage_service import StorageError
from tests import test_runtime_cache as runtime_tests


class DeletedNodeMediaTests(unittest.TestCase):
    def save_and_commit(self, service, root, workflow):
        """Exercise the document + manifest + owner replacement save protocol."""
        directory = os.path.join(root, 'workflows')
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, workflow['workflowId'] + '.json'), 'w', encoding='utf-8') as output:
            json.dump(workflow, output)
        workflow_id = workflow['workflowId']
        revision = workflow['mediaOwnershipRevision']
        epoch = service.get_storage_safety_status()['storageEpoch']
        owners = [{'ownerType': 'workflow-import' if node['type'] == 'ImageImport' else 'workflow-node',
                   'ownerId': node['id'], 'assetKeys': node['mediaAssetKeys']}
                  for node in workflow['nodes']]
        agent = workflow.get('promptAgent', {})
        owners.extend({'ownerType': 'prompt-agent-result', 'ownerId': run['runId'], 'assetKeys': run['mediaAssetKeys']}
                      for message in agent.get('messages', []) + agent.get('archivedMessages', [])
                      for run in message.get('runs', []))
        identities = {(owner['ownerType'], owner['ownerId']) for owner in owners}
        for previous in service.list_media_owner_reference_lists(workflow_id):
            if (previous['ownerType'], previous['ownerId']) not in identities and not previous['tombstoned']:
                owners.append({'ownerType': previous['ownerType'], 'ownerId': previous['ownerId'],
                               'assetKeys': [], 'deleted': True})
        service.record_media_workflow_revision(workflow_id, revision, epoch, owners)
        for owner in owners:
            previous = service.get_media_owner_reference_list(workflow_id, owner['ownerType'], owner['ownerId'])
            intent = 'delete' if owner.get('deleted') else 'save'
            operation = f'workflow-{intent}:{revision}'
            result = service.replace_media_owner_references(
                workflow_id=workflow_id, owner_type=owner['ownerType'], owner_id=owner['ownerId'],
                operation_id=operation, idempotency_key=f'{workflow_id}:{operation}:{owner["ownerType"]}:{owner["ownerId"]}',
                expected_generation=(previous or {}).get('generation', 0), document_revision=revision,
                storage_epoch=epoch, asset_keys=owner['assetKeys'], intent=intent)
            self.assertEqual('committed', result['status'])

    def test_saved_node_deletion_releases_legacy_reference_after_formal_promotion(self):
        for node_type, owner_type in [('ImageGenerate', 'workflow-node'), ('ImageImport', 'workflow-import')]:
            with self.subTest(node_type=node_type), tempfile.TemporaryDirectory() as root:
                service = runtime_tests.RuntimeCacheTests().make_service(root)
                # Workflow copies and older writers attach this stable reference
                # before the document is saved with formal owner generations.
                asset = service.put_media_asset(b'deleted-image', 'image/png', owner_type, 'wf:node')
                key = asset['asset_key']
                self.save_and_commit(service, root, {
                    'workflowId': 'wf', 'mediaOwnershipRevision': 1,
                    'nodes': [{'id': 'node', 'type': node_type, 'mediaAssetKeys': [key]}],
                })
                # The current copy path adds a legacy reference after saving.
                service.add_media_reference(owner_type, 'wf:node', key)
                self.assertIsNotNone(service.get_asset(key))
                self.save_and_commit(service, root, {
                    'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'nodes': [],
                })
                self.assertTrue(service.get_media_owner_reference_list('wf', owner_type, 'node')['tombstoned'])
                service.cleanup_assets('node-orphans')
                self.assertEqual(0, service.get_stats('wf')['mediaReferenceDistribution'].get(owner_type, {}).get('assets', 0))
                self.assertIsNone(service.get_asset(key), 'Deleted node still retains its image after saving and cleanup')

    def seed_old_alias(self, service, owner_type, owner_id, key):
        # Simulate an older release's leaked row, bypassing the fixed write guard.
        with service._connect() as db:
            db.execute('INSERT OR IGNORE INTO media_asset_refs VALUES(?, ?, ?, ?)',
                       (owner_type, owner_id, key, int(time.time() * 1000)))

    def test_deleting_legacy_node_before_its_first_formal_save_releases_its_alias(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            key = service.put_media_asset(b'legacy', 'image/png', 'workflow-import', 'wf:node')['asset_key']
            other = service.put_media_asset(b'other', 'image/png', 'workflow-import', 'wf-other:node')['asset_key']
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 1, 'nodes': []})
            service.cleanup_assets('node-orphans')
            self.assertIsNone(service.get_asset(key))
            self.assertIsNotNone(service.get_asset(other))

    def test_repairs_already_deleted_aliases_without_losing_shared_workflow_agent_or_history_images(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            images = {name: service.put_media_asset(name.encode(), 'image/png', 'workflow-node', 'wf:node')['asset_key']
                      for name in ['unused', 'other-workflow', 'message', 'archive', 'history']}
            agent = {'messages': [{'runs': [{'runId': 'message-run', 'mediaAssetKeys': [images['message']]}]}],
                     'archivedMessages': [{'runs': [{'runId': 'archive-run', 'mediaAssetKeys': [images['archive']]}]}]}
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 1,
                'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': list(images.values())}], 'promptAgent': agent})
            self.save_and_commit(service, root, {'workflowId': 'wf-other', 'mediaOwnershipRevision': 1,
                'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [images['other-workflow']]}]})
            service.put_document('session', {'workflowTabs': [{'workflowId': 'wf', 'data': {
                'workflowId': 'wf', 'nodes': [], 'promptAgent': agent}}]})
            service.save_history({'id': 1, 'imageAssetKey': images['history']})
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 2,
                'nodes': [], 'promptAgent': agent})
            for key in images.values():
                self.seed_old_alias(service, 'workflow-node', 'wf:node', key)
            # A second save skips the already tombstoned owner, as the UI does.
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 3,
                'nodes': [], 'promptAgent': agent})
            service.cleanup_assets('node-orphans')
            self.assertIsNone(service.get_asset(images['unused']))
            for name in ['other-workflow', 'message', 'archive', 'history']:
                self.assertEqual(name.encode(), service.get_asset(images[name])[1])
            stats = service.get_stats('wf')
            self.assertNotIn('workflow-node', stats['mediaReferenceDistribution'])
            self.assertEqual(2, stats['mediaReferenceDistribution']['prompt-agent-result']['assets'])
            self.assertEqual(sum(len(name) for name in ['other-workflow', 'message', 'archive', 'history']), stats['actualMediaBytes'])
            service.mark_clean_shutdown()
            restarted = runtime_tests.RuntimeCacheTests().make_service(root)
            for name in ['other-workflow', 'message', 'archive', 'history']:
                self.assertEqual(name.encode(), restarted.get_asset(images[name])[1])

    def test_interrupted_deletion_keeps_alias_until_the_formal_transition_recovers(self):
        for stage in ['new_owner_established', 'owner_promoted']:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as root:
                service = runtime_tests.RuntimeCacheTests().make_service(root)
                key = service.put_media_asset(b'image', 'image/png', 'workflow-node', 'wf:node')['asset_key']
                self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 1,
                    'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [key]}]})
                self.seed_old_alias(service, 'workflow-node', 'wf:node', key)
                def interrupt(current):
                    if current == stage:
                        raise OSError('interrupted')
                with mock.patch.object(service, '_transition_fault_injector', side_effect=interrupt):
                    with self.assertRaisesRegex(OSError, 'interrupted'):
                        self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'nodes': []})
                service.cleanup_assets('node-orphans')
                self.assertIsNotNone(service.get_asset(key))
                self.assertEqual(1, service.recover_media_owner_transitions()['completed'])
                service.cleanup_assets('node-orphans')
                self.assertIsNone(service.get_asset(key))

    def test_late_legacy_writer_cannot_revive_deleted_node_but_other_workflow_is_writable(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            key = service.put_media_asset(b'image', 'image/png', 'workflow-node', 'wf:node')['asset_key']
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 1,
                'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [key]}]})
            service.add_media_reference('workflow-node', 'wf-other:node', key)
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'nodes': []})
            with self.assertRaisesRegex(StorageError, 'Deleted node'):
                service.add_media_reference('workflow-node', 'wf:node', key)
            with self.assertRaisesRegex(StorageError, 'Deleted node'):
                service.put_media_asset(b'late', 'image/png', 'workflow-node', 'wf:node')
            service.add_media_reference('workflow-node', 'wf-other:node', key)
            service.cleanup_assets('node-orphans')
            self.assertIsNotNone(service.get_asset(key))

    def test_pending_restore_manifest_and_ambiguous_legacy_identity_are_preserved(self):
        for workflow_id, node_id, restoring in [('wf', 'node', True), ('wf:other', 'node', False), ('owner', 'hash', False)]:
            with self.subTest(workflow=workflow_id), tempfile.TemporaryDirectory() as root:
                service = runtime_tests.RuntimeCacheTests().make_service(root)
                key = service.put_media_asset(b'image', 'image/png', 'workflow-node', f'{workflow_id}:{node_id}')['asset_key']
                self.save_and_commit(service, root, {'workflowId': workflow_id, 'mediaOwnershipRevision': 1,
                    'nodes': [{'id': node_id, 'type': 'ImageGenerate', 'mediaAssetKeys': [key]}]})
                self.save_and_commit(service, root, {'workflowId': workflow_id, 'mediaOwnershipRevision': 2, 'nodes': []})
                self.seed_old_alias(service, 'workflow-node', f'{workflow_id}:{node_id}', key)
                if restoring:
                    epoch = service.get_storage_safety_status()['storageEpoch']
                    service.record_media_workflow_revision(workflow_id, 3, epoch,
                        [{'ownerType': 'workflow-node', 'ownerId': node_id, 'assetKeys': [key]}])
                service.cleanup_assets('node-orphans')
                self.assertIsNotNone(service.get_asset(key))

    def test_newer_restore_document_during_deletion_keeps_its_legacy_protection(self):
        with tempfile.TemporaryDirectory() as root:
            service = runtime_tests.RuntimeCacheTests().make_service(root)
            key = service.put_media_asset(b'image', 'image/png', 'workflow-node', 'wf:node')['asset_key']
            self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 1,
                'nodes': [{'id': 'node', 'type': 'ImageGenerate', 'mediaAssetKeys': [key]}]})
            self.seed_old_alias(service, 'workflow-node', 'wf:node', key)
            def publish_restore(stage):
                if stage == 'owner_promoted':
                    service.record_media_workflow_revision('wf', 3, service.get_storage_safety_status()['storageEpoch'],
                        [{'ownerType': 'workflow-node', 'ownerId': 'node', 'assetKeys': [key]}])
            with mock.patch.object(service, '_transition_fault_injector', side_effect=publish_restore):
                self.save_and_commit(service, root, {'workflowId': 'wf', 'mediaOwnershipRevision': 2, 'nodes': []})
            service.cleanup_assets('node-orphans')
            self.assertIsNotNone(service.get_asset(key))


if __name__ == '__main__':
    unittest.main()
