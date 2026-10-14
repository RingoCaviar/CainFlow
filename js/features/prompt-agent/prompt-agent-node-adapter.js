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

function readBoolean(documentRef, id, fallback = false) {
    const control = documentRef.getElementById(id);
    return control ? control.checked === true : fallback === true;
}

function writeBoolean(documentRef, id, value, createEvent) {
    const control = documentRef.getElementById(id);
    if (!control || value === undefined || value === null) return false;
    control.checked = value === true;
    control.dispatchEvent?.(createEvent('change'));
    return true;
}

function getReferenceImageDescriptor(state, connection) {
    const sourceNode = state.nodes?.get(connection.from?.nodeId);
    const images = [
        ...(Array.isArray(sourceNode?.data?.images) ? sourceNode.data.images : []),
        ...(Array.isArray(sourceNode?.data?.imageList) ? sourceNode.data.imageList : []),
        sourceNode?.data?.image,
        sourceNode?.imageData,
        sourceNode?.resizePreviewData
    ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
    const assetKeys = [
        ...(Array.isArray(sourceNode?.data?.mediaAssetKeys) ? sourceNode.data.mediaAssetKeys : []),
        sourceNode?.data?.imageImportAssetKey,
        sourceNode?.data?.imageAssetKey
    ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
    return {
        sourceNodeId: connection.from?.nodeId || '',
        sourcePort: connection.from?.port || '',
        targetPort: connection.to.port,
        assetKeys,
        images
    };
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
            .map((connection) => getReferenceImageDescriptor(state, connection));
        const protocolParams = { ...(node.data?.protocolParams || {}) };
        return {
            nodeId: node.id,
            prompt: readValue(documentRef, `${node.id}-prompt`, node.data?.prompt || ''),
            negativePrompt: readValue(documentRef, `${node.id}-param-negative_prompt`, node.data?.promptAgentNegativePrompt || ''),
            parameters: {
                aspectRatio: readValue(documentRef, `${node.id}-aspect`, node.data?.aspect || ''),
                resolution: readValue(documentRef, `${node.id}-resolution`, node.data?.resolution || ''),
                customWidth: readValue(documentRef, `${node.id}-custom-resolution-width`, node.data?.customWidth || ''),
                customHeight: readValue(documentRef, `${node.id}-custom-resolution-height`, node.data?.customHeight || ''),
                quality: readValue(documentRef, `${node.id}-quality`, node.data?.quality || ''),
                moderation: readValue(documentRef, `${node.id}-moderation`, node.data?.moderation || ''),
                background: readValue(documentRef, `${node.id}-background`, node.data?.background || ''),
                search: readBoolean(documentRef, `${node.id}-search`, node.data?.search),
                count: Math.max(1, parseInt(readValue(documentRef, `${node.id}-generation-count`, node.data?.generationCount || '1'), 10) || 1),
                protocolParams
            },
            referenceImages
        };
    }

    function applyPromptPlan(plan = {}) {
        const node = getSelectedNode();
        if (!node || !plan.targetNodeId || node.id !== plan.targetNodeId) return false;
        node.data ||= {};
        node.data.prompt = String(plan.prompt || '');
        node.data.protocolParams = {
            ...(node.data.protocolParams || {}),
            ...(plan.parameters?.protocolParams || {}),
            negative_prompt: String(plan.negativePrompt || '')
        };
        writeValue(documentRef, `${node.id}-prompt`, plan.prompt || '', createEvent);
        writeValue(documentRef, `${node.id}-param-negative_prompt`, plan.negativePrompt || '', createEvent);
        writeValue(documentRef, `${node.id}-aspect`, plan.parameters?.aspectRatio, createEvent);
        writeValue(documentRef, `${node.id}-resolution`, plan.parameters?.resolution, createEvent);
        writeValue(documentRef, `${node.id}-custom-resolution-width`, plan.parameters?.customWidth, createEvent);
        writeValue(documentRef, `${node.id}-custom-resolution-height`, plan.parameters?.customHeight, createEvent);
        writeValue(documentRef, `${node.id}-quality`, plan.parameters?.quality, createEvent);
        writeValue(documentRef, `${node.id}-moderation`, plan.parameters?.moderation, createEvent);
        writeValue(documentRef, `${node.id}-background`, plan.parameters?.background, createEvent);
        writeBoolean(documentRef, `${node.id}-search`, plan.parameters?.search, createEvent);
        Object.entries(plan.parameters?.protocolParams || {}).forEach(([paramId, value]) => {
            writeValue(documentRef, `${node.id}-param-${paramId}`, value, createEvent);
        });
        writeValue(documentRef, `${node.id}-generation-count`, plan.parameters?.count, createEvent);
        scheduleSave();
        return true;
    }

    return { getSelectedContext, applyPromptPlan };
}
