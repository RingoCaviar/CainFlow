import base64
import binascii
import hmac
import re
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict

from backend.services.canvas_mcp_worker import CanvasWorker, CanvasWorkerError
from backend.services.svg_image import SVG_MIME, validate_static_svg

MAX_CALL_BYTES = 1024 * 1024
MAX_IMAGE_CHARS = 6_000_000
MAX_RUNS = 32
MAX_ACTIVE_RUNS = 4
MAX_UNDO = 20

REVISION_SCOPE = {'workflowId', 'revision'}
RUN_SCOPE = {'workflowId', 'runId'}
METHOD_ARGUMENTS = {
    'list_workflows': {'offset', 'limit'},
    'read_canvas': REVISION_SCOPE | {'nodeIds', 'offset', 'connectionOffset', 'textOffset', 'assetOffset'},
    'list_models': set(),
    'create_workflow': {'name'},
    'list_history': {'id', 'offset', 'limit'},
    'annotate_history': {'id', 'fileVersion', 'note'},
    'import_history': REVISION_SCOPE | {'items'},
    'list_prompts': {'query', 'offset', 'limit'},
    'save_prompt': {'name', 'content'},
    'apply_prompt': REVISION_SCOPE | {'nodeId', 'promptId', 'name', 'target'},
    'edit_canvas': REVISION_SCOPE | {'plan'},
    'generate_image_batch': REVISION_SCOPE | {'prompt', 'sourceNodeIds', 'parameters', 'modelId', 'providerId', 'run'},
    'run_workflow': REVISION_SCOPE | {'nodeIds', 'targetNodeId'},
    'stop_workflow': REVISION_SCOPE | {'nodeIds'},
    'undo_canvas': REVISION_SCOPE,
    'redo_canvas': REVISION_SCOPE,
    'get_workflow_run': RUN_SCOPE | {'offset'},
    'get_run_image': RUN_SCOPE | {'nodeId', 'index'},
}
EDITS = {'edit_canvas', 'generate_image_batch', 'import_history', 'apply_prompt'}
REQUIRE_REVISION = EDITS | {'run_workflow', 'stop_workflow', 'undo_canvas', 'redo_canvas'}
SCOPED = REQUIRE_REVISION | {'read_canvas', 'get_workflow_run', 'get_run_image'}
OFFSET_KEYS = {'offset', 'textOffset', 'connectionOffset', 'assetOffset', 'index'}
IMAGE_PREFIX = re.compile(r'^data:(image/(?:png|jpeg|webp|gif|svg\+xml));base64,', re.IGNORECASE)
SAFE_CODE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')


class CanvasMcpError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


def validate_canvas_mcp_token(token):
    if not isinstance(token, str) or len(token) < 32 or any(not '!' <= char <= '~' for char in token):
        raise ValueError('CAINFLOW_MCP_TOKEN must have at least 32 visible ASCII characters')
    return token


def _short_id(value):
    return isinstance(value, str) and 0 < len(value) <= 128 and not any(ord(char) < 32 for char in value)


def _validate(method, args):
    if (not isinstance(method, str) or method not in METHOD_ARGUMENTS or not isinstance(args, dict)
            or args.keys() - METHOD_ARGUMENTS[method]):
        raise CanvasMcpError(400, '未知的画布工具或参数。', 'invalid_arguments')
    if method in SCOPED and not _short_id(args.get('workflowId')):
        raise CanvasMcpError(400, '请提供 list_workflows 返回的工作流 ID。', 'invalid_arguments')
    if (method in REQUIRE_REVISION or 'revision' in args) and not _short_id(args.get('revision')):
        raise CanvasMcpError(400, '请提供 read_canvas 返回的工作流版本。', 'invalid_arguments')
    if method in ('get_workflow_run', 'get_run_image') and not _short_id(args.get('runId')):
        raise CanvasMcpError(400, '请提供运行 ID。', 'invalid_arguments')
    if any(type(args[key]) is not int or not 0 <= args[key] <= 2**53 - 1 for key in OFFSET_KEYS & args.keys()):
        raise CanvasMcpError(400, '分页偏移量和图片序号必须是非负整数。', 'invalid_arguments')
    for key in ('nodeIds', 'sourceNodeIds'):
        if key in args and (not isinstance(args[key], list) or len(args[key]) > 100 or not all(_short_id(item) for item in args[key])):
            raise CanvasMcpError(400, '节点列表格式无效。', 'invalid_arguments')
    if method == 'generate_image_batch':
        if not args.get('sourceNodeIds') or type(args.get('run', False)) is not bool:
            raise CanvasMcpError(400, '请明确指定批处理原图节点和是否运行。', 'invalid_arguments')


