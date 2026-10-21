/** Prepare automatic save nodes on the editable workflow before its run snapshot. */
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

function getSavePosition(state, node) {
    const zoom = Number(state.canvas?.zoom) || 1;
    const width = Number(node.width) || Number(node.el?.getBoundingClientRect?.().width) / zoom || 240;
    const x = node.x + width + 80;
    let y = node.y;
    // A disabled old save often occupies the natural position. Keep it intact
    // and place the new enabled save below it instead of covering its controls.
    let collision;
    do {
        collision = [...state.nodes.values()].find((candidate) => (
            x < candidate.x + (candidate.width || 240) && x + 240 > candidate.x
            && y < candidate.y + (candidate.height || 340) && y + 340 > candidate.y
        ));
        if (collision) y = collision.y + (collision.height || 340) + 40;
    } while (collision);
    return { x, y };
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
    addNode,
    generateId,
    onConnectionsChanged = () => {},
    scheduleSave = () => {},
    addLog = () => {},
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
    const automaticSaveIds = new Set();
    const changedNodeIds = new Set();
    const connectionIds = [];
    let graphChanged = false;
    try {
        for (const nodeId of sourceNodeIds) {
            if (!isWorkflowCurrent()) throw new Error('工作流已切换，请在当前工作流重新运行。');
            const node = state.nodes.get(nodeId);
            const port = getGenerationOutputPort(node);
            const targets = getEnabledOutputTargets(state, node);
            if (targets.length === 0) {
                const position = getSavePosition(state, node);
                const saveId = addNode('ImageSave', position.x, position.y, {
                    autoAddedForGeneration: true,
                    enabled: true
                });
                const saveNode = state.nodes.get(saveId);
                if (!saveNode || saveNode.type !== 'ImageSave') {
                    throw new Error('无法创建自动保存节点，请检查工作流后重试。');
                }
                saveNode.autoAddedForGeneration = true;
                const connectionId = `conn_${generateId()}`;
                state.connections.push({
                    id: connectionId,
                    from: { nodeId, port, type: port },
                    to: { nodeId: saveId, port, type: port },
                    type: port
                });
                graphChanged = true;
                changedNodeIds.add(nodeId);
                changedNodeIds.add(saveId);
                connectionIds.push(connectionId);
                automaticSaveIds.add(saveId);
                addLog('info', '自动添加保存节点', `已为「${node.customTitle || node.defaultTitle || node.type}」添加保存节点`);
            } else {
                targets.forEach((connection) => automaticSaveIds.add(connection.to.nodeId));
            }
        }
    } finally {
        if (graphChanged) {
            onConnectionsChanged({ nodeIds: [...changedNodeIds], connectionIds });
            scheduleSave();
        }
    }
    const includedAutoSaveNodeIds = getIncludedAutoSaveNodeIds(state, sourceNodeIds, automaticSaveIds);
    return { ...runOptions, includedAutoSaveNodeIds };
}
