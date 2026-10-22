import { stampResultCompletion } from './prompt-agent-result-order.js';
import { normalizeAgentSearch } from './prompt-agent-search-data.js';
import { restoreCanvasPlan } from './prompt-agent-canvas-plan.js';

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

const RUN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'stopped', 'interrupted']);
const PERSISTENCE_STATUSES = new Set(['pending', 'retained', 'failed', 'saved']);

function normalizeAssetKeys(keys) {
    return Array.isArray(keys) ? keys.filter((key) => typeof key === 'string' && key.startsWith('media:')) : [];
}

function normalizeRun(run, { interruptRunning = false } = {}) {
    if (!run || typeof run.runId !== 'string' || !run.runId.trim()) return null;
    let status = RUN_STATUSES.has(run.status) ? run.status : 'running';
    if (interruptRunning && (status === 'running' || status === 'pending')) status = 'interrupted';
    const owners = Array.isArray(run.mediaOwnershipTemporaryOwners)
        ? run.mediaOwnershipTemporaryOwners.filter((owner) => typeof owner?.ownerId === 'string' && owner.ownerId)
            .map((owner) => ({ ownerId: owner.ownerId, assetKeys: normalizeAssetKeys(owner.assetKeys) }))
        : [];
    return {
        runId: run.runId.trim(),
        targetNodeId: typeof run.targetNodeId === 'string' ? run.targetNodeId : '',
        status,
        ...(Number.isSafeInteger(run.completionOrder) && run.completionOrder > 0 ? { completionOrder: run.completionOrder } : {}),
        mediaAssetKeys: normalizeAssetKeys(run.mediaAssetKeys),
        ...(typeof run.error === 'string' && run.error ? { error: run.error } : {}),
        ...(PERSISTENCE_STATUSES.has(run.persistenceStatus) ? { persistenceStatus: run.persistenceStatus } : {}),
        ...(typeof run.persistenceError === 'string' && run.persistenceError ? { persistenceError: run.persistenceError } : {}),
        ...(owners.length ? { mediaOwnershipTemporaryOwners: owners } : {})
    };
}

function normalizeMessage(message = {}, options = {}) {
    return {
        role: message.role === 'agent' ? 'agent' : 'user',
        text: String(message.text || ''),
        ...(message.search ? { search: normalizeAgentSearch(message.search) } : {}),
        ...(typeof message.intent === 'string' ? { intent: message.intent } : {}),
        ...(Array.isArray(message.referenceImages) ? {
            referenceImages: normalizeReferenceImages(message.referenceImages)
        } : {}),
        ...(Array.isArray(message.workSummary) ? { workSummary: message.workSummary.map(String) } : {}),
        ...(message.promptPlan ? { promptPlan: normalizePromptPlan(message.promptPlan) } : {}),
        ...(message.canvasPlan ? { canvasPlan: options.interruptRunning ? restoreCanvasPlan(message.canvasPlan) : clone(message.canvasPlan) } : {}),
        ...(message.nodeMentions ? { nodeMentions: clone(message.nodeMentions) } : {}),
        ...(Array.isArray(message.runs) ? { runs: message.runs.map((run) => normalizeRun(run, options)).filter(Boolean) } : {})
    };
}

