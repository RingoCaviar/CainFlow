import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

from backend import config


CONVERSATION_SCHEMA_VERSION = 1


class ConversationError(Exception):
    pass


class ConversationConflict(ConversationError):
    pass


class ConversationStateConflict(ConversationError):
    pass


class ConversationService:
    def __init__(self, database_path=None):
        self.database_path = database_path or config.DATABASE_PATH
        self._lock = threading.RLock()

    @contextmanager
    def _connect(self):
        directory = os.path.dirname(self.database_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self._lock, self._connect() as database:
            database.executescript('''
                CREATE TABLE IF NOT EXISTS conversation_schema (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    version INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    workflow_id TEXT,
                    default_model_id TEXT NOT NULL,
                    default_provider_id TEXT NOT NULL,
                    system_prompt TEXT NOT NULL,
                    system_prompt_version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    parent_message_id TEXT,
                    branch_ordinal INTEGER NOT NULL DEFAULT 0,
                    role TEXT NOT NULL,
                    status TEXT NOT NULL,
                    parts_json TEXT NOT NULL,
                    execution_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
                    ON conversation_messages(conversation_id, created_at, branch_ordinal);
                INSERT OR IGNORE INTO conversation_schema(singleton, version) VALUES(1, 1);
            ''')
            version = database.execute(
                'SELECT version FROM conversation_schema WHERE singleton=1').fetchone()['version']
            if version != CONVERSATION_SCHEMA_VERSION:
                raise ConversationError('Unsupported Conversation schema version')

    @staticmethod
    def _clean_text(value, limit, field, allow_empty=True):
        if value is None:
            return ''
        if not isinstance(value, str):
            raise ConversationError(f'{field} must be text')
        value = value.strip()
        if not allow_empty and not value:
            raise ConversationError(f'{field} is required')
        if len(value) > limit:
            raise ConversationError(f'{field} is too long')
        return value

    @staticmethod
    def _serialize(row, messages=None):
        result = {
            'id': row['id'], 'title': row['title'], 'workflowId': row['workflow_id'],
            'defaultModelId': row['default_model_id'], 'defaultProviderId': row['default_provider_id'],
            'systemPrompt': row['system_prompt'], 'systemPromptVersion': row['system_prompt_version'],
            'status': row['status'], 'revision': row['revision'],
            'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
        }
        if messages is not None:
            result['messages'] = messages
        return result

    @staticmethod
    def _bind_message_media(database, message_id, parts, now):
        tables = {row[0] for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('assets', 'media_asset_refs')")}
        if tables != {'assets', 'media_asset_refs'}:
            return parts
        normalized = []
        for part_index, original_part in enumerate(parts):
            part = dict(original_part)
            asset_keys = []
            if part.get('type') == 'media' and part.get('assetKey'):
                asset_keys = [str(part['assetKey'])]
            elif part.get('type') == 'node-source' and isinstance(part.get('mediaAssetKeys'), list):
                asset_keys = [str(key) for key in part['mediaAssetKeys'] if key]
            missing_keys = []
            for asset_key in asset_keys:
                exists = database.execute(
                    'SELECT 1 FROM assets WHERE asset_key=?', (asset_key,)).fetchone()
                if not exists:
                    missing_keys.append(asset_key)
                    continue
                database.execute('''INSERT OR IGNORE INTO media_asset_refs(
                    owner_type, owner_id, asset_key, created_at) VALUES('conversation-message', ?, ?, ?)''',
                    (f'{message_id}:{part_index}', asset_key, now))
            if missing_keys:
                part['missing'] = True
                part['missingAssetKeys'] = missing_keys
            normalized.append(part)
        return normalized

    def create_conversation(self, data):
        if not isinstance(data, dict):
            raise ConversationError('Conversation payload must be an object')
        self._initialize()
        now = int(time.time() * 1000)
        conversation_id = str(uuid.uuid4())
        title = self._clean_text(data.get('title'), 120, 'title') or '新对话'
        workflow_id = self._clean_text(data.get('workflowId'), 128, 'workflowId') or None
        model_id = self._clean_text(data.get('defaultModelId'), 256, 'defaultModelId')
        provider_id = self._clean_text(data.get('defaultProviderId'), 128, 'defaultProviderId')
        system_prompt = self._clean_text(data.get('systemPrompt'), 20000, 'systemPrompt')
        with self._lock, self._connect() as database:
            database.execute('''INSERT INTO conversations(
                id, title, workflow_id, default_model_id, default_provider_id, system_prompt,
                system_prompt_version, status, revision, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, 1, 'active', 1, ?, ?)''', (
                conversation_id, title, workflow_id, model_id, provider_id, system_prompt, now, now))
            row = database.execute('SELECT * FROM conversations WHERE id=?', (conversation_id,)).fetchone()
        return self._serialize(row)

    def get_conversation(self, conversation_id):
        self._initialize()
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        with self._connect() as database:
            row = database.execute('SELECT * FROM conversations WHERE id=?', (conversation_id,)).fetchone()
            if not row:
                return None
            message_rows = database.execute('''SELECT * FROM conversation_messages
                WHERE conversation_id=? ORDER BY created_at, branch_ordinal''', (conversation_id,)).fetchall()
        messages = [{
            'id': item['id'], 'conversationId': item['conversation_id'],
            'parentMessageId': item['parent_message_id'], 'branchOrdinal': item['branch_ordinal'],
            'role': item['role'], 'status': item['status'], 'parts': json.loads(item['parts_json']),
            'execution': json.loads(item['execution_json']) if item['execution_json'] else None,
            'createdAt': item['created_at'],
        } for item in message_rows]
        return self._serialize(row, messages)

    def list_conversations(self, status='active', workflow_id='', search=''):
        self._initialize()
        status = self._clean_text(status, 16, 'status', allow_empty=False)
        if status not in {'active', 'archived', 'trashed'}:
            raise ConversationError('Unknown Conversation status')
        workflow_id = self._clean_text(workflow_id, 128, 'workflowId')
        search = self._clean_text(search, 120, 'search')
        clauses = ['status=?']
        values = [status]
        if workflow_id:
            clauses.append('workflow_id=?')
            values.append(workflow_id)
        if search:
            clauses.append('title LIKE ? ESCAPE \'\\\'')
            escaped = search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            values.append(f'%{escaped}%')
        query = f'''SELECT * FROM conversations WHERE {' AND '.join(clauses)}
            ORDER BY updated_at DESC, id DESC'''
        with self._connect() as database:
            rows = database.execute(query, values).fetchall()
        return [self._serialize(row) for row in rows]

    def update_conversation(self, conversation_id, data):
        self._initialize()
        if not isinstance(data, dict):
            raise ConversationError('Conversation payload must be an object')
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        try:
            expected_revision = int(data.get('revision'))
        except (TypeError, ValueError):
            raise ConversationError('revision is required') from None
        fields = {}
        definitions = {
            'title': ('title', 120, False),
            'workflowId': ('workflow_id', 128, True),
            'defaultModelId': ('default_model_id', 256, True),
            'defaultProviderId': ('default_provider_id', 128, True),
            'systemPrompt': ('system_prompt', 20000, True),
        }
        for input_name, (column, limit, nullable) in definitions.items():
            if input_name not in data:
                continue
            value = self._clean_text(data.get(input_name), limit, input_name, allow_empty=nullable)
            fields[column] = None if input_name == 'workflowId' and not value else value
        if 'status' in data:
            status = self._clean_text(data.get('status'), 16, 'status', allow_empty=False)
            if status not in {'active', 'archived', 'trashed'}:
                raise ConversationError('Unknown Conversation status')
            fields['status'] = status
        if not fields:
            raise ConversationError('Conversation update is empty')
        now = int(time.time() * 1000)
        assignments = ', '.join(f'{column}=?' for column in fields)
        values = list(fields.values())
        system_prompt_increment = ', system_prompt_version=system_prompt_version+1' \
            if 'system_prompt' in fields else ''
        with self._lock, self._connect() as database:
            cursor = database.execute(f'''UPDATE conversations SET {assignments}{system_prompt_increment},
                revision=revision+1, updated_at=? WHERE id=? AND revision=?''',
                (*values, now, conversation_id, expected_revision))
            if cursor.rowcount != 1:
                exists = database.execute(
                    'SELECT 1 FROM conversations WHERE id=?', (conversation_id,)).fetchone()
                if exists:
                    raise ConversationConflict('Conversation revision conflict')
                return None
            row = database.execute('SELECT * FROM conversations WHERE id=?', (conversation_id,)).fetchone()
        return self._serialize(row)

    def append_message(self, conversation_id, data):
        self._initialize()
        if not isinstance(data, dict):
            raise ConversationError('Message payload must be an object')
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        try:
            expected_revision = int(data.get('revision'))
        except (TypeError, ValueError):
            raise ConversationError('revision is required') from None
        role = self._clean_text(data.get('role'), 16, 'role', allow_empty=False)
        if role not in {'system', 'user', 'assistant'}:
            raise ConversationError('Unknown message role')
        status = self._clean_text(data.get('status'), 24, 'status', allow_empty=False)
        if status not in {'pending', 'streaming', 'completed', 'partial', 'failed', 'cancelled'}:
            raise ConversationError('Unknown message status')
        parts = data.get('parts')
        if not isinstance(parts, list) or not parts:
            raise ConversationError('Message parts are required')
        for part in parts:
            if not isinstance(part, dict) or part.get('type') not in {'text', 'media', 'node-source'}:
                raise ConversationError('Unknown message part')
            if part.get('type') == 'text':
                self._clean_text(part.get('text'), 200000, 'message text')
        parent_message_id = data.get('parentMessageId') or None
        if parent_message_id is not None:
            parent_message_id = self._clean_text(
                parent_message_id, 128, 'parentMessageId', allow_empty=False)
        execution = data.get('execution')
        if execution is not None and not isinstance(execution, dict):
            raise ConversationError('execution must be an object')
        message_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        with self._lock, self._connect() as database:
            conversation = database.execute(
                'SELECT revision FROM conversations WHERE id=?', (conversation_id,)).fetchone()
            if not conversation:
                return None
            if conversation['revision'] != expected_revision:
                raise ConversationConflict('Conversation revision conflict')
            if parent_message_id:
                parent = database.execute('''SELECT 1 FROM conversation_messages
                    WHERE id=? AND conversation_id=?''', (parent_message_id, conversation_id)).fetchone()
                if not parent:
                    raise ConversationError('Parent message is not in this Conversation')
            branch_ordinal = database.execute('''SELECT COUNT(*) FROM conversation_messages
                WHERE conversation_id=? AND parent_message_id IS ?''',
                (conversation_id, parent_message_id)).fetchone()[0]
            parts = self._bind_message_media(database, message_id, parts, now)
            database.execute('''INSERT INTO conversation_messages(
                id, conversation_id, parent_message_id, branch_ordinal, role, status,
                parts_json, execution_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
                message_id, conversation_id, parent_message_id, branch_ordinal, role, status,
                json.dumps(parts, ensure_ascii=False, separators=(',', ':')),
                json.dumps(execution, ensure_ascii=False, separators=(',', ':')) if execution else None,
                now))
            database.execute('''UPDATE conversations SET revision=revision+1, updated_at=?
                WHERE id=?''', (now, conversation_id))
        message = {
            'id': message_id, 'conversationId': conversation_id,
            'parentMessageId': parent_message_id, 'branchOrdinal': branch_ordinal,
            'role': role, 'status': status, 'parts': parts,
            'execution': execution, 'createdAt': now,
        }
        return {'message': message, 'conversationRevision': expected_revision + 1}

    def update_message(self, conversation_id, message_id, data):
        self._initialize()
        if not isinstance(data, dict):
            raise ConversationError('Message payload must be an object')
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        message_id = self._clean_text(message_id, 128, 'messageId', allow_empty=False)
        try:
            expected_revision = int(data.get('revision'))
        except (TypeError, ValueError):
            raise ConversationError('revision is required') from None
        status = self._clean_text(data.get('status'), 24, 'status', allow_empty=False)
        if status not in {'pending', 'streaming', 'completed', 'partial', 'failed', 'cancelled'}:
            raise ConversationError('Unknown message status')
        parts = data.get('parts')
        if not isinstance(parts, list) or not parts:
            raise ConversationError('Message parts are required')
        for part in parts:
            if not isinstance(part, dict) or part.get('type') not in {'text', 'media', 'node-source'}:
                raise ConversationError('Unknown message part')
            if part.get('type') == 'text':
                self._clean_text(part.get('text'), 200000, 'message text')
        execution = data.get('execution')
        if execution is not None and not isinstance(execution, dict):
            raise ConversationError('execution must be an object')
        now = int(time.time() * 1000)
        with self._lock, self._connect() as database:
            conversation = database.execute(
                'SELECT revision FROM conversations WHERE id=?', (conversation_id,)).fetchone()
            if not conversation:
                return None
            if conversation['revision'] != expected_revision:
                raise ConversationConflict('Conversation revision conflict')
            message = database.execute('''SELECT * FROM conversation_messages
                WHERE id=? AND conversation_id=?''', (message_id, conversation_id)).fetchone()
            if not message:
                return None
            database.execute('''UPDATE conversation_messages SET status=?, parts_json=?, execution_json=?
                WHERE id=? AND conversation_id=?''', (
                status, json.dumps(parts, ensure_ascii=False, separators=(',', ':')),
                json.dumps(execution, ensure_ascii=False, separators=(',', ':')) if execution else None,
                message_id, conversation_id))
            database.execute('''UPDATE conversations SET revision=revision+1, updated_at=? WHERE id=?''',
                (now, conversation_id))
        result = {
            'id': message_id, 'conversationId': conversation_id,
            'parentMessageId': message['parent_message_id'], 'branchOrdinal': message['branch_ordinal'],
            'role': message['role'], 'status': status, 'parts': parts,
            'execution': execution, 'createdAt': message['created_at'],
        }
        return {'message': result, 'conversationRevision': expected_revision + 1}

    def delete_conversation(self, conversation_id, expected_revision):
        self._initialize()
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        try:
            expected_revision = int(expected_revision)
        except (TypeError, ValueError):
            raise ConversationError('revision is required') from None
        with self._lock, self._connect() as database:
            row = database.execute('''SELECT status, revision FROM conversations
                WHERE id=?''', (conversation_id,)).fetchone()
            if not row:
                return False
            if row['revision'] != expected_revision:
                raise ConversationConflict('Conversation revision conflict')
            if row['status'] != 'trashed':
                raise ConversationStateConflict(
                    'Conversation must be trashed before permanent deletion')
            message_ids = [item[0] for item in database.execute(
                'SELECT id FROM conversation_messages WHERE conversation_id=?', (conversation_id,)).fetchall()]
            database.execute('DELETE FROM conversations WHERE id=?', (conversation_id,))
            has_refs = database.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_asset_refs'").fetchone()
            if has_refs:
                for message_id in message_ids:
                    database.execute('''DELETE FROM media_asset_refs
                        WHERE owner_type='conversation-message' AND owner_id LIKE ?''',
                        (f'{message_id}:%',))
        return True


conversation_service = ConversationService()
