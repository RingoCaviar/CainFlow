"""Saved Workflow identity access for the local Canvas MCP service."""

import base64
import hashlib
import json
import re
import sqlite3
import uuid
from collections import Counter
from pathlib import Path

from backend import config
from backend.services import workflow_service
from backend.services.canvas_mcp_bridge import CanvasMcpError
from backend.services.security_service import get_safe_path
from backend.services.storage_service import MEDIA_OWNER_NODE_TYPES, StorageError, storage_service


_MEDIA_KEY = re.compile(r'media:[a-zA-Z0-9_-]{1,128}')
_WORKFLOW_NAME_INVALID = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]|\.$')
_WINDOWS_DEVICE_NAME = re.compile(r'^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)', re.IGNORECASE)


def _valid_identity(value):
    return (isinstance(value, str) and 0 < len(value) <= 256 and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def _valid_workflow_id(value):
    return _valid_identity(value) and len(value) <= 128 and '/' not in value and '\\' not in value


def _require_workflow_id(workflow_id):
    if not _valid_workflow_id(workflow_id):
        raise CanvasMcpError(400, 'A saved workflowId is required.', 'invalid_arguments')


def _workflow_files():
    root = Path(config.WORKFLOWS_DIR).resolve()
    for name in workflow_service.list_workflows(root)['workflows']:
        filepath = get_safe_path(name)
        if not filepath:
            continue
        path = Path(filepath)
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
                continue
            body = path.read_bytes()
            document = json.loads(body.decode('utf-8-sig'))
        except (OSError, RuntimeError, UnicodeError, ValueError):
            continue
        if isinstance(document, dict) and _valid_workflow_id(document.get('workflowId')):
            yield name, path, body, document


def _find_workflow(workflow_id):
    result = None
    for saved in _workflow_files():
        if saved[3]['workflowId'] != workflow_id:
            continue
        if result is not None:
            raise CanvasMcpError(409, 'Multiple saved files have this workflowId.', 'ambiguous_workflow')
        result = saved
    if result is None:
        raise CanvasMcpError(404, 'Saved workflow not found.', 'workflow_not_found')
    return result


def _revision(body):
    return hashlib.sha256(body).hexdigest()


def _saved_result(name, body, document):
    return {'workflowId': document['workflowId'], 'name': name, 'document': document, 'revision': _revision(body)}


def list_saved_workflows(offset=0, limit=30):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise CanvasMcpError(400, 'Invalid workflow pagination.', 'invalid_arguments')
    with workflow_service.lock_workflow_files():
        rows = [{'workflowId': document['workflowId'], 'name': name}
                for name, _, _, document in _workflow_files()]
    counts = Counter(row['workflowId'] for row in rows)
    items = [row for row in rows if counts[row['workflowId']] == 1]
    end = offset + limit
    return {'items': items[offset:end], 'nextOffset': end if end < len(items) else None}


def read_saved_workflow(workflow_id):
    _require_workflow_id(workflow_id)
    with workflow_service.lock_workflow_files():
        name, _, body, document = _find_workflow(workflow_id)
    return _saved_result(name, body, document)


def _encode_document(document):
    try:
        return json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError, UnicodeError) as error:
        raise CanvasMcpError(400, 'Saved workflow document must be valid JSON.', 'invalid_arguments') from error


def create_saved_workflow(name=None):
    if name is not None:
        if not isinstance(name, str):
            raise CanvasMcpError(400, 'Invalid workflow name.', 'invalid_arguments')
        name = name.strip()
        if (not name or len(name) > 120 or _WORKFLOW_NAME_INVALID.search(name)
                or _WINDOWS_DEVICE_NAME.match(name)):
            raise CanvasMcpError(400, 'Invalid workflow name.', 'invalid_arguments')

    document = {'workflowId': str(uuid.uuid4()), 'mediaOwnershipRevision': 1,
                'version': '1.3', 'canvas': {'x': 0, 'y': 0, 'zoom': 1}, 'nodes': [], 'connections': []}
    body = _encode_document(document)

    def create():
        storage_service.assert_storage_writable()
        with workflow_service.lock_workflow_files():
            existing = {item.rsplit('/', 1)[-1].casefold()
                        for item in workflow_service.list_workflows(config.WORKFLOWS_DIR)['workflows']}
            label = name
            if label is None:
                label = '未命名工作流'
                index = 1
                while label.casefold() in existing:
                    label = f'未命名工作流 {index}'
                    index += 1
            path = Path(get_safe_path(label))
            if label.casefold() in existing or path.exists() or path.is_symlink():
                raise CanvasMcpError(409, 'A workflow with this name already exists.', 'workflow_name_conflict')
            workflow_service._atomic_write_workflow(path, body)
            return _saved_result(label, body, document)

    return storage_service.run_at_storage_epoch(None, create)