export function createPromptAgentConversationStore() {
    let memory = '';
    let contextSummary = '';
    let messages = [];
    let archivedMessages = [];
    let compactedMessageCount = 0;
    let imageModelId = '';
    let thinkingSettings = { chat: {}, image: {} };
    let searchSettings = { mode: 'auto', modelId: '' };
    let referenceImages = [];
    let previousPromptPlan = null;

    function append(message) {
        const normalized = normalizeMessage(message);
        if (!normalized.text && !normalized.promptPlan && !normalized.canvasPlan && !normalized.referenceImages?.length && !normalized.runs?.length) return;
        messages.push(normalized);
        return archivedMessages.length + messages.length - 1;
    }

    function bindPromptPlanTarget(messageIndex, targetNodeId) {
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || !targetNodeId) return false;
        const message = messageIndex < archivedMessages.length
            ? archivedMessages[messageIndex] : messages[messageIndex - archivedMessages.length];
        const plan = message?.promptPlan;
        if (!plan || (plan.targetNodeId && plan.targetNodeId !== targetNodeId)) return false;
        plan.targetNodeId = targetNodeId;
        if (messageIndex < archivedMessages.length && latestPromptPlan(archivedMessages) === plan) {
            previousPromptPlan = normalizePromptPlan(plan);
        }
        return true;
    }

    function findRun(runId) {
        if (typeof runId !== 'string' || !runId) return null;
        for (const message of [...archivedMessages, ...messages]) {
            const run = message.runs?.find((candidate) => candidate.runId === runId);
            if (run) return run;
        }
        return null;
    }

    function getRun(runId) {
        return clone(findRun(runId));
    }

    function beginRun(messageIndex, run) {
        if (!Number.isInteger(messageIndex) || messageIndex < 0) return false;
        const normalized = normalizeRun(run);
        if (!normalized || findRun(normalized.runId)) return false;
        const message = messageIndex < archivedMessages.length
            ? archivedMessages[messageIndex] : messages[messageIndex - archivedMessages.length];
        if (!message || message.role !== 'agent') return false;
        (message.runs ||= []).push(normalized);
        return true;
    }

    function finishRun(runId, outcome = {}) {
        const run = findRun(runId);
        if (!run) return false;
        // Once captured, a batch belongs to this attempt forever. Saving may
        // retry, but a later generation must use a separate run identity.
        if (run.mediaAssetKeys.length && Array.isArray(outcome.mediaAssetKeys)
            && JSON.stringify(normalizeAssetKeys(outcome.mediaAssetKeys)) !== JSON.stringify(run.mediaAssetKeys)) return false;
        const next = normalizeRun({ ...run, ...outcome, runId: run.runId, targetNodeId: run.targetNodeId });
        if (run.completionOrder) next.completionOrder = run.completionOrder;
        stampResultCompletion({ archivedMessages, messages }, next);
        Object.keys(run).forEach((key) => { delete run[key]; });
        Object.assign(run, next);
        return true;
    }

    function restore(value, { interruptRunning = false } = {}) {
        const restoredSummary = value?.contextSummary === undefined || value?.contextSummary === ''
            ? ''
            : normalizeContextSummary(value.contextSummary);
        const restoredMessages = Array.isArray(value?.messages) ? value.messages.map((message) => normalizeMessage(message, { interruptRunning })) : [];
        const restoredArchive = Array.isArray(value?.archivedMessages) ? value.archivedMessages.map((message) => normalizeMessage(message, { interruptRunning })) : [];
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
        imageModelId = typeof value?.imageModelId === 'string' ? value.imageModelId.trim() : '';
        thinkingSettings = { chat: clone(value?.thinkingSettings?.chat || {}), image: clone(value?.thinkingSettings?.image || {}) };
        setSearchSettings(value?.searchSettings);
    }

    function snapshot() {
        const snapshot = { version: 1, memory, messages: clone(messages) };
        if (Object.keys(thinkingSettings.chat).length || Object.keys(thinkingSettings.image).length) snapshot.thinkingSettings = clone(thinkingSettings);
        if (searchSettings.mode !== 'auto' || searchSettings.modelId) snapshot.searchSettings = { ...searchSettings };
        if (imageModelId) snapshot.imageModelId = imageModelId;
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
        const recentContext = context;
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

    function getImageModelId() {
        return imageModelId;
    }

    function setImageModelId(value) {
        const next = typeof value === 'string' ? value.trim() : '';
        if (next === imageModelId) return false;
        imageModelId = next;
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

    function removeNodeReferences(nodeIds) {
        const removed = new Set(nodeIds);
        let changed = false;
        const prune = (images) => {
            const next = images.filter((image) => !removed.has(image.sourceNodeId));
            changed ||= next.length !== images.length;
            return next;
        };
        const prunePlan = (plan) => {
            if (Array.isArray(plan?.referenceImages)) plan.referenceImages = prune(plan.referenceImages);
        };
        referenceImages = prune(referenceImages);
        for (const message of [...messages, ...archivedMessages]) {
            if (Array.isArray(message.referenceImages)) message.referenceImages = prune(message.referenceImages);
            prunePlan(message.promptPlan);
        }
        prunePlan(previousPromptPlan);
        return changed;
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

    function setSearchSettings(value = {}) {
        searchSettings = { mode: value?.mode === 'off' ? 'off' : 'auto', modelId: typeof value?.modelId === 'string' ? value.modelId.trim() : '' };
    }

    const getThinking = (purpose, modelId) => clone(thinkingSettings[purpose]?.[modelId] || null) || undefined;
    const setThinking = (purpose, modelId, value) => { if (!modelId || !thinkingSettings[purpose]) return; if (value) thinkingSettings[purpose][modelId] = clone(value); else delete thinkingSettings[purpose][modelId]; };
    return { getThinking, setThinking, append, bindPromptPlanTarget, beginRun, finishRun, getRun, restore, snapshot, getContext, getReferenceImages, getCompactionContext, getImageModelId, setImageModelId, compact, clear, removeNodeReferences,
        upgradePromptPlan: (index, plan) => {
            const message = [...archivedMessages, ...messages][index];
            if (!message?.promptPlan || message.runs?.some(run => run.status === 'running')) return false;
            message.canvasPlan = clone(plan); delete message.promptPlan; return true;
        },
        updateCanvasPlan: (id, plan) => {
            const message = [...archivedMessages, ...messages].find(item => item.canvasPlan?.id === id);
            if (!message) return false;
            message.canvasPlan = clone(plan); return true;
        },
        getSearchSettings: () => ({ ...searchSettings }), setSearchSettings };
}
