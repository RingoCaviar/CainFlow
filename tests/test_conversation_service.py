import os
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
