function readValue(documentRef, id, fallback = '') {
    const value = documentRef.getElementById(id)?.value;
    return value === undefined || value === null ? fallback : value;
}

function writeValue(documentRef, id, value, createEvent) {
    const control = documentRef.getElementById(id);
    if (!control || value === undefined || value === null) return false;
    control.value = String(value);
    control.dispatchEvent?.(createEvent('input'));
    control.dispatchEvent?.(createEvent('change'));
    return true;
}

export function createPromptAgentNodeAdapter({
    state,
    documentRef = document,
    scheduleSave = () => {},
    createEvent = (type) => new Event(type, { bubbles: true })
} = {}) {
    function getSelectedNode() {
        const selectedIds = Array.from(state?.selectedNodes || []);
        if (selectedIds.length !== 1) return null;
        const node = state?.nodes?.get(selectedIds[0]);
        return node?.type === 'ImageGenerate' ? node : null;
    }

    function getSelectedContext() {
        const node = getSelectedNode();
        if (!node) return null;
        const referenceImages = (state.connections || [])
            .filter((connection) => connection?.to?.nodeId === node.id && /^image_\d+$/.test(connection?.to?.port || ''))
            .map((connection) => ({
                sourceNodeId: connection.from?.nodeId || '',
                sourcePort: connection.from?.port || '',
                targetPort: connection.to.port
            }));
        return {
            nodeId: node.id,
            prompt: readValue(documentRef, `${node.id}-prompt`, node.data?.prompt || ''),
            negativePrompt: readValue(documentRef, `${node.id}-param-negative_prompt`, node.data?.promptAgentNegativePrompt || ''),
            parameters: {
                aspectRatio: readValue(documentRef, `${node.id}-aspect`, node.data?.aspect || ''),
                resolution: readValue(documentRef, `${node.id}-resolution`, node.data?.resolution || ''),
                count: Math.max(1, parseInt(readValue(documentRef, `${node.id}-generation-count`, node.data?.generationCount || '1'), 10) || 1)
            },
            referenceImages
        };
    }

    function applyPromptPlan(plan = {}) {
        const node = getSelectedNode();
        if (!node || !plan.targetNodeId || node.id !== plan.targetNodeId) return false;
        node.data ||= {};
        node.data.prompt = String(plan.prompt || '');
        node.data.promptAgentNegativePrompt = String(plan.negativePrompt || '');
        writeValue(documentRef, `${node.id}-prompt`, plan.prompt || '', createEvent);
        writeValue(documentRef, `${node.id}-param-negative_prompt`, plan.negativePrompt || '', createEvent);
        writeValue(documentRef, `${node.id}-aspect`, plan.parameters?.aspectRatio, createEvent);
        writeValue(documentRef, `${node.id}-resolution`, plan.parameters?.resolution, createEvent);
        writeValue(documentRef, `${node.id}-generation-count`, plan.parameters?.count, createEvent);
        scheduleSave();
        return true;
    }

    return { getSelectedContext, applyPromptPlan };
}