def load_workflow_media(asset_key):
    if not isinstance(asset_key, str) or not _MEDIA_KEY.fullmatch(asset_key):
        raise CanvasMcpError(400, 'A managed Media asset key is required.', 'invalid_arguments')
    result = storage_service.get_asset(asset_key)
    if not result:
        raise CanvasMcpError(404, 'The referenced Media asset is missing.', 'media_unavailable')
    info, body = result
    return f"data:{info['mime_type']};base64,{base64.b64encode(body).decode('ascii')}"


def workflow_media_exists(asset_key):
    return isinstance(asset_key, str) and bool(_MEDIA_KEY.fullmatch(asset_key)
                                              and storage_service.get_asset(asset_key, read_body=False))


def stage_workflow_media(workflow_id, node_id, values):
    _require_workflow_id(workflow_id)
    if not _valid_identity(node_id):
        raise CanvasMcpError(400, 'A node ID is required to store a result.', 'invalid_arguments')
    owner_id = json.dumps([workflow_id, node_id, str(uuid.uuid4())], ensure_ascii=False, separators=(',', ':'))
    assets = storage_service.put_media_asset_list(values, 'workflow-operation', owner_id)
    return {'ownerId': owner_id, 'assetKeys': [asset['asset_key'] for asset in assets]}


def cancel_workflow_media(owner_id):
    return storage_service.cancel_media_operation_owner(owner_id)


def _owner_identity(node):
    owner_type = {'ImageImport': 'workflow-import', 'PromptAgentResult': 'prompt-agent-result'}.get(
        node.get('type'), 'workflow-node')
    return owner_type, node.get('id')


def _saved_media_keys(node):
    data = node.get('data') if isinstance(node.get('data'), dict) else {}
    keys = storage_service._workflow_node_owned_keys(node)
    if not keys:
        import_key = node.get('imageImportAssetKey') or data.get('imageImportAssetKey')
        if isinstance(import_key, str) and import_key.startswith('media:'):
            keys.append(import_key)
    videos = data.get('videos', node.get('videos'))
    single = data.get('video', node.get('video'))
    if isinstance(videos, list) and videos:
        video_keys = [item.get('assetKey') for item in videos if isinstance(item, dict)]
    else:
        video_keys = [(single.get('assetKey') if isinstance(single, dict) else None)
                      or data.get('videoAssetKey') or node.get('videoAssetKey')]
    available, required = Counter(keys), Counter()
    for key in video_keys:
        if not isinstance(key, str) or not key.startswith('media:'):
            continue
        required[key] += 1
        if required[key] > available[key]:
            keys.append(key)
    return keys


def _owner_manifest(document, owner_lists):
    consumers = {_owner_identity(node): node for node in storage_service._workflow_media_consumers(document)
                 if isinstance(node, dict) and _valid_identity(node.get('id'))}
    if owner_lists is None:
        owner_lists = []
        for (owner_type, owner_id), node in consumers.items():
            keys = _saved_media_keys(node)
            if keys or node.get('type') in MEDIA_OWNER_NODE_TYPES | {'VideoGenerate'} or owner_type == 'prompt-agent-result':
                owner_lists.append({'ownerType': owner_type, 'ownerId': owner_id, 'assetKeys': keys})
    if not isinstance(owner_lists, list):
        raise CanvasMcpError(400, 'Invalid Media asset ownership manifest.', 'invalid_arguments')
    valid = set()
    for owner in owner_lists:
        identity = (owner.get('ownerType'), owner.get('ownerId')) if isinstance(owner, dict) else (None, None)
        keys = owner.get('assetKeys') if isinstance(owner, dict) else None
        if (not all(isinstance(value, str) for value in identity) or identity not in consumers or identity in valid
                or not isinstance(keys, list) or any(not isinstance(key, str) or not _MEDIA_KEY.fullmatch(key) for key in keys)):
            raise CanvasMcpError(400, 'Invalid Media asset ownership manifest.', 'invalid_arguments')
        valid.add(identity)
    return [dict(owner) for owner in owner_lists], consumers


def protect_workflow_undo(page_id, record_id, document):
    owners, _ = _owner_manifest(document, None)
    return storage_service.undo_media_request({
        'action': 'protect', 'pageId': page_id, 'recordId': record_id,
        'workflowId': document['workflowId'],
        'assetKeys': list(dict.fromkeys(key for owner in owners for key in owner['assetKeys'])),
    })


def release_workflow_undo(page_id, record_id):
    return storage_service.undo_media_request({'action': 'release', 'pageId': page_id, 'recordIds': [record_id]})


def end_workflow_undo(page_id):
    return storage_service.undo_media_request({'action': 'end', 'pageId': page_id})


