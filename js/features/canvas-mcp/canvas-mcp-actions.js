import { isCanvasGraphOnlyStep, normalizeCanvasPlan } from '../prompt-agent/prompt-agent-canvas-plan.js';
import { canvasPlanExecutionNodeIds } from '../prompt-agent/prompt-agent-canvas-context.js';
import { buildCanvasImageBatch } from '../prompt-agent/prompt-agent-canvas-image-batch.js';
import { canvasRevisionFingerprint, resolveCanvasRunInput } from './cainflow-app-actions.js';

const MAX_RUNS = 32;
const MAX_STATUS_NODES = 100;
// The local backend serializes non-ASCII UTF-16 code units as six ASCII bytes.
// Leave space under the 1 MiB transport limit for the bridge envelope.
const MAX_STATUS_PAGE_BYTES = 720_000;
const MAX_IMAGE_DATA_LENGTH = 6_000_000;
const MAX_IMAGE_CACHE_LENGTH = 12_000_000;
const RUN_OUTCOMES = new Set(['completed', 'stopped', 'failed', 'timeout', 'cancelled', 'no-execution']);
const IMAGE_DATA_PREFIX = /^data:(image\/(?:png|jpeg|webp|gif));base64,/i;

function actionError(code, message) {
    return Object.assign(new Error(message), { code });
}

function asciiJsonSize(value) {
    const json = JSON.stringify(value);
    return json.length + 5 * (json.match(/[^\x00-\x7e]/g)?.length || 0);
}

