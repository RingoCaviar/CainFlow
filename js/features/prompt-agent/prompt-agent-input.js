function isImageSource(source, protocol) {
    return typeof source === 'string' && (/^data:image\/[^;]+;base64,/i.test(source)
        || (protocol !== 'google' && /^https:\/\//i.test(source)));
}

function projectHistory(conversation, images) {
    const history = [];
    let omitted = false;
    const messages = Array.isArray(conversation?.messages) ? conversation.messages.map((message, index) => ({
        ...message, messageNumber: (conversation.archivedMessages?.length || 0) + index + 1
    })) : [];
    if (conversation?.previousPromptPlan && !messages.some((message) => message.promptPlan)) {
        messages.unshift({ role: 'agent', text: '压缩前保留的上一版草稿，未确认已应用。', promptPlan: conversation.previousPromptPlan });
    }
    for (const message of messages.slice().reverse()) {
        const content = JSON.stringify({
            messageNumber: message.messageNumber,
            message: String(message.text || ''),
            ...(message.intent ? { intent: message.intent } : {}),
            ...(message.promptPlan ? { promptPlan: {
                targetNodeId: message.promptPlan.targetNodeId || null,
                prompt: message.promptPlan.prompt,
                negativePrompt: message.promptPlan.negativePrompt,
                parameters: message.promptPlan.parameters || {},
                referenceImages: (message.promptPlan.referenceImages || []).map((image) => ({
                    name: image.name, role: image.role, sourceNodeId: image.sourceNodeId,
                    imageId: images.find((entry) => entry.source === image.dataUrl || (image.referenceId && entry.reference.referenceId === image.referenceId))?.imageId || null
                }))
            } } : {}),
            ...(message.referenceImages?.length ? { referenceImages: message.referenceImages.map((image, index) => ({
                referenceNumber: index + 1,
                name: image.name,
                imageId: images.find((entry) => entry.source === image.dataUrl)?.imageId || null
            })) } : {})
        });
        history.unshift({ role: message.role === 'agent' ? 'assistant' : 'user', content });
    }
    // A compressed conversation may begin with the latest draft. Keep it.
    if (history[0]?.role === 'assistant') {
        history.unshift({ role: 'user', content: '以下是当前工作流保留的对话片段，更早的请求已省略。' });
    }
    return { history, omitted };
}

export function createPromptAgentInput({
    message = '', context = null, conversation = null, workflowMemory = '',
    referenceImages = [], workflowReferenceImages = [], model
} = {}) {
    const images = [];
    const bySource = new Map();
    const addImage = (image, origin, connectedToNode = false, referenceNumber = null) => {
        const sources = image.dataUrl ? [image.dataUrl] : (image.images?.length ? image.images : Array(Math.max(1, image.assetKeys?.length || 0)).fill(null));
        sources.forEach((source, index) => {
            let key = source || image.referenceId || `${image.sourceNodeId || ''}:${image.sourcePort || ''}:${image.name || ''}:${index}`;
            const existing = bySource.get(key);
            // Two equal-pixel outputs still occupy two user-visible batch slots.
            if (image.latestResult && existing?.latestResult && existing.runId === image.runId
                && existing.resultNumber !== image.resultNumber) key = `${key}\0${image.runId}:${image.resultNumber}`;
            let entry = bySource.get(key);
            if (!entry) {
                entry = {
                    imageId: `image-${images.length + 1}`,
                    name: image.name || `${origin} ${images.length + 1}`,
                    origins: [],
                    ...(image.selectedOnCanvas ? { selectedOnCanvas: true } : {}),
                    ...(image.runId ? { runId: image.runId, resultNumber: image.resultNumber, messageNumber: image.messageNumber, prompt: image.prompt } : {}),
                    connectedToNode: false,
                    visionAvailable: model?.capabilities?.imageInput !== false && isImageSource(source, model?.protocol),
                    reference: { ...image, ...(source ? { dataUrl: source } : {}), sourceImageIndex: image.sourceImageIndex ?? index },
                    source
                };
                images.push(entry);
                bySource.set(key, entry);
            }
            if (image.runId) {
                entry.resultSources ||= [];
                if (!entry.resultSources.some(item => item.runId === image.runId && item.resultNumber === image.resultNumber)) {
                    entry.resultSources.push({ runId: image.runId, resultNumber: image.resultNumber, messageNumber: image.messageNumber });
                }
                if (image.latestResult || !entry.runId) {
                    Object.assign(entry, { runId: image.runId, resultNumber: image.resultNumber,
                        messageNumber: image.messageNumber, prompt: image.prompt,
                        latestResult: Boolean(image.latestResult), reference: { ...image, ...(source ? { dataUrl: source } : {}), sourceImageIndex: image.sourceImageIndex ?? index } });
                }
            }
            if (!entry.origins.includes(origin)) entry.origins.push(origin);
            entry.connectedToNode ||= connectedToNode;
            if (referenceNumber !== null) {
                entry.referenceNumbers ||= [];
                entry.referenceNumbers.push(referenceNumber);
            }
        });
    };
    referenceImages.forEach((image, index) => addImage(image, '本轮附件', false, index + 1));
    (context?.referenceImages || []).forEach((image) => addImage(image, '节点输入', true));
    (context?.outputImages || []).forEach((image) => addImage(image, '节点生成结果'));
    workflowReferenceImages.forEach((image) => addImage(image, image.contextOrigin || '历史附件'));
    const media = [];
    const imageCatalog = images.map(({ source, reference, ...entry }) => {
        if (entry.visionAvailable) {
            media.push({ type: 'image', url: source });
            entry.attachmentIndex = media.length;
        }
        return entry;
    });
    const { history, omitted } = projectHistory(conversation, images);
    const input = {
        currentNode: context ? {
            nodeId: context.nodeId,
            prompt: context.prompt || '',
            negativePrompt: context.negativePrompt || '',
            parameters: context.parameters || {},
            parameterSchema: context.parameterSchema || {},
            model: context.model || null
        } : null,
        contextSummary: String(conversation?.contextSummary || ''),
        workflowMemory: String(conversation?.memory ?? workflowMemory),
        // Keep the user's per-message image numbering without resending any
        // archived dialogue. Pixel attachments are resolved by the catalog.
        earlierReferenceTurns: (conversation?.archivedMessages || []).flatMap((turn, index) => (
            turn.referenceImages?.length ? [{
                messageNumber: index + 1,
                referenceImages: turn.referenceImages.map((image, referenceIndex) => ({
                    referenceNumber: referenceIndex + 1,
                    name: image.name,
                    imageId: images.find((entry) => entry.source === image.dataUrl)?.imageId || null
                }))
            }] : []
        )),
        historyOmitted: omitted,
        images: imageCatalog,
        latestResultImageIds: images.filter(image => image.latestResult).map(image => image.imageId),
        userRequest: String(message || '').trim() || '本轮只提供了图片，请结合对话确定用途；用途不明时询问。'
    };
    return {
        messages: [...history, { role: 'user', content: JSON.stringify(input) }],
        media,
        images
    };
}
