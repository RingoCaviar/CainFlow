import base64
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from backend import config
from backend.services import canvas_mcp_storage, workflow_service
from backend.services.canvas_mcp_bridge import CanvasMcpError
from backend.services.storage_service import StorageService


class CanvasMcpStorageTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        root = Path(temporary)
        self.workflows = root / 'workflows'
        self.storage = StorageService(
            database_path=str(root / 'db.sqlite3'), assets_dir=str(root / 'assets'),
            temp_dir=str(root / 'temp'), exports_dir=str(root / 'exports'),
        )
        self.enterContext(patch.object(config, 'WORKFLOWS_DIR', str(self.workflows)))
        self.enterContext(patch.object(canvas_mcp_storage, 'storage_service', self.storage))

    def test_create_list_and_update_by_identity_across_folder_moves(self):
        first = canvas_mcp_storage.create_saved_workflow('Alpha')
        second = canvas_mcp_storage.create_saved_workflow('Beta')
        with self.assertRaisesRegex(CanvasMcpError, 'name already exists'):
            canvas_mcp_storage.create_saved_workflow('ALPHA')
        self.assertEqual(
            {'items': [{'workflowId': first['workflowId'], 'name': 'Alpha'}], 'nextOffset': 1},
            canvas_mcp_storage.list_saved_workflows(0, 1),
        )
        self.assertEqual(
            {'items': [{'workflowId': second['workflowId'], 'name': 'Beta'}], 'nextOffset': None},
            canvas_mcp_storage.list_saved_workflows(1, 1),
        )
        workflow_service.rename_workflow('Alpha', 'Folder/Renamed')
        workflow_id = first['workflowId']
        # The document pin survives a rename and cannot recreate the old file.
        updated = canvas_mcp_storage.save_saved_workflow(workflow_id, first['revision'], {
            **first['document'], 'nodes': [{'id': 'text', 'type': 'Text', 'text': 'saved'}],
        })
        self.assertEqual(updated, canvas_mcp_storage.read_saved_workflow(workflow_id))
        self.assertEqual(updated['name'], 'Folder/Renamed')
        self.assertFalse((self.workflows / 'Alpha.json').exists())
        self.assertNotEqual(updated['revision'], first['revision'])
        self.assertEqual(2, updated['document']['mediaOwnershipRevision'])

    def test_duplicates_are_ambiguous_and_a_deleted_workflow_cannot_be_recreated(self):
        saved = canvas_mcp_storage.create_saved_workflow('Original')
        identity = saved['workflowId']
        duplicate = self.workflows / 'Duplicate.json'
        duplicate.write_bytes((self.workflows / 'Original.json').read_bytes())
        workflow_service.save_workflow('Legacy', b'{"nodes":[],"connections":[]}')
        self.assertEqual([], canvas_mcp_storage.list_saved_workflows()['items'])
        with self.assertRaisesRegex(CanvasMcpError, 'Multiple saved files'):
            canvas_mcp_storage.read_saved_workflow(identity)
        duplicate.unlink()
        workflow_service.delete_workflow('Original')
        with self.assertRaisesRegex(CanvasMcpError, 'not found'):
            canvas_mcp_storage.save_saved_workflow(identity, saved['revision'], saved['document'])
        self.assertFalse((self.workflows / 'Original.json').exists())

    def test_compare_and_swap_and_ui_revision_conflict_preserve_committed_mcp_edit(self):
        saved = canvas_mcp_storage.create_saved_workflow('Draft')
        identity = saved['workflowId']

        def edit(text):
            try:
                return canvas_mcp_storage.save_saved_workflow(identity, saved['revision'], {
                    **saved['document'], 'nodes': [{'id': 'text', 'type': 'Text', 'text': text}],
                })
            except CanvasMcpError as error:
                self.assertEqual(error.code, 'stale_revision')
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(edit, ['alpha', 'beta']))
        self.assertEqual(1, sum(result is not None for result in results))
        committed = canvas_mcp_storage.read_saved_workflow(identity)
        stale_ui = json.dumps({**saved['document'], 'mediaOwnershipRevision': 2}).encode()
        with self.assertRaisesRegex(RuntimeError, 'changed by Canvas MCP'):
            workflow_service.save_workflow('Draft', stale_ui, 1)
        self.assertEqual(committed, canvas_mcp_storage.read_saved_workflow(identity))

        current_ui = json.dumps({**committed['document'], 'mediaOwnershipRevision': 3}).encode()
        workflow_service.save_workflow('Draft', current_ui, 2)
        with self.assertRaisesRegex(RuntimeError, 'changed by Canvas MCP'):
            workflow_service.save_workflow('Draft', stale_ui, 1)

    def test_media_results_are_staged_and_owned_by_the_saved_workflow(self):
        saved = canvas_mcp_storage.create_saved_workflow('Images')
        identity = saved['workflowId']
        image = 'data:image/png;base64,' + base64.b64encode(b'sample image').decode('ascii')
        pending = canvas_mcp_storage.stage_workflow_media(identity, 'image', [image, image])
        document = {**saved['document'], 'nodes': [{
            'id': 'image', 'type': 'ImageGenerate', 'mediaAssetKeys': pending['assetKeys'],
            'data': {'mediaOwnershipTemporaryOwners': [pending]},
        }]}
        next_workflow = canvas_mcp_storage.save_saved_workflow(identity, saved['revision'], document)
        self.assertNotIn('ownershipPending', next_workflow)
        owner = self.storage.get_media_owner_reference_list(identity, 'workflow-node', 'image')
        self.assertEqual(pending['assetKeys'], owner['assetKeys'])
        self.assertEqual(2, owner['documentRevision'])
        self.assertEqual(image, canvas_mcp_storage.load_workflow_media(owner['assetKeys'][0]))
        with self.storage._connect() as database:
            self.assertIsNone(database.execute('SELECT 1 FROM media_asset_refs WHERE owner_id=?',
                                               (pending['ownerId'],)).fetchone())

        asset = owner['assetKeys'][0]
        # Undo protects the original bytes before the saved document drops their formal owner.
        self.assertEqual(1, canvas_mcp_storage.protect_workflow_undo('mcp', 'before-delete', next_workflow['document'])['protected'])
        deleted = canvas_mcp_storage.save_saved_workflow(identity, next_workflow['revision'], {
            **next_workflow['document'], 'nodes': [],
        })
        self.assertTrue(self.storage.get_media_owner_reference_list(identity, 'workflow-node', 'image')['tombstoned'])
        self.assertTrue(canvas_mcp_storage.workflow_media_exists(asset))
        restored = canvas_mcp_storage.save_saved_workflow(identity, deleted['revision'], next_workflow['document'], restore_intent='undo')
        self.assertNotIn('ownershipPending', restored)
        canvas_mcp_storage.release_workflow_undo('mcp', 'before-delete')
        canvas_mcp_storage.end_workflow_undo('mcp')
        self.assertEqual(owner['assetKeys'], self.storage.get_media_owner_reference_list(identity, 'workflow-node', 'image')['assetKeys'])
