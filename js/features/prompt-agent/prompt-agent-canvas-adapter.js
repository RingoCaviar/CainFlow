import { normalizePlanInputs, projectPlanConnections, referenceManifest, assertReferenceInputsPreserved, isReferencePort } from './prompt-agent-reference-inputs.js';
import { resolveAgentSize, sizeFields } from './prompt-agent-size.js';
import { getEffectiveProtocol } from '../execution/provider-request-utils.js';
import { resolveThinking } from '../execution/thinking-config.js';
import { createCanvasContext, canvasBaseline, cloneCanvasValue } from './prompt-agent-canvas-context.js';
import { assertCanvasPlanCurrent, describeCanvasPlan } from './prompt-agent-canvas-plan.js';
import { getAvailablePromptAgentImageModels } from './prompt-agent-node-adapter.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { getNodeDefinition } from '../../nodes/registry.js';
import { nodeBounds, findNearbyNodePosition } from '../execution/node-placement.js';

const controlFields = { text: 'text', filename: 'filename', resizeMode: 'resize-mode', scalePercent: 'scale-percent',
    targetWidth: 'target-width', targetHeight: 'target-height', keepAspect: 'keep-aspect', quality: 'quality' };
const generationFields = { aspect: 'aspectRatio', generationCount: 'count', resolution: 'resolution', customWidth: 'customWidth', customHeight: 'customHeight', quality: 'quality', moderation: 'moderation', background: 'background' };

