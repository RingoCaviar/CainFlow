function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeReferenceImages(images = []) {
    const seen = new Set();
    return images
        .filter((image) => typeof image?.dataUrl === 'string' && image.dataUrl.startsWith('data:image/'))
        .map((image) => ({
            name: String(image.name || '参考图'),
            type: String(image.type || 'image/*'),
            dataUrl: image.dataUrl
        }))
        .filter((image) => {
            if (seen.has(image.dataUrl)) return false;
            seen.add(image.dataUrl);
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
            ['name', 'type', 'sourceNodeId', 'sourcePort', 'targetPort', 'assetKeys'].forEach((key) => {
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
    let messages = [];
    let panelWidth = null;
    let referenceImages = [];

    function contextLength() {
        return memory.length + messages.reduce((total, message) => total
            + message.text.length
            + (message.referenceImages || []).reduce((length, image) => length + image.name.length + 8, 0)
            + 8, 0);
    }

    function compress() {
        while (contextLength() > limit && messages.length > 1) {
            const oldest = messages.shift();
            const plan = oldest.promptPlan;
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
        memory = typeof value?.memory === 'string' ? value.memory : '';
        messages = Array.isArray(value?.messages) ? value.messages.map(normalizeMessage) : [];
        referenceImages = normalizeReferenceImages([
            ...(Array.isArray(value?.referenceImages) ? value.referenceImages : []),
            ...messages.flatMap((message) => message.referenceImages || [])
        ]);
        panelWidth = Number.isFinite(Number(value?.panelWidth)) && Number(value.panelWidth) > 0
            ? Math.round(Number(value.panelWidth))
            : null;
        compress();
    }

    function snapshot() {
        const snapshot = { version: 1, memory, messages: clone(messages), panelWidth };
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
        return context.length > limit ? context.slice(-limit) : context;
    }

    function getReferenceImages() {
        return clone(normalizeReferenceImages([
            ...referenceImages,
            ...messages.flatMap((message) => message.referenceImages || [])
        ]));
    }

    function setPanelWidth(width) {
        const next = Math.round(Number(width));
        if (!Number.isFinite(next) || next <= 0 || next === panelWidth) return false;
        panelWidth = next;
        return true;
    }

    return { append, restore, snapshot, getContext, getReferenceImages, setPanelWidth };
}
