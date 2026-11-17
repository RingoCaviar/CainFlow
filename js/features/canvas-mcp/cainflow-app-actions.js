const appActionArguments = {
    create_workflow: ['name'],
    list_history: ['id', 'offset', 'limit'],
    annotate_history: ['id', 'fileVersion', 'note'],
    import_history: ['items'],
    list_prompts: ['query', 'offset', 'limit'],
    save_prompt: ['name', 'content'],
    apply_prompt: ['nodeId', 'promptId', 'name', 'target'],
    run_canvas: ['nodeIds', 'targetNodeId'],
    stop_workflow: ['nodeIds'],
    undo_canvas: [],
    redo_canvas: []
};

const canvasActionMethods = new Set(['import_history', 'apply_prompt', 'run_canvas', 'stop_workflow', 'undo_canvas', 'redo_canvas']);

export function canvasRevisionFingerprint(context) {
    const nodes = context.nodes.map(({ running, ...node }) => node);
    return JSON.stringify([context.workflowId, nodes, context.connections, context.summary.selectedIds, context.commerceRunSettings]);
}

export function resolveCanvasRunInput(context, { nodeIds, targetNodeId }) {
    if (targetNodeId !== undefined) {
        if (nodeIds !== undefined || typeof targetNodeId !== 'string' || !context.nodes.some(node => node.id === targetNodeId)) {
            throw new Error('请指定当前工作流中的一个运行终点。');
        }
        return { mode: 'target-node', targetNodeId };
    }
    if (nodeIds === undefined) return null;
    const ids = new Set(context.nodes.map(node => node.id));
    if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > 100
        || new Set(nodeIds).size !== nodeIds.length || nodeIds.some(id => !ids.has(id))) {
        throw new Error('请选择当前工作流中的 1 至 100 个不同节点。');
    }
    return { mode: 'selected-only', selectedNodeIds: nodeIds.slice() };
}

export function createCainflowAppActions({ createEmptyWorkflow, listHistoryImages, annotateHistoryImage, importHistory, promptLibrary,
    prepareApplyPrompt, applyCanvasPlan, runCanvas, stopCanvas, changeCanvasHistory, onHistoryNote = () => {} }) {
    const supports = method => Object.hasOwn(appActionArguments, method);
    const usesCanvas = method => canvasActionMethods.has(method);

    async function dispatch(method, args = {}, { isCurrent = () => true, context, preview = false } = {}) {
        if (!supports(method)) throw new Error('未知的 CainFlow 应用操作。');
        if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !appActionArguments[method].includes(key))) throw new Error('CainFlow 应用操作参数无效。');
        if (!isCurrent()) throw new Error('CainFlow 会话已变化，请重新发起操作。');
        if (usesCanvas(method) && !context?.workflowId) throw new Error('请先打开要编辑的 CainFlow 工作流。');
        const scope = { context, isCurrent };
        if (method === 'run_canvas') return { started: await runCanvas(resolveCanvasRunInput(context, args), scope) === true };
        if (method === 'stop_workflow') {
            const input = resolveCanvasRunInput(context, args);
            return { stopped: await stopCanvas(input?.selectedNodeIds, scope) };
        }
        if (method === 'undo_canvas' || method === 'redo_canvas') {
            const changed = await changeCanvasHistory(method === 'undo_canvas' ? 'undo' : 'redo', scope);
            return { changed: changed === true };
        }
        if (method === 'create_workflow') return createEmptyWorkflow({ name: args.name, isCurrent });
        if (method === 'list_history') return listHistoryImages(args);
        if (method === 'annotate_history') {
            const result = await annotateHistoryImage(args, { isCurrent });
            // The metadata is persisted at this point. A display refresh can fail independently.
            void Promise.resolve().then(() => onHistoryNote(result)).catch(() => {});
            return result;
        }
        if (method === 'import_history') return importHistory(args, scope);
        if (method === 'list_prompts') return promptLibrary().listPrompts(args);
        if (method === 'apply_prompt') {
            const prepared = await prepareApplyPrompt(args, { context, isCurrent });
            if (!isCurrent()) throw new Error('CainFlow 会话已变化，请重新发起操作。');
            if (preview) return prepared;
            const { plan, ...details } = prepared;
            await applyCanvasPlan(plan, isCurrent);
            return { ...details, workflowId: context.workflowId };
        }
        return promptLibrary().upsertPrompt(args, { isCurrent });
    }
    return { supports, usesCanvas, dispatch };
}
