function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeContextSummary(summary) {
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('上下文摘要不能为空。');
    const normalized = summary.trim();
    if (normalized.length > 3000) throw new Error('上下文摘要不能超过 3000 字符。');
    return normalized;
}

function latestPromptPlan(messages) {
    return messages.findLast((message) => message.promptPlan)?.promptPlan || null;
}

export function getPromptAgentReferenceKey(image) {
    return image?.referenceId || image?.dataUrl || `${image?.sourceNodeId || ''}:${image?.sourcePort || ''}:${image?.name || ''}`;
}

function normalizeReferenceImages(images = []) {
    const seen = new Set();
    return images
        .filter((image) => typeof image?.dataUrl === 'string' && image.dataUrl.startsWith('data:image/'))
        .map((image) => ({
            name: String(image.name || '参考图'),
            type: String(image.type || 'image/*'),
            dataUrl: image.dataUrl,
            ...(image.referenceId ? { referenceId: String(image.referenceId) } : {}),
            ...(image.sourceNodeId ? { sourceNodeId: String(image.sourceNodeId), sourceImageIndex: Number(image.sourceImageIndex) || 0 } : {})
        }))
        .filter((image) => {
            const key = getPromptAgentReferenceKey(image);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function normalizePromptPlan(plan) {
    const normalized = clone(plan);
    if (!normalized || typeof normalized !== 'object') return normalized;
    if (!Array.isArray(normalized.referenceImages)) return normalized;
    normalized.referenceImages = normalized.referenceImages
        .filter((image) => image && typeof image === 'object')
        .map((image) => {
            const safe = {};
            ['name', 'type', 'referenceId', 'sourceNodeId', 'sourceImageIndex', 'sourcePort', 'targetPort', 'assetKeys', 'imageId', 'role', 'imageCount'].forEach((key) => {
                if (image[key] !== undefined && image[key] !== null) safe[key] = clone(image[key]);
            });
            if (Array.isArray(image.images)) safe.imageCount = image.images.length;
            return safe;
        });
    return normalized;
}

function normalizeMessage(message = {}) {
    return {
        role: message.role === 'agent' ? 'agent' : 'user',
        text: String(message.text || ''),
        ...(typeof message.intent === 'string' ? { intent: message.intent } : {}),
        ...(Array.isArray(message.referenceImages) ? {
            referenceImages: normalizeReferenceImages(message.referenceImages)
        } : {}),
        ...(Array.isArray(message.workSummary) ? { workSummary: message.workSummary.map(String) } : {}),
        ...(message.promptPlan ? { promptPlan: normalizePromptPlan(message.promptPlan) } : {})
    };
}

export function createPromptAgentConversationStore({ maxContextCharacters = 4000 } = {}) {
    const limit = Math.max(64, Number(maxContextCharacters) || 4000);
    let memory = '';
    let contextSummary = '';
    let messages = [];
    let archivedMessages = [];
    let compactedMessageCount = 0;
    let panelWidth = null;
    let referenceImages = [];
    let previousPromptPlan = null;

    function contextLength() {
        return memory.length + messages.reduce((total, message) => total
            + message.text.length
            + (message.referenceImages || []).reduce((length, image) => length + image.name.length + 8, 0)
            + 8, 0);
    }

    function compress() {
        while (contextLength() > limit && messages.length > 1) {
            const oldest = messages.shift();
            archivedMessages.push(oldest);
            const plan = oldest.promptPlan;
            if (plan) previousPromptPlan = normalizePromptPlan(plan);
            referenceImages = normalizeReferenceImages([
                ...referenceImages,
                ...(oldest.referenceImages || [])
            ]);
            const referenceSummary = oldest.referenceImages?.length
                ? `参考图：${oldest.referenceImages.map((image) => image.name).join('、')}`
                : '';
            const creativeSummary = plan
                ? [
                    plan.prompt ? `画面方向：${plan.prompt}` : '',
                    plan.negativePrompt ? `避免：${plan.negativePrompt}` : '',
                    Object.keys(plan.parameters || {}).length ? `参数：${JSON.stringify(plan.parameters)}` : ''
                ].filter(Boolean).join('；')
                : (oldest.role === 'user' ? [`创作要求：${oldest.text}`, referenceSummary].filter(Boolean).join('；') : '');
            if (creativeSummary) memory = `${memory}；${creativeSummary}`.replace(/^；/, '');
            const memoryLimit = Math.max(32, Math.floor(limit / 2));
            if (memory.length > memoryLimit) memory = memory.slice(-memoryLimit);
        }
    }

    function append(message) {
        const normalized = normalizeMessage(message);
        if (!normalized.text && !normalized.promptPlan && !normalized.referenceImages?.length) return;
        messages.push(normalized);
        compress();
    }

    function restore(value) {
        const restoredSummary = value?.contextSummary === undefined || value?.contextSummary === ''
            ? ''
            : normalizeContextSummary(value.contextSummary);
        const restoredMessages = Array.isArray(value?.messages) ? value.messages.map(normalizeMessage) : [];
        const restoredArchive = Array.isArray(value?.archivedMessages) ? value.archivedMessages.map(normalizeMessage) : [];
        const restoredCompactedCount = value?.compactedMessageCount === undefined
            ? (restoredSummary ? restoredArchive.length : 0)
            : value.compactedMessageCount;
        if (!Number.isInteger(restoredCompactedCount) || restoredCompactedCount < 0
            || restoredCompactedCount > restoredArchive.length || (restoredCompactedCount > 0 && !restoredSummary)) {
            throw new Error('已压缩的归档消息数量无效。');
        }
        const restoredReferences = normalizeReferenceImages([
            ...(Array.isArray(value?.referenceImages) ? value.referenceImages : []),
            ...restoredArchive.flatMap((message) => message.referenceImages || []),
            ...restoredMessages.flatMap((message) => message.referenceImages || [])
        ]);
        const restoredPlan = value?.previousPromptPlan
            ? normalizePromptPlan(value.previousPromptPlan)
            : normalizePromptPlan(latestPromptPlan(restoredArchive));
        memory = typeof value?.memory === 'string' ? value.memory : '';
        contextSummary = restoredSummary;
        messages = restoredMessages;
        archivedMessages = restoredArchive;
        compactedMessageCount = restoredCompactedCount;
        referenceImages = restoredReferences;
        previousPromptPlan = restoredPlan;
        panelWidth = Number.isFinite(Number(value?.panelWidth)) && Number(value.panelWidth) > 0
            ? Math.round(Number(value.panelWidth))
            : null;
        compress();
    }

    function snapshot() {
        const snapshot = { version: 1, memory, messages: clone(messages), panelWidth };
        if (contextSummary) {
            snapshot.contextSummary = contextSummary;
            snapshot.compactedMessageCount = compactedMessageCount;
        }
        if (archivedMessages.length) snapshot.archivedMessages = clone(archivedMessages);
        // Compaction may remove the last draft before a short follow-up. Keep
        // that complete draft separately only while no retained turn has one.
        if (previousPromptPlan && !messages.some((message) => message.promptPlan)) {
            snapshot.previousPromptPlan = clone(previousPromptPlan);
        }
        if (referenceImages.length) snapshot.referenceImages = clone(referenceImages);
        return snapshot;
    }

    function getContext() {
        const context = [
            memory ? `工作流记忆：${memory}` : '',
            ...messages.map((message) => {
                const references = message.referenceImages?.length
                    ? ` [参考图：${message.referenceImages.map((image) => image.name).join('、')}]`
                    : '';
                return `${message.role === 'user' ? '用户' : 'Agent'}：${message.text}${references}`;
            })
        ].filter(Boolean).join('\n');
        const recentContext = context.length > limit ? context.slice(-limit) : context;
        return [contextSummary ? `上下文摘要：${contextSummary}` : '', recentContext].filter(Boolean).join('\n');
    }

    function getReferenceImages() {
        return clone(normalizeReferenceImages([
            ...referenceImages,
            ...messages.flatMap((message) => message.referenceImages || [])
        ]));
    }

    function getCompactionContext() {
        const context = snapshot();
        const archive = context.archivedMessages || [];
        // Automatic trimming retains original turns for a future semantic
        // compaction. Only the prefix covered by a checkpoint stays excluded.
        context.messages = [...archive.slice(compactedMessageCount), ...context.messages];
        context.archivedMessages = archive.slice(0, compactedMessageCount);
        return context;
    }

    function setPanelWidth(width) {
        const next = Math.round(Number(width));
        if (!Number.isFinite(next) || next <= 0 || next === panelWidth) return false;
        panelWidth = next;
        return true;
    }

    function compact(summary) {
        // Validate and prepare replacement state before touching live history.
        const normalizedSummary = normalizeContextSummary(summary);
        const preservedPlan = normalizePromptPlan(latestPromptPlan(messages) || previousPromptPlan || latestPromptPlan(archivedMessages));
        const preservedReferences = getReferenceImages();
        const preservedArchive = [...archivedMessages, ...messages];
        contextSummary = normalizedSummary;
        memory = '';
        messages = [];
        archivedMessages = preservedArchive;
        compactedMessageCount = preservedArchive.length;
        previousPromptPlan = preservedPlan;
        referenceImages = preservedReferences;
    }

    function clear() {
        memory = '';
        contextSummary = '';
        messages = [];
        archivedMessages = [];
        compactedMessageCount = 0;
        referenceImages = [];
        previousPromptPlan = null;
    }

    return { append, restore, snapshot, getContext, getReferenceImages, getCompactionContext, setPanelWidth, compact, clear };
}
