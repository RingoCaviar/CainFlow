import { getPromptAgentReferenceKey } from './prompt-agent-conversation-store.js';

function emptyUsage() {
    return {
        bytes: 0,
        workflowCount: 0,
        messageCount: 0,
        activeMessageCount: 0,
        archivedMessageCount: 0,
        referenceCount: 0,
        summaryCount: 0
    };
}

function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function records(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hasPlan(value) {
    return isRecord(value) && Object.keys(value).length > 0;
}

function measureConversation(conversation) {
    const usage = emptyUsage();
    if (!isRecord(conversation)) return usage;

    const messages = records(conversation.messages);
    const archivedMessages = records(conversation.archivedMessages);
    const allMessages = [...archivedMessages, ...messages];
    const references = [
        ...records(conversation.referenceImages),
        ...records(conversation.previousPromptPlan?.referenceImages),
        ...allMessages.flatMap((message) => [
            ...records(message.referenceImages),
            ...records(message.promptPlan?.referenceImages)
        ])
    ];
    usage.activeMessageCount = messages.length;
    usage.archivedMessageCount = archivedMessages.length;
    usage.messageCount = allMessages.length;
    usage.referenceCount = new Set(references
        .filter((image) => typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/'))
        .map(getPromptAgentReferenceKey)).size;
    usage.summaryCount = [conversation.memory, conversation.contextSummary]
        .filter((summary) => typeof summary === 'string' && summary.trim()).length;

    const containsPlan = hasPlan(conversation.previousPromptPlan)
        || allMessages.some((message) => hasPlan(message.promptPlan));
    if (!usage.messageCount && !usage.referenceCount && !usage.summaryCount && !containsPlan) return usage;

    // Count the complete persisted JSON, including repeated image payloads and
    // archived turns. Context compaction does not delete those saved records.
    const serialized = JSON.stringify(conversation);
    if (typeof serialized !== 'string') throw new TypeError('Agent 缓存无法序列化。');
    usage.bytes = new TextEncoder().encode(serialized).length;
    usage.workflowCount = 1;
    return usage;
}

export function getPromptAgentCacheUsage({
    workflows = [],
    activeWorkflowId = '',
    activeConversation = null
} = {}) {
    const conversations = new Map();
    for (const workflow of Array.isArray(workflows) ? workflows : []) {
        if (!isRecord(workflow)) continue;
        const workflowId = workflow.workflowId || workflow.data?.workflowId;
        // Old tabs without an identity are independent records. Never merge
        // them with the active tab just because both identities are absent.
        const identity = workflowId ? String(workflowId) : workflow;
        conversations.set(identity, workflow.data?.promptAgent);
    }

    const activeIdentity = activeWorkflowId ? String(activeWorkflowId) : Symbol('active-agent-conversation');
    if (activeWorkflowId || activeConversation !== null) conversations.set(activeIdentity, activeConversation);

    const total = emptyUsage();
    let current = emptyUsage();
    for (const [identity, conversation] of conversations) {
        const usage = measureConversation(conversation);
        for (const key of Object.keys(total)) total[key] += usage[key];
        if (identity === activeIdentity) current = usage;
    }
    return { total, current };
}
