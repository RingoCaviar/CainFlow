import unittest
import os
import tempfile
from types import SimpleNamespace
from unittest import mock

from backend.routes import conversation_routes
from backend.services.conversation_service import ConversationService


def make_handler(path='/api/conversations'):
    return SimpleNamespace(path=path)


class ConversationRouteTests(unittest.TestCase):
    def test_user_can_create_a_conversation_and_receive_its_durable_identity(self):
        handler = make_handler()
        request = {
            'title': '',
            'workflowId': 'workflow-a',
            'defaultModelId': 'model-a',
            'defaultProviderId': 'provider-a',
            'systemPrompt': 'Help with this workflow.',
        }
        created = {
            'id': 'conversation-a',
            'title': '新对话',
            'workflowId': 'workflow-a',
            'defaultModelId': 'model-a',
            'defaultProviderId': 'provider-a',
            'systemPrompt': 'Help with this workflow.',
            'systemPromptVersion': 1,
            'status': 'active',
            'revision': 1,
            'createdAt': 100,
            'updatedAt': 100,
        }

        with mock.patch.object(conversation_routes, 'read_json_body', return_value=request), \
                mock.patch.object(conversation_routes.conversation_service, 'create_conversation', return_value=created) as create, \
                mock.patch.object(conversation_routes, 'write_json') as write_json:
            self.assertTrue(conversation_routes.handle_post(handler))

        create.assert_called_once_with(request)
        write_json.assert_called_once_with(handler, {'conversation': created}, status=201)

    def test_stale_revision_update_returns_conflict_without_overwriting(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            created = service.create_conversation({'title': 'Original'})
            handler = make_handler(f"/api/conversations/{created['id']}")

            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'read_json_body', return_value={
                        'revision': 1, 'title': 'First update'}), \
                    mock.patch.object(conversation_routes, 'write_json'):
                self.assertTrue(conversation_routes.handle_put(handler))

            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'read_json_body', return_value={
                        'revision': 1, 'title': 'Stale update'}), \
                    mock.patch.object(conversation_routes, 'write_error') as write_error:
                self.assertTrue(conversation_routes.handle_put(handler))

            write_error.assert_called_once_with(handler, 409, 'Conversation revision conflict')
            self.assertEqual('First update', service.get_conversation(created['id'])['title'])

    def test_user_can_append_a_versioned_message_and_read_it_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            database_path = os.path.join(root, 'conversations.db')
            service = ConversationService(database_path)
            created = service.create_conversation({'title': 'Draft'})
            handler = make_handler(f"/api/conversations/{created['id']}/messages")
            request = {
                'revision': 1,
                'role': 'user',
                'status': 'completed',
                'parentMessageId': None,
                'parts': [{'type': 'text', 'text': 'Create a quieter image.'}],
            }
            response = {}
            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'read_json_body', return_value=request), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: response.update(value)):
                self.assertTrue(conversation_routes.handle_post(handler))

            restored = ConversationService(database_path).get_conversation(created['id'])
            self.assertEqual(2, response['conversationRevision'])
            self.assertEqual([{
                'id': response['message']['id'],
                'conversationId': created['id'],
                'parentMessageId': None,
                'branchOrdinal': 0,
                'role': 'user',
                'status': 'completed',
                'parts': [{'type': 'text', 'text': 'Create a quieter image.'}],
                'execution': None,
                'createdAt': response['message']['createdAt'],
            }], restored['messages'])

    def test_execution_can_complete_a_pending_assistant_message_in_place(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            created = service.create_conversation({'title': 'Run'})
            pending = service.append_message(created['id'], {
                'revision': 1, 'role': 'assistant', 'status': 'pending',
                'parts': [{'type': 'text', 'text': ''}],
            })
            handler = make_handler(f"/api/conversations/{created['id']}/messages/{pending['message']['id']}")
            request = {
                'revision': 2, 'status': 'completed',
                'parts': [{'type': 'text', 'text': 'Finished'}],
                'execution': {'modelId': 'model-a', 'attempts': [{'ordinal': 1, 'status': 'completed'}]},
            }
            response = {}
            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'read_json_body', return_value=request), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: response.update(value)):
                self.assertTrue(conversation_routes.handle_put(handler))

            self.assertEqual('completed', response['message']['status'])
            self.assertEqual('Finished', response['message']['parts'][0]['text'])
            self.assertEqual(3, response['conversationRevision'])
            restored = service.get_conversation(created['id'])['messages'][0]
            self.assertEqual('model-a', restored['execution']['modelId'])

    def test_conversation_list_filters_status_workflow_and_search(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            wanted = service.create_conversation({'title': 'Quiet product image', 'workflowId': 'workflow-a'})
            other_workflow = service.create_conversation({'title': 'Quiet portrait', 'workflowId': 'workflow-b'})
            archived = service.create_conversation({'title': 'Quiet archived', 'workflowId': 'workflow-a'})
            service.update_conversation(archived['id'], {'revision': 1, 'status': 'archived'})
            handler = make_handler('/api/conversations?status=active&workflowId=workflow-a&search=product')
            response = {}

            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: response.update(value)):
                self.assertTrue(conversation_routes.handle_get(handler))

            self.assertEqual([wanted['id']], [item['id'] for item in response['conversations']])
            self.assertNotIn(other_workflow['id'], [item['id'] for item in response['conversations']])

    def test_permanent_delete_requires_trashed_state_and_current_revision(self):
        with tempfile.TemporaryDirectory() as root:
            service = ConversationService(os.path.join(root, 'conversations.db'))
            created = service.create_conversation({'title': 'Keep until trashed'})
            handler = make_handler(f"/api/conversations/{created['id']}?revision=1")
            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'write_error') as write_error:
                self.assertTrue(conversation_routes.handle_delete(handler))
            write_error.assert_called_once_with(handler, 409, 'Conversation must be trashed before permanent deletion')

            trashed = service.update_conversation(created['id'], {'revision': 1, 'status': 'trashed'})
            handler.path = f"/api/conversations/{created['id']}?revision={trashed['revision']}"
            response = {}
            with mock.patch.object(conversation_routes, 'conversation_service', service), \
                    mock.patch.object(conversation_routes, 'write_json', side_effect=lambda _h, value, **_k: response.update(value)):
                self.assertTrue(conversation_routes.handle_delete(handler))

            self.assertEqual({'success': True}, response)
            self.assertIsNone(service.get_conversation(created['id']))

    def test_invalid_conversation_payload_returns_bad_request(self):
        handler = make_handler()
        with mock.patch.object(conversation_routes, 'read_json_body', return_value={
                'title': ['not text']}), \
                mock.patch.object(conversation_routes, 'write_error') as write_error:
            self.assertTrue(conversation_routes.handle_post(handler))

        write_error.assert_called_once_with(handler, 400, 'title must be text')


if __name__ == '__main__':
    unittest.main()