export function createCanvasMcpActions({ canvasAdapter, getImageDefaults = () => ({}), getImageModels = () => [], runWorkflow, appActions = null }) {
    let revisionState;
    const runs = new Map();
    const runImages = new Map();
    let imageCacheLength = 0;

    function snapshot(workflowId) {
        const context = canvasAdapter.context();
        if (!context.workflowId) throw actionError('no_active_workflow', '请先在 CainFlow 打开工作流。');
        if (workflowId !== undefined && workflowId !== context.workflowId) {
            throw actionError('wrong_workflow', '指定的工作流当前未显示，请重新读取画布。');
        }
        const fingerprint = canvasRevisionFingerprint(context);
        if (revisionState?.fingerprint !== fingerprint) {
            revisionState = { fingerprint, revision: crypto.randomUUID() };
        }
        return { context, revision: revisionState.revision };
    }

    function requireRevision({ workflowId, revision }, isCurrent = () => true) {
        if (!isCurrent()) throw actionError('stale_editor', 'CainFlow 编辑器已变化，请重新读取画布。');
        if (typeof workflowId !== 'string' || !workflowId || typeof revision !== 'string' || !revision) {
            throw actionError('invalid_arguments', '此操作需要读取画布取得的工作流 ID 与版本。');
        }
        const current = snapshot(workflowId);
        if (current.revision !== revision) {
            throw actionError('stale_revision', '画布已修改，请重新读取后再操作。');
        }
        return current.context;
    }

    function listModels() {
        return getImageModels().map(({ id, modelId, name, providers }) => ({
            id, modelId, name, providers: providers.map(({ id, name, maxReferences, parameters }) => ({
                id, name, ...(Number.isInteger(maxReferences) ? { maxReferences } : {}), ...(parameters ? { parameters } : {})
            }))
        }));
    }

    function resolveImageChoices(plan, context, choices) {
        const generators = plan.steps.filter(step => step.type === 'ImageGenerate'
            && (choices.has(step.id) || !isCanvasGraphOnlyStep(plan, step)));
        const { modelId: defaultModelId = '', providerIds = {} } = generators.some(step => !step.nodeId) ? getImageDefaults() : {};
        const models = choices.size ? listModels() : [];
        plan.agentProviders = providerIds;
        plan.providerOverrides = {};
        plan.thinkingOverrides = {};
        for (const step of generators) {
            const node = context.nodes.find(node => node.id === step.nodeId);
            const choice = choices.get(step.id);
            const modelId = choice?.modelId ?? (node ? node.modelId : defaultModelId);
            let providerId = node ? node.providerId : providerIds[modelId];
            if (choice) {
                const model = models.find(model => model.id === modelId);
                if (!model) throw actionError('invalid_arguments', '请选择 list_models 返回的生图模型 ID。');
                providerId = choice.providerId ?? (node?.modelId === modelId ? node.providerId : undefined)
                    ?? (model.providers.length === 1 ? model.providers[0].id : undefined);
                if (!model.providers.some(provider => provider.id === providerId)) {
                    throw actionError('invalid_arguments', '请明确指定 list_models 中绑定到该模型的供应商 ID。');
                }
            }
            if (!modelId || !providerId) {
                const message = node ? '请先在画布上为目标生图节点选择模型和供应商。'
                    : '请先在 CainFlow 选择新建生图节点使用的模型和供应商。';
                throw actionError('edit_failed', message);
            }
            plan.modelOverrides[step.id] = modelId;
            plan.providerOverrides[step.id] = { [modelId]: providerId };
            if (node?.modelId === modelId && node.thinking) plan.thinkingOverrides[step.id] = { [modelId]: node.thinking };
        }
        return defaultModelId;
    }

    async function applyEdit(raw, context, args, { imageBatch = false, isCurrent } = {}) {
        if (!raw || !Array.isArray(raw.steps) || (raw.deletes !== undefined && !Array.isArray(raw.deletes))
            || (raw.connections !== undefined && !Array.isArray(raw.connections))
            || (raw.disconnects !== undefined && !Array.isArray(raw.disconnects))) {
            throw actionError('invalid_arguments', '请提供有效的 v1 画布方案。');
        }
        const targets = raw.steps.map(step => step?.nodeId).filter(Boolean);
        if (new Set(targets).size !== targets.length) {
            throw actionError('invalid_arguments', '一个画布方案中同一节点只能对应一个步骤。');
        }
        const mentionedIds = [...targets, ...(raw.deletes || []).map(item => item?.nodeId).filter(Boolean)];
        const choices = new Map();
        let plan;
        try {
            const steps = raw.steps.map(step => {
                if (!step || typeof step !== 'object') return step;
                const { modelId, providerId, ...fields } = step;
                if (!imageBatch && fields.nodeId && fields.execute === undefined) fields.execute = false;
                if (modelId === undefined && providerId === undefined) return fields;
                if (step.type !== 'ImageGenerate' || [modelId, providerId].some(value =>
                    value !== undefined && (typeof value !== 'string' || !value))) {
                    throw new Error('模型和供应商 ID 只能用于生图步骤。');
                }
                choices.set(step.id, { modelId, providerId });
                return fields;
            });
            plan = normalizeCanvasPlan({ ...raw, steps }, context, { mentionedIds, explicitInputChanges: true });
        } catch (error) {
            throw actionError('invalid_arguments', error.message);
        }

        plan.applyInPlace = true;
        const defaultModelId = resolveImageChoices(plan, context, choices);
        plan.explicitImageParameters = true;
        if (imageBatch) plan.imageBatch = true;

        try {
            return await canvasAdapter.apply(plan, defaultModelId, undefined, () => Boolean(requireRevision(args, isCurrent)));
        } catch (error) {
            if (['stale_editor', 'stale_revision', 'wrong_workflow'].includes(error.code)) throw error;
            throw actionError('edit_failed', '无法应用画布方案。请检查编辑器中的运行状态、模型配置或保存状态。');
        } finally {
            canvasAdapter.discardExecutionConfig?.(plan);
        }
    }

    function editResult(workflowId, applied) {
        return { workflowId, revision: snapshot(workflowId).revision, bindings: applied.bindings };
    }

    async function generateImageBatch(args, { isCurrent } = {}) {
        const context = requireRevision(args, isCurrent);
        const { modelId, providerId, run = false } = args;
        if (typeof run !== 'boolean') throw actionError('invalid_arguments', 'run 必须是布尔值。');
        let raw;
        try {
            raw = buildCanvasImageBatch(context, args);
        } catch (error) {
            throw actionError('invalid_arguments', error.message);
        }
        if (modelId !== undefined || providerId !== undefined) {
            raw.steps = raw.steps.map(step => step.type === 'ImageGenerate' ? { ...step, modelId, providerId } : step);
        }
        const applied = await applyEdit(raw, context, args, { imageBatch: true, isCurrent });
        const edit = editResult(args.workflowId, applied);
        const nodeIds = canvasPlanExecutionNodeIds(applied);
        if (!run) return { ...edit, nodeIds };
        try {
            return { ...edit, nodeIds, run: startRun({ ...edit, nodeIds }, { imageBatch: true, isCurrent }) };
        } catch (error) {
            // The graph is already saved. Return its bindings so callers can retry only execution.
            return { ...edit, nodeIds, runError: error.message };
        }
    }

    function getRun({ workflowId, runId }) {
        if (typeof workflowId !== 'string' || !workflowId || typeof runId !== 'string' || !runId) {
            throw actionError('invalid_arguments', '请提供运行所属的工作流 ID 和运行 ID。');
        }
        const record = runs.get(runId);
        if (!record || record.workflowId !== workflowId) throw actionError('run_not_found', '找不到此工作流的运行记录。');
        return record;
    }

    function getRunPage(args) {
        const { offset = 0 } = args;
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw actionError('invalid_arguments', '运行结果分页需要从零开始的有效偏移量。');
        }
        const { nodeResults = [], ...status } = getRun(args);
        const total = nodeResults.length;
        const page = { ...status, offset, total, nextOffset: null, nodeResults: [] };
        let bytes = asciiJsonSize(page);
        for (const node of nodeResults.slice(offset)) {
            const nodeBytes = asciiJsonSize(node);
            const separator = page.nodeResults.length ? 1 : 0;
            if (bytes + separator + nodeBytes > MAX_STATUS_PAGE_BYTES) {
                if (!page.nodeResults.length) {
                    // A single exceptional node must not block later pages.
                    const summary = { nodeId: node.nodeId, succeeded: node.succeeded, imageCount: node.imageCount,
                        mediaAssetKeys: [], detailsOmitted: true };
                    if (bytes + asciiJsonSize(summary) > MAX_STATUS_PAGE_BYTES) {
                        throw actionError('result_too_large', '单个节点的运行结果超出分页大小限制。');
                    }
                    page.nodeResults.push(summary);
                }
                break;
            }
            page.nodeResults.push(node);
            bytes += separator + nodeBytes;
        }
        const nextOffset = offset + page.nodeResults.length;
        if (nextOffset < total) page.nextOffset = nextOffset;
        return structuredClone(page);
    }

    function removeImage(key) {
        imageCacheLength -= runImages.get(key).data.length;
        runImages.delete(key);
    }

    function captureImage(runId, nodeId, index, source) {
        const prefix = typeof source === 'string' && source.match(IMAGE_DATA_PREFIX);
        if (!prefix || source.length - prefix[0].length > MAX_IMAGE_DATA_LENGTH) return;
        const data = source.slice(prefix[0].length);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
        while (imageCacheLength + data.length > MAX_IMAGE_CACHE_LENGTH) {
            removeImage(runImages.keys().next().value);
        }
        const key = JSON.stringify([runId, nodeId, index]);
        if (runImages.has(key)) removeImage(key);
        runImages.set(key, { runId, mimeType: prefix[1].toLowerCase(), data });
        imageCacheLength += data.length;
    }

    function getRunImage(args) {
        const { runId } = getRun(args);
        const { nodeId, index } = args;
        if (typeof nodeId !== 'string' || !nodeId || !Number.isSafeInteger(index) || index < 0) {
            throw actionError('invalid_arguments', '请提供结果节点 ID 和从零开始的图片序号。');
        }
        const image = runImages.get(JSON.stringify([runId, nodeId, index]));
        if (!image) throw actionError('image_unavailable', '此运行未保留该图片，或图片已超出结果缓存范围。');
        return { mimeType: image.mimeType, data: image.data };
    }

    function finishRun(record, completion) {
        if (!completion || completion.workflowId !== record.workflowId) {
            record.status = 'failed';
            return;
        }
        const nodes = Array.isArray(completion.nodeResults) ? completion.nodeResults : [];
        record.nodeResults = nodes.slice(0, MAX_STATUS_NODES).map(node => {
            const texts = node.succeeded === true && Array.isArray(node.texts)
                ? node.texts.filter(text => typeof text === 'string').slice(0, 5).map(text => text.slice(0, 4000)) : [];
            return {
                nodeId: node.nodeId,
                succeeded: node.succeeded === true,
                imageCount: Array.isArray(node.images) ? node.images.length : 0,
                mediaAssetKeys: Array.isArray(node.mediaAssetKeys)
                    ? node.mediaAssetKeys.filter(key => typeof key === 'string' && key.startsWith('media:')) : [],
                ...(texts.length ? { texts } : {})
            };
        });
        for (const node of nodes) {
            if (node.succeeded !== true || !Array.isArray(node.images)) continue;
            node.images.forEach((image, index) => captureImage(record.runId, node.nodeId, index, image));
        }
        if (nodes.length > MAX_STATUS_NODES) record.nodeResultsOmitted = nodes.length - MAX_STATUS_NODES;
        record.status = RUN_OUTCOMES.has(completion.outcome) ? completion.outcome : 'failed';
    }

    function startRun(args, { imageBatch = false, isCurrent } = {}) {
        const context = requireRevision(args, isCurrent);
        const { workflowId } = args;
        let input;
        try { input = resolveCanvasRunInput(context, args); }
        catch (error) { throw actionError('invalid_arguments', error.message); }
        if (imageBatch && input) input.imageBatch = true;
        if (runs.size >= MAX_RUNS) {
            const finished = [...runs.values()].find(record => record.status !== 'running');
            if (!finished) throw actionError('run_busy', '运行记录已满，请等待现有运行结束。');
            runs.delete(finished.runId);
            for (const [key, image] of runImages) if (image.runId === finished.runId) removeImage(key);
        }
        const record = { workflowId, runId: crypto.randomUUID(), status: 'running' };
        runs.set(record.runId, record);
        void Promise.resolve().then(() => runWorkflow(input, {
            waitForCompletion: true,
            captureTextResults: true,
            validateBeforeRun: () => requireRevision(args, isCurrent)
        })).then(completion => finishRun(record, completion)).catch(() => { record.status = 'failed'; });
        return { ...record };
    }

    async function dispatch(method, args = {}, scope) {
        if (appActions?.supports(method)) {
            if (appActions.usesCanvas(method)) {
                const context = requireRevision(args, scope?.isCurrent);
                const { editorId, workflowId, revision, ...parameters } = args;
                const isCurrent = () => Boolean(requireRevision(args, scope?.isCurrent));
                const result = await appActions.dispatch(method, parameters, { context, isCurrent });
                return { ...result, workflowId, revision: snapshot(workflowId).revision };
            }
            const { editorId, ...parameters } = args;
            return appActions.dispatch(method, parameters, scope);
        }
        if (method === 'read_canvas') {
            const { context, revision } = snapshot(args.workflowId);
            return {
                workflowId: context.workflowId,
                revision,
                selectedIds: context.summary.selectedIds,
                totalNodes: context.summary.totalNodes,
                totalConnections: context.summary.totalConnections,
                editableTypes: context.summary.editableTypes.slice(),
                creatableTypes: (context.summary.creatableTypes || context.summary.editableTypes).slice(),
                nodePatchFields: context.summary.nodePatchFields,
                editableFields: context.summary.editableFields,
                ...context.read(args)
            };
        }
        if (method === 'list_models') return { models: listModels() };
        if (method === 'edit_canvas') {
            const applied = await applyEdit(args.plan, requireRevision(args, scope?.isCurrent), args, scope);
            return editResult(args.workflowId, applied);
        }
        if (method === 'generate_image_batch') return generateImageBatch(args, scope);
        if (method === 'run_workflow') return startRun(args, scope);
        if (method === 'get_workflow_run') return getRunPage(args);
        if (method === 'get_run_image') return getRunImage(args);
        throw actionError('unknown_method', '未知的画布操作。');
    }

    return { dispatch };
}