def _result_status(run):
    return {key: run[key] for key in ('workflowId', 'runId', 'status', 'revision', 'errorCode', 'error', 'historySaved', 'historySaveFailures')
            if key in run}


def _scope(saved):
    return {key: saved[key] for key in ('workflowId', 'name', 'revision', 'ownershipPending') if key in saved}


def _run_image(source, limit):
    match = IMAGE_PREFIX.match(source) if isinstance(source, str) else None
    if not match or len(source) - match.end() > limit:
        return None
    mime_type, data = match[1].lower(), source[match.end():]
    if mime_type == SVG_MIME:
        try:
            validate_static_svg(base64.b64decode(data, validate=True))
        except ValueError:
            return None
    return {'mimeType': mime_type, 'data': data}


class CanvasMcpService:
    """Authorize and operate on saved workspaces within the local CainFlow service."""

    def __init__(self, token):
        self._token = validate_canvas_mcp_token(token).encode('ascii')
        self._closed = threading.Event()
        self._lock = threading.RLock()
        self._edits = threading.Lock()
        self._runs = OrderedDict()
        self._history = OrderedDict()
        self._undo_session = uuid.uuid4().hex
        self._undo_used = threading.Event()

    def is_authorized(self, authorization):
        scheme, separator, value = authorization.partition(' ')
        return separator == ' ' and scheme.lower() == 'bearer' and hmac.compare_digest(value.encode('utf-8'), self._token)

    def _require_open(self):
        if self._closed.is_set():
            raise CanvasMcpError(503, '本地 Canvas MCP 服务已关闭。', 'service_closed')

    def close(self):
        from backend.services.canvas_mcp_storage import end_workflow_undo
        from backend.services.storage_service import StorageError
        self._closed.set()
        with self._lock:
            threads = [run['thread'] for run in self._runs.values() if run['thread'].is_alive()]
            for run in self._runs.values():
                if run['status'] == 'running':
                    run['worker'].stop()
        deadline = time.monotonic() + 5
        for thread in threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        with self._edits:
            if self._undo_used.is_set():
                try:
                    end_workflow_undo(self._undo_session)
                except (StorageError, sqlite3.Error, OSError, ValueError):
                    # Media ownership recovery can release the session on restart.
                    pass

    def call(self, method, args):
        self._require_open()
        _validate(method, args)
        try:
            return {'result': self._dispatch(method, args)}
        except CanvasWorkerError as error:
            code = error.code if SAFE_CODE.fullmatch(error.code or '') else 'runtime_failed'
            status = {'runtime_unavailable': 503, 'runtime_timeout': 504, 'invalid_arguments': 400,
                      'stale_revision': 409, 'result_too_large': 413}.get(code, 422)
            raise CanvasMcpError(status, str(error), code) from error
        except (ValueError, TypeError, binascii.Error) as error:
            raise CanvasMcpError(400, '工具参数无效，或工作流数据格式不正确。', 'invalid_arguments') from error

    def _dispatch(self, method, args):
        from backend.services import canvas_mcp_app_data as app, canvas_mcp_storage as storage

        if method == 'list_workflows':
            return storage.list_saved_workflows(args.get('offset', 0), args.get('limit', 20))
        if method == 'create_workflow':
            return _scope(storage.create_saved_workflow(args.get('name')))
        if method == 'list_history':
            return app.list_history(args)
        if method == 'annotate_history':
            return app.annotate_history(args)
        if method == 'list_prompts':
            return app.list_prompts(args)
        if method == 'save_prompt':
            return app.save_prompt(args)
        if method == 'list_models':
            return self._worker(method, args)['result']
        if method in ('get_workflow_run', 'get_run_image'):
            return self._run_result(method, args)
        workflow_id = args['workflowId']
        if method == 'read_canvas':
            saved = self._read(workflow_id, args.get('revision'))
            return self._worker(method, args, saved)['result']

        with self._edits:
            self._require_open()
            saved = self._read(workflow_id, args['revision'])
            if method == 'stop_workflow':
                return self._stop_run(workflow_id, args.get('nodeIds'))
            self._require_idle(workflow_id)
            if method == 'run_workflow':
                return self._start_run(saved, args)
            if method in ('undo_canvas', 'redo_canvas'):
                return self._restore(saved, method)

            staged = []
            try:
                worker_args = {**args, 'run': False} if method == 'generate_image_batch' else args
                response = self._worker(method, worker_args, saved, staged=staged)
                result = response['result']
                result.update(_scope(self._commit(saved, response)))
                published = set(response.get('publishedOwnerIds', []))
                staged[:] = [owner_id for owner_id in staged if owner_id not in published]
            finally:
                for owner_id in staged:
                    storage.cancel_workflow_media(owner_id)
            if method == 'generate_image_batch' and args.get('run'):
                current = self._read(workflow_id, result['revision'])
                try:
                    result['run'] = self._start_run(current, {
                        'workflowId': workflow_id, 'revision': current['revision'], 'nodeIds': result['nodeIds'],
                        'imageBatch': True
                    })
                except (CanvasMcpError, CanvasWorkerError) as error:
                    result.update(runError=str(error), runErrorCode=error.code)
            return result

    def _read(self, workflow_id, revision=None):
        from backend.services.canvas_mcp_storage import read_saved_workflow
        saved = read_saved_workflow(workflow_id)
        if revision is not None and saved['revision'] != revision:
            raise CanvasMcpError(409, '已保存的工作流版本已变化，请重新调用 read_canvas。', 'stale_revision')
        return saved

    def _active_run(self, workflow_id):
        return next((run for run in self._runs.values() if run['workflowId'] == workflow_id
                     and run['status'] == 'running'), None)

    def _require_idle(self, workflow_id):
        with self._lock:
            if self._active_run(workflow_id):
                raise CanvasMcpError(409, '此工作流已有运行，请在运行结束后再修改或启动。', 'workflow_running')

    def _worker(self, method, args, saved=None, *, staged=None, worker=None):
        from backend.services import canvas_mcp_app_data as app, canvas_mcp_storage as storage

        configuration = app.get_runtime_configuration()
        command = {'method': method, 'args': args, **configuration}
        if saved:
            workflow_id = saved['document']['workflowId']
            with self._lock:
                active = self._active_run(workflow_id)
                running = list(active['nodeIds']) if active else []
            command.update(document=saved['document'], revision=saved['revision'], runningIds=running)

        def stage_media(parameters):
            self._require_open()
            if staged is None or not saved or method not in ('execute', 'import_history'):
                raise ValueError('No media write context')
            owner = storage.stage_workflow_media(workflow_id, parameters['nodeId'], [parameters['dataUrl']])
            staged.append(owner['ownerId'])
            return owner

        def load_media(parameters):
            if not saved:
                raise ValueError('No media read context')
            return storage.load_workflow_media(parameters['assetKey'])

        callbacks = {
            'loadMedia': load_media, 'hasMedia': lambda parameters: storage.workflow_media_exists(parameters['assetKey']),
            'stageMedia': stage_media, 'listHistory': app.list_history,
            'historyMedia': app.history_media, 'getPrompt': app.get_prompt,
            'requestProvider': lambda parameters: app.request_provider(parameters, configuration['providers']),
        }
        return (worker or CanvasWorker()).execute(command, callbacks)

    def _commit(self, saved, response, *, record_history=True, restore_intent=None):
        from backend.services.canvas_mcp_storage import save_saved_workflow
        workflow_id = saved['document']['workflowId']
        self._require_open()
        snapshot = self._protect_undo(saved) if record_history else None
        try:
            current = save_saved_workflow(workflow_id, saved['revision'], response['document'],
                                          owner_lists=response.get('ownerLists'), restore_intent=restore_intent)
        except Exception:
            if snapshot:
                self._release_undo([snapshot])
            raise
        if record_history:
            entry = self._history_for(saved)
            entry['undo'].append(snapshot)
            self._release_undo(entry['undo'][:-MAX_UNDO] + entry['redo'])
            entry['undo'] = entry['undo'][-MAX_UNDO:]
            entry['redo'] = []
            entry['revision'] = current['revision']
        return current

    def _protect_undo(self, saved):
        from backend.services.canvas_mcp_storage import protect_workflow_undo
        record_id = uuid.uuid4().hex
        self._undo_used.set()
        protect_workflow_undo(self._undo_session, record_id, saved['document'])
        return {'recordId': record_id, 'document': saved['document']}

    def _release_undo(self, snapshots):
        from backend.services.canvas_mcp_storage import release_workflow_undo
        from backend.services.storage_service import StorageError
        for snapshot in snapshots:
            try:
                release_workflow_undo(self._undo_session, snapshot['recordId'])
            except (StorageError, sqlite3.Error, OSError, ValueError):
                # The workflow may already be saved. The undo session can still release this record later.
                pass

    def _history_for(self, saved):
        key = saved['document']['workflowId']
        previous = self._history.pop(key, None)
        if previous and previous['revision'] != saved['revision']:
            self._release_undo(previous['undo'] + previous['redo'])
            previous = None
        entry = previous or {'revision': saved['revision'], 'undo': [], 'redo': []}
        self._history[key] = entry
        while len(self._history) > 16:
            _, evicted = self._history.popitem(last=False)
            self._release_undo(evicted['undo'] + evicted['redo'])
        return entry

    def _restore(self, saved, method):
        source = 'undo' if method == 'undo_canvas' else 'redo'
        destination = 'redo' if source == 'undo' else 'undo'
        entry = self._history_for(saved)
        if not entry[source]:
            return {**_scope(saved), 'changed': False}
        snapshot = entry[source][-1]
        response = self._worker('owner_lists', {}, {**saved, 'document': snapshot['document']})
        current_snapshot = self._protect_undo(saved)
        try:
            current = self._commit(saved, response, record_history=False, restore_intent=source)
        except Exception:
            self._release_undo([current_snapshot])
            raise
        entry[source].pop()
        entry[destination].append(current_snapshot)
        entry['revision'] = current['revision']
        if not current.get('ownershipPending'):
            self._release_undo([snapshot])
        return {**_scope(current), 'changed': True}

    def _start_run(self, saved, args):
        workflow_id = saved['document']['workflowId']
        input_args = {key: args[key] for key in ('nodeIds', 'targetNodeId') if key in args}
        validation = self._worker('validate_run', {**input_args, 'imageBatch': args.get('imageBatch', False)}, saved)
        worker = CanvasWorker()
        run_id = uuid.uuid4().hex
        node_ids = validation['result']['nodeIds']
        with self._lock:
            self._require_open()
            if sum(run['status'] == 'running' for run in self._runs.values()) >= MAX_ACTIVE_RUNS:
                raise CanvasMcpError(429, '后台运行数量已达上限。', 'run_busy')
            if len(self._runs) >= MAX_RUNS:
                old_id = next(key for key, run in self._runs.items() if run['status'] != 'running')
                del self._runs[old_id]
            run = {'workflowId': workflow_id, 'runId': run_id, 'status': 'running', 'revision': saved['revision'],
                   'worker': worker, 'nodeIds': node_ids, 'nodeResults': [], 'images': {}}
            run['thread'] = threading.Thread(target=self._execute_run, args=(run, saved, args), daemon=True)
            self._runs[run_id] = run
            started = _result_status(run)
            run['thread'].start()
        return started

    def _execute_run(self, run, saved, args):
        from backend.services.canvas_mcp_app_data import publish_generated_history
        from backend.services.canvas_mcp_storage import cancel_workflow_media

        staged = []
        try:
            response = self._worker('execute', args, saved, staged=staged, worker=run['worker'])
            result = response['result']
            revision = saved['revision']
            history = {}
            if response.get('document') and response['document'] != saved['document']:
                with self._edits:
                    current = self._commit(saved, response, record_history=False)
                    entry = self._history.get(run['workflowId'])
                    if entry and entry['revision'] == saved['revision']:
                        entry['revision'] = current['revision']
                revision = current['revision']
                published = set(response.get('publishedOwnerIds', []))
                staged[:] = [owner_id for owner_id in staged if owner_id not in published]
                if published:
                    exported = publish_generated_history(current['document'], result['nodeResults'],
                                                          published_owner_ids=published)
                    history = {'historySaved': exported['saved'], 'historySaveFailures': exported['failed']}
            rows, images = self._project_results(result.get('nodeResults', []), include_images=True)
            with self._lock:
                run.update(status=result.get('outcome', 'completed'), revision=revision, nodeResults=rows, images=images, **history)
            return
        except Exception as error:
            code = getattr(error, 'code', None)
            message = str(error) if isinstance(error, CanvasMcpError) else '后台工作流运行失败，请检查模型配置与节点输入。'
            with self._lock:
                run.update(status='failed', errorCode=code if code and SAFE_CODE.fullmatch(code) else 'run_failed', error=message)
        finally:
            for owner_id in staged:
                cancel_workflow_media(owner_id)

    def _stop_run(self, workflow_id, node_ids):
        with self._lock:
            run = self._active_run(workflow_id)
            if not run:
                return {'stopped': 0}
            if node_ids is not None and (not node_ids or len(set(node_ids)) != len(node_ids)
                                         or set(node_ids) - set(run['nodeIds'])):
                raise CanvasMcpError(400, '请提供此运行中的节点 ID。', 'invalid_arguments')
            accepted = run['worker'].stop(node_ids)
            return {'stopped': len(node_ids if node_ids is not None else run['nodeIds']) if accepted else 0}

    @staticmethod
    def _project_results(results, *, include_images):
        rows, images = [], {}
        retained_image_chars = 0
        for result in results:
            node_id = result['nodeId']
            node_images = result.get('images') or []
            row = {'nodeId': node_id, 'succeeded': result['succeeded'] is True, 'imageCount': len(node_images),
                   'mediaAssetKeys': [key for key in result.get('mediaAssetKeys', []) if key.startswith('media:')]}
            if result['succeeded']:
                texts = [value[:4000] for value in result.get('texts', [])[:5] if isinstance(value, str)]
                if texts:
                    row['texts'] = texts
            else:
                category = result.get('failureCategory')
                row['errorCode'] = 'node_' + category if category and SAFE_CODE.fullmatch(category) else 'node_execution_failed'
                row['error'] = ('此节点类型尚不能在后台执行。' if category == 'unsupported_node'
                                else '节点执行失败，请检查输入和模型设置。')
            for index, source in enumerate(node_images if include_images else ()):
                image = _run_image(source, min(MAX_IMAGE_CHARS, 12_000_000 - retained_image_chars))
                if image:
                    images[(node_id, index)] = image
                    retained_image_chars += len(image['data'])
            rows.append(row)
        return rows, images

    def _run_result(self, method, args):
        offset = args.get('offset', 0)
        with self._lock:
            run = self._runs.get(args['runId'])
            if not run or run['workflowId'] != args['workflowId']:
                raise CanvasMcpError(404, '找不到此工作流的运行记录。', 'run_not_found')
            if method == 'get_run_image':
                return self._get_run_image(run, args)
            rows = run['nodeResults']
            page = rows[offset:offset + 5]
            end = offset + len(page)
            return {**_result_status(run), 'nodeResults': page, 'total': len(rows), 'offset': offset,
                    'nextOffset': end if end < len(rows) else None}

    @staticmethod
    def _get_run_image(run, args):
        from backend.services.canvas_mcp_storage import load_workflow_media
        node_id, index = args.get('nodeId'), args.get('index', 0)
        image = run['images'].get((node_id, index))
        if image:
            return image
        node = next((row for row in run['nodeResults'] if row['nodeId'] == node_id), {})
        keys = node.get('mediaAssetKeys', [])
        if index < len(keys):
            try:
                original = load_workflow_media(keys[index])
            except CanvasMcpError:
                original = ''
            image = _run_image(original, MAX_IMAGE_CHARS)
            if image:
                return image
        raise CanvasMcpError(404, '本次运行没有保留这张图片，或素材超过读取大小限制。', 'image_unavailable')
