function getNodeImages(node) {
    const candidates = [node?.data?.images, node?.data?.imageList, node?.generatedImages, node?.imageDataList, node?.data?.image, node?.imageData];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate.filter((value) => typeof value === 'string' && value);
        if (typeof candidate === 'string' && candidate) return [candidate];
    }
    return [];
}

export function createPromptAgentExecutionAdapter({
    state,
    nodeAdapter,
    runWorkflow,
    cancelRunningNode = () => false,
    focusNode = () => false
} = {}) {
    const stopRequests = new Set();

    async function applyAndGenerate(plan = {}, { retainResults } = {}) {
        const nodeId = plan.targetNodeId;
        if (!nodeAdapter?.applyPromptPlan?.(plan)) {
            throw new Error('目标生图节点已不存在，或方案参数已不适用，请重新整理方案。');
        }
        stopRequests.delete(nodeId);
        const result = await runWorkflow({ mode: 'selected-only', selectedNodeIds: [nodeId] }, { retainResults });
        if (stopRequests.delete(nodeId)) return { status: 'stopped', images: [] };
        if (result?.outcome === 'stopped' || result?.outcome === 'cancelled') {
            return { status: 'stopped', images: [] };
        }
        if (result?.outcome === 'timeout') {
            throw new Error('生成超时，请检查节点配置或稍后重试。');
        }
        const nodeResult = result?.nodeResults?.find((entry) => entry.nodeId === nodeId);
        if (!result?.started || result?.executed === false || result?.reason === 'error' || result?.outcome === 'failed') {
            throw new Error(nodeResult?.error || result?.error || '请检查节点配置后重试。');
        }
        if (Array.isArray(result?.nodeResults)) {
            return {
                status: 'completed',
                ...(result.workflowId ? { workflowId: result.workflowId } : {}),
                images: nodeResult?.images || [],
                ...Object.fromEntries(['mediaAssetKeys', 'mediaOwnershipTemporaryOwners', 'persistenceStatus', 'persistenceError']
                    .filter((key) => nodeResult?.[key] !== undefined).map((key) => [key, nodeResult[key]])),
                ...(result.agentResult || {}),
                ...(result.resultRetentionError ? { persistenceStatus: 'failed', persistenceError: result.resultRetentionError } : {})
            };
        }
        const node = state?.nodes?.get(nodeId);
        return { status: 'completed', images: getNodeImages(node) };
    }

    function stop(nodeId) {
        stopRequests.add(nodeId);
        const stopped = cancelRunningNode(nodeId);
        if (!stopped) stopRequests.delete(nodeId);
        return stopped;
    }

    return {
        applyAndGenerate,
        stop,
        focus: (nodeId) => focusNode(nodeId)
    };
}
