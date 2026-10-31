/** Preserve execution of existing legacy save targets without modifying the graph. */
export function getGenerationOutputPort(node) {
    if (node?.type === 'ImageGenerate') return 'image';
    if (node?.type === 'VideoGenerate') return 'video';
    return '';
}

function getEnabledOutputTargets(state, sourceNode) {
    const port = getGenerationOutputPort(sourceNode);
    if (!port) return [];
    return (state.connections || []).filter((connection) => {
        if (connection.from?.nodeId !== sourceNode.id || connection.from?.port !== port) return false;
        const target = state.nodes.get(connection.to?.nodeId);
        return target && target.id !== sourceNode.id && target.enabled !== false;
    });
}

export function getIncludedAutoSaveNodeIds(state, sourceNodeIds, requestedNodeIds) {
    const requested = new Set(requestedNodeIds || []);
    const included = new Set();
    for (const nodeId of sourceNodeIds) {
        const source = state.nodes.get(nodeId);
        if (!source || source.enabled === false || !getGenerationOutputPort(source)) continue;
        for (const connection of getEnabledOutputTargets(state, source)) {
            const target = state.nodes.get(connection.to.nodeId);
            if (requested.has(target.id) && target.type === 'ImageSave'
                && target.autoAddedForGeneration === true
                && connection.to.port === getGenerationOutputPort(source)) {
                included.add(target.id);
            }
        }
    }
    return [...included];
}

export function prepareGenerationSaveTargets({
    state,
    runInput = null,
    resolveExecutionPlan,
    normalizeRunOptions,
    isWorkflowCurrent = () => true
}) {
    if (!isWorkflowCurrent()) throw new Error('工作流已切换，请在当前工作流重新运行。');
    const runOptions = normalizeRunOptions(runInput);
    const plan = resolveExecutionPlan(runOptions);
    if (!plan) return runOptions;
    const runnableNodeIds = (plan.executionOrder || plan.nodeIds || []).filter((nodeId) => {
        const node = state.nodes.get(nodeId);
        return node && node.enabled !== false;
    });
    if (runnableNodeIds.some((nodeId) => state.runningNodeIds?.has(nodeId)
        || state.nodes.get(nodeId)?.el?.classList?.contains?.('running'))) {
        throw new Error('当前运行范围内有节点仍在运行，请等待完成后再运行。');
    }
    const sourceNodeIds = runnableNodeIds.filter((nodeId) => getGenerationOutputPort(state.nodes.get(nodeId)));
    const automaticSaveIds = sourceNodeIds.flatMap(nodeId =>
        getEnabledOutputTargets(state, state.nodes.get(nodeId)).map(connection => connection.to.nodeId));
    const includedAutoSaveNodeIds = getIncludedAutoSaveNodeIds(state, sourceNodeIds, automaticSaveIds);
    return { ...runOptions, includedAutoSaveNodeIds };
}
