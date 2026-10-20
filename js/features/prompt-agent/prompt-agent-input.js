const HISTORY_CHARACTER_LIMIT = 16000;

function isImageSource(source, protocol) {
    return typeof source === 'string' && (/^data:image\/[^;]+;base64,/i.test(source)
        || (protocol !== 'google' && /^https:\/\//i.test(source)));
}

function projectHistory(conversation, images) {
    const history = [];
    let length = 0;
    let omitted = false;
    const messages = Array.isArray(conversation?.messages) ? conversation.messages.map((message, index) => ({
        ...message, messageNumber: (conversation.archivedMessages?.length || 0) + index + 1
    })) : [];
    if (conversation?.previousPromptPlan && !messages.some((message) => message.promptPlan)) {
        messages.unshift({ role: 'agent', text: '压缩前保留的上一版草稿，未确认已应用。', promptPlan: conversation.previousPromptPlan });
    }
    const latestPlanMessage = messages.findLast((message) => message.promptPlan);
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
                    name: image.name, role: image.role, sourceNodeId: image.sourceNodeId
                }))
            } } : {}),
            ...(message.referenceImages?.length ? { referenceImages: message.referenceImages.map((image, index) => ({
                referenceNumber: index + 1,
                name: image.name,
                imageId: images.find((entry) => entry.source === image.dataUrl)?.imageId || null
            })) } : {})
        });
        if (length + content.length > HISTORY_CHARACTER_LIMIT && message !== latestPlanMessage) {
            omitted = true;
            // Continue looking for the complete latest draft even if recent
            // discussion has already exhausted the ordinary history budget.
            continue;
        }
        history.unshift({ role: message.role === 'agent' ? 'assistant' : 'user', content });
        length += content.length;
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
        const sources = image.dataUrl ? [image.dataUrl] : (image.images?.length ? image.images : [null]);
        sources.forEach((source, index) => {
            const key = source || `${image.sourceNodeId || ''}:${image.sourcePort || ''}:${image.name || ''}:${index}`;
            let entry = bySource.get(key);
            if (!entry) {
                entry = {
                    imageId: `image-${images.length + 1}`,
                    name: image.name || `${origin} ${images.length + 1}`,
                    origins: [],
                    connectedToNode: false,
                    visionAvailable: model?.capabilities?.imageInput !== false && isImageSource(source, model?.protocol),
                    reference: image,
                    source
                };
                images.push(entry);
                bySource.set(key, entry);
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
    workflowReferenceImages.forEach((image) => addImage(image, '历史附件'));
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
        workflowMemory: String(conversation?.memory ?? workflowMemory).slice(-4000),
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
        userRequest: String(message || '').trim() || '本轮只提供了图片，请结合对话确定用途；用途不明时询问。'
    };
    return {
        messages: [...history, { role: 'user', content: JSON.stringify(input) }],
        media,
        images
    };
}
