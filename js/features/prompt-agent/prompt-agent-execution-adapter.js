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

    async function applyAndGenerate(plan = {}) {
        const nodeId = plan.targetNodeId;
        if (!nodeAdapter?.applyPromptPlan?.(plan)) {
            throw new Error('目标不再是当前选中的生图节点，请重新选择后再试。');
        }
        stopRequests.delete(nodeId);
        const result = await runWorkflow({ mode: 'selected-only', selectedNodeIds: [nodeId] });
        if (stopRequests.delete(nodeId)) return { status: 'stopped', images: [] };
        if (result?.outcome === 'stopped' || result?.outcome === 'cancelled') {
            return { status: 'stopped', images: [] };
        }
        if (result?.outcome === 'timeout') {
            throw new Error('生成超时，请检查节点配置或稍后重试。');
        }
        if (!result?.started || result?.executed === false || result?.reason === 'error' || result?.outcome === 'failed') {
            throw new Error('生成失败，请检查节点配置后重试。');
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
