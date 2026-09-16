import os
import tempfile
import unittest
import sqlite3
from unittest import mock

from backend.services.conversation_service import ConversationService
from backend.routes import conversation_routes


class ConversationServiceTests(unittest.TestCase):
    def test_created_conversation_survives_service_restart(self):
        with tempfile.TemporaryDirectory() as root:
            database_path = os.path.join(root, 'conversations.db')
            request = {
                'title': '',
                'workflowId': 'workflow-a',
                'defaultModelId': 'model-a',
                'defaultProviderId': 'provider-a',
                'systemPrompt': 'Help with this workflow.',
            }
            create_handler = type('Handler', (), {'path': '/api/conversations'})()
            created_response = {}
            with mock.patch.object(conversation_routes, 'conversation_service', ConversationService(database_path)), \
                    mock.patch.object(conversation_routes, 'read_json_body', return_value=request), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: created_response.update(value)):
                self.assertTrue(conversation_routes.handle_post(create_handler))
            created = created_response['conversation']

            get_handler = type('Handler', (), {'path': f"/api/conversations/{created['id']}"})()
            restored_response = {}
            with mock.patch.object(conversation_routes, 'conversation_service', ConversationService(database_path)), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: restored_response.update(value)):
                self.assertTrue(conversation_routes.handle_get(get_handler))
            restored = restored_response['conversation']

            self.assertEqual({
                'id': created['id'],
                'title': '新对话',
                'workflowId': 'workflow-a',
                'defaultModelId': 'model-a',
                'defaultProviderId': 'provider-a',
                'systemPrompt': 'Help with this workflow.',
                'systemPromptVersion': 1,
                'status': 'active',
                'revision': 1,
                'createdAt': created['createdAt'],
                'updatedAt': created['updatedAt'],
                'messages': [],
            }, restored)

    def test_message_media_references_commit_with_message_and_missing_assets_keep_position(self):
        with tempfile.TemporaryDirectory() as root:
            database_path = os.path.join(root, 'conversations.db')
            service = ConversationService(database_path)
            created = service.create_conversation({'title': 'Media'})
            database = sqlite3.connect(database_path)
            try:
                database.executescript('''
                    CREATE TABLE assets(asset_key TEXT PRIMARY KEY);
                    CREATE TABLE media_asset_refs(
                        owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, asset_key TEXT NOT NULL,
                        created_at INTEGER NOT NULL, PRIMARY KEY(owner_type, owner_id, asset_key));
                    INSERT INTO assets(asset_key) VALUES('asset-present');
                ''')
                database.commit()
            finally:
                database.close()

            result = service.append_message(created['id'], {
                'revision': 1, 'role': 'user', 'status': 'completed',
                'parts': [
                    {'type': 'media', 'assetKey': 'asset-present', 'mediaType': 'image'},
                    {'type': 'media', 'assetKey': 'asset-missing', 'mediaType': 'image'},
                ],
            })
            restored = service.get_conversation(created['id'])['messages'][0]
            self.assertEqual([False, True], [part.get('missing', False) for part in restored['parts']])
            database = sqlite3.connect(database_path)
            try:
                refs = database.execute('''SELECT owner_type, owner_id, asset_key FROM media_asset_refs
                    ORDER BY asset_key''').fetchall()
            finally:
                database.close()
            self.assertEqual([('conversation-message', f"{result['message']['id']}:0", 'asset-present')], refs)
            trashed = service.update_conversation(created['id'], {
                'revision': result['conversationRevision'], 'status': 'trashed'})
            self.assertTrue(service.delete_conversation(created['id'], trashed['revision']))
            database = sqlite3.connect(database_path)
            try:
                remaining_refs = database.execute(
                    "SELECT COUNT(*) FROM media_asset_refs WHERE owner_type='conversation-message'").fetchone()[0]
            finally:
                database.close()
            self.assertEqual(0, remaining_refs)


if __name__ == '__main__':
    unittest.main()