export function createPromptAgentCanvasAdapter({ state, documentRef, serializeNodes, getWorkflowId, addNode,
    nodeAdapter, session, save, graphChanged, origin, getImageAsset, runWorkflow, cancelNode, focusNode }) {
    let activePlan = null;
    const executionConfigs = new Map();
    const context = (mentionedIds = []) => createCanvasContext({ workflowId: getWorkflowId(), nodes: serializeNodes(), connections: state.connections,
        selectedIds: [...state.selectedNodes], mentionedIds, runningIds: [...(state.runningNodeIds || [])] });
    function prepare(plan) {
        normalizePlanInputs(plan);
        // Automatically required saves are part of the preview, never a hidden execution mutation.
        for (const step of [...plan.steps]) {
            if (step.type !== 'ImageGenerate') continue;
            const hasTarget = plan.connections.some(link => link.from.ref === step.id && link.from.port === 'image')
                || (step.nodeId && state.connections.some(link => link.from.nodeId === step.nodeId && link.from.port === 'image' && state.nodes.get(link.to.nodeId)?.enabled !== false && state.nodes.has(link.to.nodeId)));
            if (!hasTarget) {
                const id = `save_${step.id}`;
                if (plan.steps.some(item => item.id === id)) throw new Error('自动保存步骤名称冲突，请重新整理方案');
                plan.steps.push({ id, type: 'ImageSave', title: `${step.title} · 保存`, parameters: {}, execute: true, autoAddedForGeneration: true });
                plan.connections.push({ from: { ref: step.id, port: 'image' }, to: { ref: id, port: 'image' }, type: 'image' });
                plan.order.push(id);
            }
        }
        return plan;
    }
    function modelsFor(plan, defaultModelId) {
        const models = getAvailablePromptAgentImageModels(state.models, state.providers);
        return Object.fromEntries(plan.steps.filter(step => step.type === 'ImageGenerate').map(step => {
            const id = plan.modelOverrides?.[step.id] || defaultModelId;
            const model = models.find(item => item.id === id);
            if (!model) throw new Error(`请为「${step.title}」手动选择可用的生图模型`);
            const provider = resolveAgentProvider(model, state.providers, plan.providerOverrides?.[step.id]?.[id] ?? plan.agentProviders?.[id]);
            if (!provider?.endpoint) throw new Error(`「${step.title}」的 Provider 不可用`);
            // Agent-level image thinking preferences are retired; only explicit per-step
            // overrides and the model/Provider defaults remain applicable.
            const thinking = resolveThinking({ model, provider, task: 'image', protocol: model.protocol }, plan.thinkingOverrides?.[step.id]?.[id]).setting;
            return [step.id, { model, provider, thinking }];
        }));
    }
    function sizesFor(plan, defaultModelId, selected = modelsFor(plan, defaultModelId)) {
        return Object.fromEntries(plan.steps.filter(step => step.type === 'ImageGenerate').map(step => {
            const config = selected[step.id];
            const targetId = step.nodeId || plan.bindings?.[step.id];
            const targetModel = documentRef?.getElementById(`${targetId}-apiconfig`)?.value || state.nodes?.get(targetId)?.apiConfigId;
            const current = !plan.newCreativeTask && targetModel === config.model.id ? nodeAdapter.getContext(targetId)?.parameters || {} : {};
            try {
                const parameters = { ...sizeFields(step.parameters), ...sizeFields(step.generationPatch), ...sizeFields(step.sizeAnswer) };
                const sources = { ...step.parameterSources };
                for (const [key, value] of Object.entries(sizeFields(plan.agentSizes?.[config.model.id]))) {
                    if (sources[key] === '方案建议' && !Object.hasOwn(step.sizeAnswer || {}, key)) { parameters[key] = value; sources[key] = '面板默认'; }
                }
                const size = resolveAgentSize({ protocol: getEffectiveProtocol(config.model, config.provider), current,
                    defaults: plan.agentSizes?.[config.model.id],
                    parameters });
                return [step.id, {...size, sources: Object.fromEntries(Object.keys(sizeFields(size.effective)).filter(key=>size.effective[key]!=='' ).map(key=>[key,sources[key] || (Object.hasOwn(plan.agentSizes?.[config.model.id]||{},key)?'面板默认':'节点或接口默认')]))}];
            } catch (error) { error.stepId = step.id; error.message = `「${step.title}」${error.message}`; throw error; }
        }));
    }
    function validateGraph(plan) {
        const ids = new Map(plan.steps.map(step => [step.id, step.nodeId || plan.bindings?.[step.id] || `new:${step.id}`]));
        assertReferenceInputsPreserved(plan, state.connections, ref => ids.get(ref) || ref);
        const links = projectPlanConnections(plan, state.connections, ref => ids.get(ref) || ref);
        const visited = new Set(), visiting = new Set();
        const visit = id => {
            if (visiting.has(id)) throw new Error('方案与已有画布形成循环依赖');
            if (visited.has(id)) return;
            visiting.add(id); links.filter(link => link.to.nodeId === id).forEach(link => visit(link.from.nodeId));
            visiting.delete(id); visited.add(id);
        };
        for (const id of ids.values()) visit(id);
        for (const step of plan.steps) {
            if (!['ImageResize', 'ImagePreview', 'ImageCompare', 'ImageMerge', 'ImageSave'].includes(step.type)) continue;
            const inputs = links.filter(link => link.to.nodeId === ids.get(step.id));
            if (!inputs.some(link => /^image/.test(link.to.port)) || (step.type === 'ImageCompare' && !['imageA', 'imageB'].every(port => inputs.some(link => link.to.port === port)))) throw new Error(`「${step.title}」缺少必要图片输入`);
        }
        return { ids, links };
    }
    async function apply(plan, defaultModelId, onPlanChange = () => {}, isCurrent = () => true) {
        if (!isCurrent()) throw new Error('方案所属会话已变化');
        if (activePlan) throw new Error('另一个画布方案正在执行');
        assertCanvasPlanCurrent(plan, context());
        const selected = modelsFor(plan, defaultModelId);
        const sizes = sizesFor(plan, defaultModelId, selected);
        executionConfigs.set(plan.id, cloneCanvasValue({ models: state.models, providers: state.providers }));
        validateGraph(plan);
        const signature = JSON.stringify({ sizes, steps: plan.steps, connections: plan.connections, disconnects: plan.disconnects || [],
            models: Object.fromEntries(Object.entries(selected).map(([id, config]) => [id, { modelId: config.model.id, providerId: config.provider.id, thinking: config.thinking }])) });
        if (plan.appliedSignature === signature && plan.steps.every(step => state.nodes.has(plan.bindings?.[step.id]))) {
            if (await save() === false) throw new Error('方案保存失败，请重试');
            return plan;
        }
        const workflowId = getWorkflowId();
        for (const step of plan.steps) if (step.assetKey && !await getImageAsset(step.assetKey)) throw new Error('本地原图缺失，不能应用方案');
        if (!isCurrent()) throw new Error('读取素材期间会话已变化，未创建节点');
        if (getWorkflowId() !== workflowId) throw new Error('工作流已切换');
        if (JSON.stringify(executionConfigs.get(plan.id)) !== JSON.stringify({ models: state.models, providers: state.providers })) throw new Error('模型配置已变化，请检查模型后重新应用');
        assertCanvasPlanCurrent(plan, context());
        const bindings = { ...(plan.bindings || {}) };
        const originalPlan = cloneCanvasValue(plan);
        const createdNodes = [];
        const locked = [...documentRef.body.children].map(element => [element, element.inert]);
        locked.forEach(([element]) => { element.inert = true; });
        try {
            const result = await session().applyCanvasBatch(async () => {
                const start = origin();
                const occupied = [...state.nodes.values()].map(node => nodeBounds(node, state.canvas?.zoom || 1));
                if (start.blockedSpan) occupied.push({ y: start.y, height: 340, ...start.blockedSpan });
                for (const id of plan.order) {
                    const step = plan.steps.find(item => item.id === id);
                    let nodeId = step.nodeId || bindings[id];
                    if (!nodeId) {
                        const width = getNodeDefinition(step.type).defaultWidth || 300;
                        const parents = plan.connections.filter(link => link.to.ref === id).map(link =>
                            state.nodes.get(bindings[link.from.ref] || plan.steps.find(item => item.id === link.from.ref)?.nodeId || link.from.ref)).filter(Boolean);
                        const anchor = parents.sort((a, b) => b.x - a.x)[0];
                        const bounds = anchor && nodeBounds(anchor, state.canvas?.zoom || 1);
                        const position = findNearbyNodePosition({ x: bounds ? bounds.x + bounds.width + 80 : start.x,
                            y: bounds ? bounds.y : start.y, width, occupied });
                        const config = selected[id];
                        nodeId = addNode(step.type, position.x, position.y, { ...step.parameters, customTitle: step.title,
                            ...(config ? { apiConfigId: config.model.id, providerId: config.provider.id } : {}),
                            ...(step.assetKey ? { mediaAssetKeys: [step.assetKey], imageImportAssetKey: step.assetKey, imageAssetReady: true } : {}),
                            ...(step.autoAddedForGeneration ? { autoAddedForGeneration: true } : {}) }, true);
                        if (!nodeId || !state.nodes.has(nodeId)) throw new Error('节点创建失败');
                        createdNodes.push({ nodeId, type: step.type, autoAdded: step.autoAddedForGeneration });
                        occupied.push(nodeBounds(state.nodes.get(nodeId), state.canvas?.zoom || 1));
                    }
                    if (!state.nodes.has(nodeId)) throw new Error('方案绑定节点已删除，请刷新方案');
                    bindings[id] = nodeId;
                    if (step.type === 'ImageGenerate') {
                        const prompt = step.parameters.prompt ?? nodeAdapter.getContext(nodeId)?.prompt;
                        const patch = { targetNodeId: nodeId, prompt, ...(typeof step.negativePrompt === 'string' ? { negativePrompt: step.negativePrompt } : {}),
                            parameters: step.generationPatch || Object.fromEntries(Object.entries(step.parameters).filter(([key]) => generationFields[key]).map(([key, value]) => [generationFields[key], value])) };
                        patch.parameters = { ...patch.parameters, ...sizes[id].patch };
                        nodeAdapter.ensureTarget(patch, { modelId: selected[id].model.id, providerId: selected[id].provider.id });
                        state.nodes.get(nodeId).data.thinking = cloneCanvasValue(selected[id].thinking);
                        state.nodes.get(nodeId).el?._thinkingControl?.refresh();
                        if (!nodeAdapter.applyPromptPlan(patch)) throw new Error('生图参数不兼容');
                    } else for (const [field, value] of Object.entries(step.parameters)) {
                        if (field === 'inputCount') {
                            if (step.nodeId && value !== state.nodes.get(nodeId)?.data?.inputCount) throw new Error('已有合并节点的输入数量请在节点上调整');
                            continue;
                        }
                        const control = documentRef.getElementById(`${nodeId}-${controlFields[field]}`);
                        if (!control) throw new Error(`节点不支持参数 ${field}`);
                        if (control.options && ![...control.options].some(option => option.value === String(value) && !option.disabled)) throw new Error(`参数 ${field} 的值不受支持`);
                        if (control.type === 'checkbox') {
                            if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`);
                            control.checked = value;
                        } else {
                            if (control.type === 'number' && (!Number.isFinite(Number(value)) || (control.min && Number(value) < Number(control.min)) || (control.max && Number(value) > Number(control.max)))) throw new Error(`参数 ${field} 超出范围`);
                            control.value = String(value);
                        }
                        control.dispatchEvent(new documentRef.defaultView.Event('input', { bubbles: true }));
                        control.dispatchEvent(new documentRef.defaultView.Event('change', { bubbles: true }));
                    }
                }
                state.connections = projectPlanConnections(plan, state.connections, ref => bindings[ref] || ref).map(link => ({...link,id:link.id || `conn_${crypto.randomUUID()}`}));
                graphChanged();
                plan.bindings = bindings; plan.appliedSignature = signature; plan.appliedSizes = cloneCanvasValue(sizes);
                plan.referenceManifest = referenceManifest(context().nodes, state.connections, plan.steps.filter(s=>s.type==='ImageGenerate').map(s=>bindings[s.id]),Object.values(bindings));
                plan.dependencies = [...new Set([...plan.dependencies, ...Object.values(bindings)])];
                plan.baseline = canvasBaseline(context(), plan.dependencies, Object.values(bindings));
                onPlanChange();
                return {};
            }, save);
            plan.bindings = bindings; plan.historyId = result.historyId; plan.appliedSignature = signature;
            plan.dependencies = [...new Set([...plan.dependencies, ...Object.values(bindings)])];
            plan.baseline = canvasBaseline(context(), plan.dependencies, Object.values(bindings));
        } catch (error) {
            Object.keys(plan).forEach(key => delete plan[key]); Object.assign(plan, originalPlan); onPlanChange(); throw error;
        } finally { locked.forEach(([element, inert]) => { element.inert = inert; }); }
        const target = createdNodes.find(node => node.type === 'ImageGenerate')
            || createdNodes.find(node => !node.autoAdded && node.type !== 'ImageImport')
            || createdNodes[0];
        if (target) {
            try { focusNode(target.nodeId); } catch (error) { console.warn('无法定位新建节点', error); }
        }
        return plan;
    }
    function canUndo(plan) {
        if (activePlan || state.runningNodeIds?.size || state.canvasPlanApplying) return '有节点正在运行或应用';
        let latest; try { latest = JSON.parse(state.undoStack.at(-1) || '{}').historyId; } catch { /* old entry */ }
        return plan.historyId && latest === plan.historyId ? '' : '需先撤销后续修改，或本次撤销记录已不可用';
    }
    async function execute(plan, { retainResults, retry = false } = {}) {
        if (activePlan) throw new Error('另一个方案正在运行');
        assertCanvasPlanCurrent(plan, context());
        const validateInputs = () => {
            assertCanvasPlanCurrent(plan, context());
            const actual = referenceManifest(context().nodes, state.connections, plan.steps.filter(s=>s.type==='ImageGenerate').map(s=>plan.bindings[s.id]),Object.values(plan.bindings));
            if (!plan.referenceManifest || JSON.stringify(actual)!==JSON.stringify(plan.referenceManifest)) throw new Error('参考图输入与已确认方案不一致，请重新应用方案。');
        };
        validateInputs();
        const selectedNodeIds = plan.order.filter(id => plan.steps.find(step => step.id === id)?.execute !== false
            && (!retry || !plan.completedSteps?.includes(id))).map(id => plan.bindings[id]);
        if (!selectedNodeIds.length) throw new Error('没有待执行步骤');
        activePlan = plan;
        try { return await runWorkflow({ mode: 'selected-only', selectedNodeIds, agentSequential: true }, { retainResults, configurationSnapshot: executionConfigs.get(plan.id), validateBeforeRun: validateInputs }); }
        finally { activePlan = null; executionConfigs.delete(plan.id); }
    }
    return { context, prepare, describe: (plan, defaultModelId) => {
            const lines = describeCanvasPlan(plan, context());
            if (defaultModelId) try {
                const selected = modelsFor(plan, defaultModelId);
                const label = value => !value || value.mode === 'default' ? '接口默认' : String(value.value ?? value.mode);
                for (const step of plan.steps.filter(item => item.type === 'ImageGenerate')) {
                    const before = state.nodes.get(step.nodeId || plan.bindings?.[step.id])?.data?.thinking;
                    const node = state.nodes.get(step.nodeId || plan.bindings?.[step.id]);
                    const oldProvider = state.providers.find(provider => provider.id === node?.data?.providerId);
                    lines.push(`${step.title} · 供应商：${oldProvider?.name || node?.data?.providerId || '未设置'} → ${selected[step.id].provider.name || selected[step.id].provider.id}`);
                    lines.push(`${step.title} · 思考设置：${label(before)} → ${label(selected[step.id].thinking)}`);
                }
            } catch (error) { lines.push(error.message); }
            try { for (const [id, size] of Object.entries(sizesFor(plan, defaultModelId))) lines.push(`${plan.steps.find(step => step.id === id).title} · 尺寸：${size.summary}`); }
            catch (error) { lines.push(error.message); }
            return lines;
        }, apply, execute, modelsFor, sizesFor, canUndo,
        readImage: getImageAsset,
        inputs: plan => {
            const current = context();
            const identity = ref => plan.steps.find(step => step.id === ref)?.nodeId || plan.bindings?.[ref] || ref;
            const links = projectPlanConnections(plan,current.connections,identity).map(link=>({...link,from:{ref:link.from.nodeId,port:link.from.port},to:{ref:link.to.nodeId,port:link.to.port}}));
            return links.filter(link => isReferencePort(link.to.port)
                && plan.steps.some(step => identity(step.id) === link.to.ref && step.type === 'ImageGenerate')).map(link => {
                const step = plan.steps.find(item => identity(item.id) === link.from.ref);
                const node = current.nodes.find(item => item.id === link.from.ref);
                return { name: step?.title || node?.name || link.from.ref,
                    assetKey: step?.assetKey || node?.assets?.[0], purpose: plan.steps.find(item => identity(item.id) === link.to.ref)?.title,
                    upstream: Boolean(step && step.type !== 'ImageImport') };
            });
        },
        isRunning: id => activePlan?.id === id,
        executionRecord: (plan, id) => {
            const nodeId = plan.bindings[id];
            return { referenceInputs: cloneCanvasValue(plan.referenceManifest?.find(item=>item.nodeId===nodeId)?.inputs || []), size: cloneCanvasValue(plan.appliedSizes?.[id]?.effective || null), thinking: cloneCanvasValue(state.nodes.get(nodeId)?.data?.thinking || { mode: 'default' }), modelId: documentRef.getElementById(`${nodeId}-apiconfig`)?.value || '', providerId: documentRef.getElementById(`${nodeId}-provider`)?.value || '' };
        },
        stepStatus: (plan, id) => {
            const node = state.nodes.get(plan.bindings?.[id]);
            if (activePlan?.id === plan.id && getWorkflowId() === plan.workflowId) {
                if (state.runningNodeIds?.has(node?.id) || node?.el?.classList.contains('running')) return 'running';
                if (node?.isSucceeded) return 'completed';
                if (node?.executionFailure) return 'failed';
            }
            return plan.runs?.at(-1)?.steps?.find(step => step.id === id)?.status || (plan.bindings?.[id] ? 'applied' : 'draft');
        },
        refresh: plan => {
            if (activePlan) throw new Error('请等待当前方案执行结束');
            if (plan.workflowId !== getWorkflowId() || plan.dependencies.some(id => !state.nodes.has(id))) throw new Error('相关节点已删除或工作流已切换，请重新提出方案');
            if (prepare(cloneCanvasValue(plan)).steps.length !== plan.steps.length) throw new Error('自动保存节点需求已变化，请重新整理方案');
            validateGraph(plan);
            plan.baseline = canvasBaseline(context(), plan.dependencies, Object.values(plan.bindings || {}));
            delete plan.appliedSignature;
        },
        focus: focusNode, stop: plan => Object.values(plan.bindings || {}).forEach(cancelNode),
        undo: async plan => { const reason = canUndo(plan); if (reason) throw new Error(reason); await session().undo(); } };
}
