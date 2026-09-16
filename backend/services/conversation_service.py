import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

from backend import config
from backend.services.storage_service import SCHEMA_VERSION as MEDIA_SCHEMA_VERSION, StorageService


CONVERSATION_SCHEMA_VERSION = 2
CONVERSATION_PACKAGE_VERSION = 1


class ConversationError(Exception):
    pass


class ConversationConflict(ConversationError):
    pass


class ConversationStateConflict(ConversationError):
    pass


class ConversationService:
    _SENSITIVE_TEXT = re.compile(
        r'(?i)(authorization\s*:|bearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_ -]?key\s*[:=]|'
        r'[A-Za-z]:\\|\\\\[^\\\s]+\\|(?:^|[\s"\'= :])/(?!/)[^\s"\'<>]+)')
    def __init__(self, database_path=None, assets_dir=None):
        self.database_path = database_path or config.DATABASE_PATH
        self.assets_dir = assets_dir or config.ASSETS_DIR
        self._lock = threading.RLock()

    @contextmanager
    def _connect(self):
        directory = os.path.dirname(self.database_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        connection = sqlite3.connect(self.database_path)
        connection.create_function('cainflow_writer_schema_version', 0, lambda: MEDIA_SCHEMA_VERSION)
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
            schema_exists = database.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_schema'").fetchone()
            if schema_exists:
                existing = database.execute(
                    'SELECT version FROM conversation_schema WHERE singleton=1').fetchone()
                if existing and existing['version'] > CONVERSATION_SCHEMA_VERSION:
                    raise ConversationError('Unsupported Conversation schema version')
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
                    context_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
                    ON conversation_messages(conversation_id, created_at, branch_ordinal);
                INSERT OR IGNORE INTO conversation_schema(singleton, version) VALUES(1, 2);
            ''')
            version = database.execute(
                'SELECT version FROM conversation_schema WHERE singleton=1').fetchone()['version']
            if version > CONVERSATION_SCHEMA_VERSION or version < 1:
                raise ConversationError('Unsupported Conversation schema version')
            columns = {row[1] for row in database.execute('PRAGMA table_info(conversation_messages)')}
            if version == 1:
                if 'context_json' not in columns:
                    database.execute('ALTER TABLE conversation_messages ADD COLUMN context_json TEXT')
                database.execute('UPDATE conversation_schema SET version=2 WHERE singleton=1')
                version = 2
            if version == 2 and 'context_json' not in columns:
                raise ConversationError('Conversation schema is incomplete')
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

    @classmethod
    def _safe_record_text(cls, value, limit, field):
        value = cls._clean_text(value, limit, field)
        if cls._SENSITIVE_TEXT.search(value):
            return '[已脱敏]'
        return value

    @classmethod
    def _normalize_parts(cls, value):
        if not isinstance(value, list) or not value:
            raise ConversationError('Message parts are required')
        normalized = []
        for original in value:
            if not isinstance(original, dict) or original.get('type') not in {'text', 'media', 'node-source'}:
                raise ConversationError('Unknown message part')
            part_type = original['type']
            if part_type == 'text':
                normalized.append({'type': 'text', 'text': cls._safe_record_text(
                    original.get('text'), 200000, 'message text')})
                continue
            if part_type == 'media':
                part = {
                    'type': 'media',
                    'assetKey': cls._safe_record_text(original.get('assetKey'), 256, 'assetKey'),
                    'mediaType': cls._safe_record_text(original.get('mediaType'), 24, 'mediaType') or 'image',
                }
            else:
                part = {
                    'type': 'node-source',
                    'workflowId': cls._safe_record_text(original.get('workflowId'), 128, 'workflowId'),
                    'nodeId': cls._safe_record_text(original.get('nodeId'), 128, 'nodeId'),
                    'nodeType': cls._safe_record_text(original.get('nodeType'), 128, 'nodeType'),
                    'textSnapshot': cls._safe_record_text(
                        original.get('textSnapshot'), 200000, 'textSnapshot'),
                    'mediaAssetKeys': [cls._safe_record_text(key, 256, 'mediaAssetKey')
                                       for key in original.get('mediaAssetKeys', [])]
                    if isinstance(original.get('mediaAssetKeys', []), list) else [],
                }
            if original.get('missing'):
                part['missing'] = True
            if isinstance(original.get('missingAssetKeys'), list):
                part['missingAssetKeys'] = [cls._safe_record_text(
                    key, 256, 'missingAssetKey')
                    for key in original['missingAssetKeys']]
            normalized.append(part)
        return normalized

    @classmethod
    def _normalize_execution(cls, value):
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ConversationError('execution must be an object')
        result = {}
        for field, limit in {
                'modelId': 256, 'modelName': 256, 'providerId': 128,
                'providerName': 256, 'status': 32}.items():
            if field in value:
                result[field] = cls._safe_record_text(value.get(field), limit, field)
        if 'systemPromptVersion' in value:
            result['systemPromptVersion'] = int(value['systemPromptVersion'])
        projection = value.get('contextProjection')
        if isinstance(projection, dict):
            result['contextProjection'] = {
                key: int(projection[key]) for key in (
                    'durableMessageCount', 'projectedMessageCount', 'omittedMessageCount',
                    'characterCount', 'limit') if key in projection
            }
        attempts = []
        for original in value.get('attempts', []) if isinstance(value.get('attempts', []), list) else []:
            if not isinstance(original, dict):
                continue
            attempt = {key: int(original[key]) for key in ('ordinal', 'startedAt', 'finishedAt') if key in original}
            if 'status' in original:
                attempt['status'] = cls._safe_record_text(original['status'], 32, 'attempt status')
            if 'diagnosticId' in original:
                attempt['diagnosticId'] = cls._safe_record_text(
                    original['diagnosticId'], 128, 'diagnosticId')
            error = original.get('error')
            if isinstance(error, dict):
                attempt['error'] = {
                    'code': cls._safe_record_text(error.get('code'), 128, 'error code'),
                    'summary': cls._safe_record_text(
                        error.get('summary', error.get('message')), 500, 'error summary'),
                }
            attempts.append(attempt)
        result['attempts'] = attempts
        return result

    @classmethod
    def _normalize_context(cls, value):
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ConversationError('context must be an object')
        summary = value.get('workflowSummary')
        if not isinstance(summary, dict):
            return None
        node_types = summary.get('nodeTypes', [])
        connections = summary.get('connections', [])
        if not isinstance(node_types, list) or not isinstance(connections, list):
            raise ConversationError('Workflow context lists are invalid')
        try:
            revision = int(summary.get('revision') or 0)
        except (TypeError, ValueError):
            raise ConversationError('Workflow context revision is invalid') from None
        return {'workflowSummary': {
            'workflowId': cls._safe_record_text(summary.get('workflowId'), 128, 'workflowId'),
            'revision': revision,
            'nodeTypes': [cls._safe_record_text(item, 128, 'nodeType')
                          for item in node_types[:100]],
            'connections': [cls._safe_record_text(item, 300, 'connection')
                            for item in connections[:500]],
        }}

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

    def _bind_message_media(self, database, message_id, parts, now):
        tables = {row[0] for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('assets', 'media_asset_refs')")}
        if tables != {'assets', 'media_asset_refs'}:
            return parts
        normalized = []
        for part_index, original_part in enumerate(parts):
            part = dict(original_part)
            part.pop('missing', None)
            part.pop('missingAssetKeys', None)
            asset_keys = []
            if part.get('type') == 'media' and part.get('assetKey'):
                asset_keys = [str(part['assetKey'])]
            elif part.get('type') == 'node-source' and isinstance(part.get('mediaAssetKeys'), list):
                asset_keys = [str(key) for key in part['mediaAssetKeys'] if key]
            missing_keys = []
            for asset_key in asset_keys:
                asset = database.execute(
                    'SELECT * FROM assets WHERE asset_key=?', (asset_key,)).fetchone()
                if not asset:
                    missing_keys.append(asset_key)
                    continue
                if 'relative_path' in asset.keys():
                    storage = StorageService(database_path=self.database_path, assets_dir=self.assets_dir)
                    storage._restore_before_reference(database, asset_key)
                    path = os.path.realpath(os.path.join(
                        self.assets_dir, *str(asset['relative_path']).split('/')))
                    root = os.path.realpath(self.assets_dir)
                    if (not path.startswith(root + os.sep) or os.path.islink(path)
                            or not os.path.isfile(path)):
                        missing_keys.append(asset_key)
                database.execute('''INSERT OR IGNORE INTO media_asset_refs(
                    owner_type, owner_id, asset_key, created_at) VALUES('conversation-message', ?, ?, ?)''',
                    (f'{message_id}:{part_index}', asset_key, now))
            if missing_keys:
                part['missing'] = True
                part['missingAssetKeys'] = missing_keys
            normalized.append(part)
        return normalized

    @staticmethod
    def _release_superseded_message_media(database, message_id, parts):
        desired = set()
        for part_index, part in enumerate(parts):
            keys = [part.get('assetKey')] if part.get('type') == 'media' else part.get('mediaAssetKeys', [])
            desired.update((f'{message_id}:{part_index}', str(key)) for key in keys if key)
        rows = database.execute('''SELECT owner_id, asset_key FROM media_asset_refs
            WHERE owner_type='conversation-message' AND owner_id LIKE ?''',
            (f'{message_id}:%',)).fetchall()
        for row in rows:
            if (row['owner_id'], row['asset_key']) not in desired:
                database.execute('''DELETE FROM media_asset_refs
                    WHERE owner_type='conversation-message' AND owner_id=? AND asset_key=?''',
                    (row['owner_id'], row['asset_key']))

    def create_conversation(self, data):
        if not isinstance(data, dict):
            raise ConversationError('Conversation payload must be an object')
        self._initialize()
        now = int(time.time() * 1000)
        conversation_id = str(uuid.uuid4())
        title = self._safe_record_text(data.get('title'), 120, 'title') or '新对话'
        workflow_id = self._safe_record_text(data.get('workflowId'), 128, 'workflowId') or None
        model_id = self._safe_record_text(data.get('defaultModelId'), 256, 'defaultModelId')
        provider_id = self._safe_record_text(data.get('defaultProviderId'), 128, 'defaultProviderId')
        system_prompt = self._safe_record_text(data.get('systemPrompt'), 20000, 'systemPrompt')
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
            **({'context': json.loads(item['context_json'])} if item['context_json'] else {}),
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

    def export_package(self, conversation_id):
        conversation = self.get_conversation(conversation_id)
        if not conversation:
            return None
        references = []
        for message in conversation.get('messages', []):
            for part in message.get('parts', []):
                keys = [part.get('assetKey')] if part.get('type') == 'media' \
                    else part.get('mediaAssetKeys', [])
                references.extend(str(key) for key in keys if key)
        return {
            'format': 'cainflow-conversation',
            'version': CONVERSATION_PACKAGE_VERSION,
            'conversation': conversation,
            'mediaReferences': sorted(set(references)),
            'media': [],
        }

    @classmethod
    def validate_import_package(cls, package, maximum_bytes=5_000_000):
        if not isinstance(package, dict):
            raise ConversationError('Conversation package must be an object')
        if package.get('format') != 'cainflow-conversation' or package.get('version') != CONVERSATION_PACKAGE_VERSION:
            raise ConversationError('Unsupported Conversation package')
        encoded = json.dumps(package, ensure_ascii=False).encode('utf-8')
        if len(encoded) > maximum_bytes:
            raise ConversationError('Conversation package is too large')
        if cls._SENSITIVE_TEXT.search(encoded.decode('utf-8')):
            raise ConversationError('Conversation package contains a local path or credential')
        references = package.get('mediaReferences', [])
        if not isinstance(references, list) or any(
                not isinstance(key, str) or not key or len(key) > 256 for key in references):
            raise ConversationError('Invalid Conversation media reference manifest')
        media = package.get('media', [])
        if not isinstance(media, list):
            raise ConversationError('Invalid Conversation media payload')
        allowed_mime = {'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'}
        for item in media:
            if not isinstance(item, dict) or item.get('assetKey') not in references:
                raise ConversationError('Conversation media is not declared in the manifest')
            if item.get('mimeType') not in allowed_mime:
                raise ConversationError('Unsupported Conversation media MIME type')
            if any(field in item for field in ('path', 'filePath', 'absolutePath')):
                raise ConversationError('Conversation media paths are not accepted')
        return package

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
            value = self._safe_record_text(data.get(input_name), limit, input_name)
            if not nullable and not value:
                raise ConversationError(f'{input_name} is required')
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
        parts = self._normalize_parts(data.get('parts'))
        parent_message_id = data.get('parentMessageId') or None
        if parent_message_id is not None:
            parent_message_id = self._clean_text(
                parent_message_id, 128, 'parentMessageId', allow_empty=False)
        execution = self._normalize_execution(data.get('execution'))
        context = self._normalize_context(data.get('context'))
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
                parts_json, execution_json, context_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
                message_id, conversation_id, parent_message_id, branch_ordinal, role, status,
                json.dumps(parts, ensure_ascii=False, separators=(',', ':')),
                json.dumps(execution, ensure_ascii=False, separators=(',', ':')) if execution else None,
                json.dumps(context, ensure_ascii=False, separators=(',', ':')) if context else None,
                now))
            database.execute('''UPDATE conversations SET revision=revision+1, updated_at=?
                WHERE id=?''', (now, conversation_id))
        message = {
            'id': message_id, 'conversationId': conversation_id,
            'parentMessageId': parent_message_id, 'branchOrdinal': branch_ordinal,
            'role': role, 'status': status, 'parts': parts,
            'execution': execution, 'createdAt': now,
        }
        if context:
            message['context'] = context
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
        parts = self._normalize_parts(data.get('parts'))
        execution = self._normalize_execution(data.get('execution'))
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
            if message['status'] not in {'pending', 'streaming'}:
                raise ConversationStateConflict('Terminal Conversation messages are immutable')
            if status == 'pending' and message['status'] == 'streaming':
                raise ConversationStateConflict('Message status cannot move backwards')
            parts = self._bind_message_media(database, message_id, parts, now)
            tables = {row[0] for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='media_asset_refs'")}
            if tables:
                self._release_superseded_message_media(database, message_id, parts)
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

    def resolve_message_media(self, conversation_id, message_id, data):
        self._initialize()
        if not isinstance(data, dict):
            raise ConversationError('Media action payload must be an object')
        conversation_id = self._clean_text(conversation_id, 128, 'conversationId', allow_empty=False)
        message_id = self._clean_text(message_id, 128, 'messageId', allow_empty=False)
        try:
            expected_revision = int(data.get('revision'))
            part_index = int(data.get('partIndex'))
        except (TypeError, ValueError):
            raise ConversationError('revision and partIndex are required') from None
        asset_key = self._safe_record_text(data.get('assetKey'), 256, 'assetKey')
        action = self._clean_text(data.get('action'), 16, 'action', allow_empty=False)
        if action not in {'remove', 'recover'}:
            raise ConversationError('Unknown media action')
        now = int(time.time() * 1000)
        with self._lock, self._connect() as database:
            conversation = database.execute(
                'SELECT revision FROM conversations WHERE id=?', (conversation_id,)).fetchone()
            if not conversation:
                return None
            if conversation['revision'] != expected_revision:
                raise ConversationConflict('Conversation revision conflict')
            row = database.execute('''SELECT * FROM conversation_messages
                WHERE id=? AND conversation_id=?''', (message_id, conversation_id)).fetchone()
            if not row:
                return None
            parts = json.loads(row['parts_json'])
            if part_index < 0 or part_index >= len(parts):
                raise ConversationError('Unknown message part position')
            part = parts[part_index]
            keys = [part.get('assetKey')] if part.get('type') == 'media' else part.get('mediaAssetKeys', [])
            if asset_key not in keys:
                raise ConversationError('Media asset is not in this message part')
            if action == 'remove':
                if part.get('type') == 'media':
                    parts.pop(part_index)
                else:
                    part['mediaAssetKeys'] = [key for key in keys if key != asset_key]
                    part['missingAssetKeys'] = [key for key in part.get('missingAssetKeys', []) if key != asset_key]
                    if not part['missingAssetKeys']:
                        part.pop('missing', None)
                        part.pop('missingAssetKeys', None)
            else:
                candidate = self._bind_message_media(database, message_id, [part], now)[0]
                if asset_key in candidate.get('missingAssetKeys', []):
                    raise ConversationStateConflict('Media asset is still unavailable')
                parts[part_index] = candidate
            if not parts:
                parts = [{'type': 'text', 'text': ''}]
            parts = self._normalize_parts(parts)
            parts = self._bind_message_media(database, message_id, parts, now)
            self._release_superseded_message_media(database, message_id, parts)
            database.execute('UPDATE conversation_messages SET parts_json=? WHERE id=?', (
                json.dumps(parts, ensure_ascii=False, separators=(',', ':')), message_id))
            database.execute('''UPDATE conversations SET revision=revision+1, updated_at=?
                WHERE id=?''', (now, conversation_id))
        return {'conversationRevision': expected_revision + 1, 'messageId': message_id, 'parts': parts}

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
