function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeMessage(message = {}) {
    return {
        role: message.role === 'agent' ? 'agent' : 'user',
        text: String(message.text || ''),
        ...(Array.isArray(message.workSummary) ? { workSummary: message.workSummary.map(String) } : {}),
        ...(message.promptPlan ? { promptPlan: clone(message.promptPlan) } : {})
    };
}

export function createPromptAgentConversationStore({ maxContextCharacters = 4000 } = {}) {
    const limit = Math.max(64, Number(maxContextCharacters) || 4000);
    let memory = '';
    let messages = [];
    let panelWidth = null;

    function contextLength() {
        return memory.length + messages.reduce((total, message) => total + message.text.length + 8, 0);
    }

    function compress() {
        while (contextLength() > limit && messages.length > 1) {
            const oldest = messages.shift();
            const plan = oldest.promptPlan;
            const creativeSummary = plan
                ? [
                    plan.prompt ? `画面方向：${plan.prompt}` : '',
                    plan.negativePrompt ? `避免：${plan.negativePrompt}` : '',
                    Object.keys(plan.parameters || {}).length ? `参数：${JSON.stringify(plan.parameters)}` : ''
                ].filter(Boolean).join('；')
                : (oldest.role === 'user' ? `创作要求：${oldest.text}` : '');
            if (creativeSummary) memory = `${memory}；${creativeSummary}`.replace(/^；/, '');
            const memoryLimit = Math.max(32, Math.floor(limit / 2));
            if (memory.length > memoryLimit) memory = memory.slice(-memoryLimit);
        }
    }

    function append(message) {
        const normalized = normalizeMessage(message);
        if (!normalized.text && !normalized.promptPlan) return;
        messages.push(normalized);
        compress();
    }

    function restore(value) {
        memory = typeof value?.memory === 'string' ? value.memory : '';
        messages = Array.isArray(value?.messages) ? value.messages.map(normalizeMessage) : [];
        panelWidth = Number.isFinite(Number(value?.panelWidth)) && Number(value.panelWidth) > 0
            ? Math.round(Number(value.panelWidth))
            : null;
        compress();
    }

    function snapshot() {
        return { version: 1, memory, messages: clone(messages), panelWidth };
    }

    function getContext() {
        const context = [
            memory ? `工作流记忆：${memory}` : '',
            ...messages.map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${message.text}`)
        ].filter(Boolean).join('\n');
        return context.length > limit ? context.slice(-limit) : context;
    }

    function setPanelWidth(width) {
        const next = Math.round(Number(width));
        if (!Number.isFinite(next) || next <= 0 || next === panelWidth) return false;
        panelWidth = next;
        return true;
    }

    return { append, restore, snapshot, getContext, setPanelWidth };
}
