import os
import tempfile
import unittest
import sqlite3
from unittest import mock

from backend.services.conversation_service import ConversationService
from backend.services.storage_service import StorageService
from backend.routes import conversation_routes


class ConversationServiceTests(unittest.TestCase):
    def test_v1_schema_upgrade_is_idempotent_and_future_writers_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'conversation.db')
            service = ConversationService(path)
            service.create_conversation({'title': 'upgrade'})
            database = sqlite3.connect(path)
            database.execute('UPDATE conversation_schema SET version=1')
            database.commit()
            database.close()
            self.assertEqual(1, len(service.list_conversations()))
            database = sqlite3.connect(path)
            self.assertEqual(2, database.execute('SELECT version FROM conversation_schema').fetchone()[0])
            database.execute('UPDATE conversation_schema SET version=3')
            database.commit()
            database.close()
            with self.assertRaisesRegex(Exception, 'Unsupported'):
                service.list_conversations()
            future_path = os.path.join(root, 'future.db')
            future = sqlite3.connect(future_path)
            future.execute('CREATE TABLE conversation_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)')
            future.execute('INSERT INTO conversation_schema VALUES(1, 3)')
            future.commit()
            future.close()
            with self.assertRaisesRegex(Exception, 'Unsupported'):
                ConversationService(future_path).list_conversations()
            future = sqlite3.connect(future_path)
            self.assertIsNone(future.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'").fetchone())
            future.close()

    def test_terminal_messages_are_immutable_and_records_are_redacted(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            created = service.create_conversation({'title': 'Safety'})
            pending = service.append_message(created['id'], {
                'revision': 1, 'role': 'assistant', 'status': 'pending',
                'parts': [{'type': 'text', 'text': ''}],
            })
            completed = service.update_message(created['id'], pending['message']['id'], {
                'revision': pending['conversationRevision'], 'status': 'completed',
                'parts': [{'type': 'text', 'text': r'Authorization: Bearer super-secret C:\Users\vivi\token'}],
                'execution': {'attempts': [{'ordinal': 1, 'status': 'failed', 'error': {
                    'code': 'auth', 'message': r'C:\Users\vivi\token'}}]},
            })
            self.assertEqual('[已脱敏]', completed['message']['parts'][0]['text'])
            self.assertEqual('[已脱敏]', completed['message']['execution']['attempts'][0]['error']['summary'])
            with self.assertRaisesRegex(Exception, 'immutable'):
                service.update_message(created['id'], pending['message']['id'], {
                    'revision': completed['conversationRevision'], 'status': 'completed',
                    'parts': [{'type': 'text', 'text': 'overwrite'}],
                })

    def test_export_boundary_has_a_versioned_manifest_and_rejects_untrusted_paths(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            created = service.create_conversation({'title': 'Portable'})
            service.append_message(created['id'], {
                'revision': 1, 'role': 'user', 'status': 'completed',
                'parts': [{'type': 'media', 'assetKey': 'sha256-safe', 'mediaType': 'image'}],
            })
            package = service.export_package(created['id'])
            self.assertEqual(('cainflow-conversation', 1), (package['format'], package['version']))
            self.assertEqual(['sha256-safe'], package['mediaReferences'])
            self.assertIs(package, service.validate_import_package(package))
            package['media'] = [{'assetKey': 'sha256-safe', 'mimeType': 'image/png', 'path': r'C:\Users\vivi\x.png'}]
            with self.assertRaisesRegex(Exception, 'path|credential'):
                service.validate_import_package(package)

    def test_record_safety_rejects_posix_and_unc_paths_without_redacting_https_links(self):
        self.assertEqual('[已脱敏]', ConversationService._safe_record_text('/etc/secret', 100, 'value'))
        self.assertEqual('[已脱敏]', ConversationService._safe_record_text(r'\\server\share\secret', 100, 'value'))
        self.assertEqual('https://example.test/docs', ConversationService._safe_record_text(
            'https://example.test/docs', 100, 'value'))

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

    def test_workflow_context_round_trips_and_invalid_context_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversation.db'))
            created = service.create_conversation({'title': 'Context'})
            service.append_message(created['id'], {
                'revision': 1, 'role': 'user', 'status': 'completed',
                'parts': [{'type': 'text', 'text': 'question'}],
                'context': {'workflowSummary': {'workflowId': 'wf', 'revision': 4,
                    'nodeTypes': ['Text'], 'connections': ['a→b']}},
            })
            restored = ConversationService(service.database_path).get_conversation(created['id'])
            self.assertEqual(4, restored['messages'][0]['context']['workflowSummary']['revision'])
            with self.assertRaisesRegex(Exception, 'lists are invalid'):
                service.append_message(created['id'], {
                    'revision': restored['revision'], 'role': 'user', 'status': 'completed',
                    'parts': [{'type': 'text', 'text': 'bad'}],
                    'context': {'workflowSummary': {'workflowId': 'wf', 'nodeTypes': None}},
                })

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

    def test_real_media_store_marks_metadata_without_a_physical_file_missing(self):
        with tempfile.TemporaryDirectory() as root:
            database_path = os.path.join(root, 'store.db')
            assets_dir = os.path.join(root, 'assets')
            storage = StorageService(
                database_path=database_path, assets_dir=assets_dir,
                temp_dir=os.path.join(root, 'tmp'), exports_dir=os.path.join(root, 'exports'))
            storage.initialize()
            storage.put_asset('asset-gone', b'pixels', 'image/png', 'image')
            database = sqlite3.connect(database_path)
            try:
                relative_path = database.execute(
                    "SELECT relative_path FROM assets WHERE asset_key='asset-gone'").fetchone()[0]
            finally:
                database.close()
            os.remove(os.path.join(assets_dir, *relative_path.split('/')))

            service = ConversationService(database_path, assets_dir=assets_dir)
            created = service.create_conversation({'title': 'Missing physical file'})
            result = service.append_message(created['id'], {
                'revision': 1, 'role': 'user', 'status': 'completed',
                'parts': [{'type': 'media', 'assetKey': 'asset-gone', 'mediaType': 'image'}],
            })
            self.assertTrue(result['message']['parts'][0]['missing'])
            database = sqlite3.connect(database_path)
            try:
                self.assertEqual(1, database.execute(
                    "SELECT COUNT(*) FROM media_asset_refs WHERE asset_key='asset-gone'").fetchone()[0])
            finally:
                database.close()
            physical_path = os.path.join(assets_dir, *relative_path.split('/'))
            os.makedirs(os.path.dirname(physical_path), exist_ok=True)
            with open(physical_path, 'wb') as media_file:
                media_file.write(b'pixels')
            recovered = service.resolve_message_media(created['id'], result['message']['id'], {
                'revision': result['conversationRevision'], 'partIndex': 0,
                'assetKey': 'asset-gone', 'action': 'recover',
            })
            self.assertNotIn('missing', recovered['parts'][0])
            removed = service.resolve_message_media(created['id'], result['message']['id'], {
                'revision': recovered['conversationRevision'], 'partIndex': 0,
                'assetKey': 'asset-gone', 'action': 'remove',
            })
            self.assertEqual([{'type': 'text', 'text': ''}], removed['parts'])
            database = sqlite3.connect(database_path)
            try:
                self.assertEqual(0, database.execute(
                    "SELECT COUNT(*) FROM media_asset_refs WHERE asset_key='asset-gone'").fetchone()[0])
            finally:
                database.close()


if __name__ == '__main__':
    unittest.main()