def _operation_owner_ids(workflow_id, owner, node):
    data = node.get('data') if isinstance(node.get('data'), dict) else {}
    for staged in data.get('mediaOwnershipTemporaryOwners') or []:
        if not isinstance(staged, dict) or not isinstance(staged.get('ownerId'), str):
            continue
        try:
            pieces = json.loads(staged['ownerId'])
        except ValueError:
            continue
        consumer_id = f"prompt-agent-result:{owner['ownerId']}" if owner['ownerType'] == 'prompt-agent-result' else owner['ownerId']
        keys = staged.get('assetKeys')
        if (isinstance(pieces, list) and len(pieces) == 3 and pieces[:2] == [workflow_id, consumer_id]
                and isinstance(keys, list) and keys and all(key in owner['assetKeys'] for key in keys)):
            yield staged['ownerId']


def _ownership_plan(workflow_id, document, owner_lists, next_revision, restore_intent):
    owner_lists, consumers = _owner_manifest(document, owner_lists)
    owners = {(owner['ownerType'], owner['ownerId']): (owner, 'save') for owner in owner_lists}
    restore_markers = []
    for previous in storage_service.list_media_owner_reference_lists(workflow_id):
        identity = previous['ownerType'], previous['ownerId']
        if identity not in owners and not previous['tombstoned']:
            kind, node_id = identity
            owners[identity] = ({'ownerType': kind, 'ownerId': node_id, 'assetKeys': []}, 'delete')
        elif identity in owners and previous['tombstoned']:
            if restore_intent not in {'undo', 'redo'}:
                raise CanvasMcpError(409, 'A deleted Media asset owner cannot be reused.', 'stale_revision')
            owners[identity] = (owners[identity][0], restore_intent)
            restore_markers.append({'ownerId': ':'.join(identity), 'intent': restore_intent, 'documentRevision': next_revision})
    return owners, consumers, restore_markers


def _commit_ownership(document, epoch, owners, consumers):
    workflow_id = document['workflowId']
    revision = document['mediaOwnershipRevision']
    storage_service.record_media_workflow_revision(workflow_id, revision, epoch, [owner for owner, _ in owners.values()])
    for (owner_type, owner_id), (owner, intent) in owners.items():
        current = storage_service.get_media_owner_reference_list(workflow_id, owner_type, owner_id)
        operation = f'workflow-{intent}:{revision}'
        transition = storage_service.replace_media_owner_references(
            workflow_id=workflow_id, owner_type=owner_type, owner_id=owner_id,
            operation_id=operation, idempotency_key=f'{workflow_id}:{operation}:{owner_type}:{owner_id}',
            expected_generation=(current or {}).get('generation', 0), document_revision=revision,
            storage_epoch=epoch, asset_keys=owner['assetKeys'], intent=intent,
        )
        if transition['status'] not in {'committed', 'already-committed'}:
            return False
        node = consumers.get((owner_type, owner_id))
        if node:
            for staged_id in _operation_owner_ids(workflow_id, owner, node):
                storage_service.remove_media_reference('workflow-operation', staged_id)
    return True


def save_saved_workflow(workflow_id, expected_revision, document, *, owner_lists=None, restore_intent=None):
    _require_workflow_id(workflow_id)
    if (not isinstance(expected_revision, str) or not expected_revision or not isinstance(document, dict)
            or document.get('workflowId') != workflow_id or not isinstance(document.get('nodes'), list)
            or not isinstance(document.get('connections'), list)):
        raise CanvasMcpError(400, 'A matching workflowId, revision, nodes and connections are required.', 'invalid_arguments')

    epoch = storage_service.get_storage_safety_status()['storageEpoch']

    def commit():
        storage_service.assert_storage_writable()
        with workflow_service.lock_workflow_files():
            name, path, body, current = _find_workflow(workflow_id)
            if expected_revision != _revision(body):
                raise CanvasMcpError(409, 'The saved workflow changed. Read its current revision before editing.', 'stale_revision')
            try:
                next_revision = max(0, int(current.get('mediaOwnershipRevision') or 0)) + 1
            except (ValueError, TypeError, OverflowError) as error:
                raise CanvasMcpError(409, 'The saved workflow has an invalid document revision.', 'invalid_workflow') from error
            owners, consumers, restore_markers = _ownership_plan(workflow_id, document, owner_lists, next_revision, restore_intent)
            saved = {**document, 'mediaOwnershipRevision': next_revision, workflow_service.MCP_WRITE_REVISION: next_revision}
            saved.pop('mediaOwnershipRestoreOwnerIds', None)
            if restore_markers:
                saved['mediaOwnershipRestoreOwnerIds'] = restore_markers
            saved_body = _encode_document(saved)
            workflow_service._atomic_write_workflow(path, saved_body)
            result = _saved_result(name, saved_body, saved)
            try:
                ownership_committed = _commit_ownership(saved, epoch, owners, consumers)
            except (OSError, sqlite3.Error, StorageError):
                ownership_committed = False
            if not ownership_committed:
                result['ownershipPending'] = True
            return result

    try:
        return storage_service.run_at_storage_epoch(epoch, commit)
    except StorageError as error:
        raise CanvasMcpError(409, 'The local Media asset storage could not save the workflow.', 'storage_conflict') from error
