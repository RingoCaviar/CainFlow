function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

import * as defaultConversationApi from '../../services/conversation-api.js';
import { createStagedConversationContext, snapshotWorkflowNode } from './conversation-context.js';

export function renderConversationMarkdown(source) {
    const protectedImages = [];
    let safe = escapeHtml(source).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match) => {
        const token = `\u0000IMAGE${protectedImages.length}\u0000`;
        protectedImages.push(match);
        return token;
    });
    safe = safe
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
            if (!/^https?:\/\//i.test(href)) return label;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
    return protectedImages.reduce((html, image, index) => html.replace(`\u0000IMAGE${index}\u0000`, image), safe);
}

function messageText(message) {
    return (message?.parts || []).filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
}

function renderMessageParts(message) {
    const text = renderConversationMarkdown(messageText(message));
    const attachments = (message?.parts || []).map((part, partIndex) => ({ part, partIndex }))
        .filter(({ part }) => part?.type !== 'text').map(({ part, partIndex }) => {
        const label = part.type === 'node-source' ? `${part.nodeType || '节点'} · ${part.nodeId || ''}` : `${part.mediaType || '媒体'} · ${part.assetKey || ''}`;
        if (part.missing) {
            const keys = part.missingAssetKeys?.length ? part.missingAssetKeys : [part.assetKey].filter(Boolean);
            return keys.map((key) => `<div class="conversation-missing-media">${escapeHtml(label)}<span>资源缺失</span><button class="btn btn-ghost" type="button" data-message-id="${escapeHtml(message.id)}" data-part-index="${partIndex}" data-recover-asset="${escapeHtml(key)}">恢复</button><button class="btn btn-ghost" type="button" data-message-id="${escapeHtml(message.id)}" data-part-index="${partIndex}" data-remove-missing="${escapeHtml(key)}">移除</button></div>`).join('');
        }
        return `<div class="conversation-message-attachment">${escapeHtml(label)}</div>`;
    }).join('');
    return text + attachments;
}

function statusLabel(status) {
    return ({ pending: '等待中', streaming: '生成中', completed: '已完成', partial: '部分回复', failed: '失败', cancelled: '已停止' })[status] || '就绪';
}

export function selectConversationBranch(messages = [], visibleVersions = new Map()) {
    const assistantGroups = new Map();
    for (const message of messages) {
        if (message.role !== 'assistant' || !message.parentMessageId) continue;
        if (!assistantGroups.has(message.parentMessageId)) assistantGroups.set(message.parentMessageId, []);
        assistantGroups.get(message.parentMessageId).push(message);
    }
    const selected = new Set([...assistantGroups].map(([parentId, group]) =>
        group[Math.max(0, Math.min(group.length - 1,
            visibleVersions.get(parentId) ?? group.length - 1))]?.id).filter(Boolean));
    return messages.filter((message) =>
        message.role !== 'assistant' || !message.parentMessageId || selected.has(message.id));
}

export function createConversationWorkbenchController({
    documentRef = document,
    api = defaultConversationApi,
    state = {},
    showToast = () => {},
    executionService = null,
    getHistoryEntry = async () => null,
    putMediaAsset = async () => null,
    removeMediaReference = async () => false,
    recoverMissingMedia = null,
    removeMissingMedia = null,
    materializeMessage = async () => null,
    promptRef = globalThis.prompt,
    confirmRef = globalThis.confirm,
    getActiveWorkflow = () => null,
    onToolbarStateChange = () => {}
} = {}) {
    let conversations = [];
    let activeConversation = null;
    let listStatus = 'active';
    const stagedContext = createStagedConversationContext();
    const visibleVersionByParent = new Map();

    const element = (id) => documentRef.getElementById(id);

    function getToolbarSnapshot() {
        const workflow = getActiveWorkflow();
        const activeId = activeConversation?.id || '';
        return {
            activeConversationId: activeId,
            title: activeConversation?.title || '新对话',
            workflowLabel: activeConversation?.workflowId && activeConversation.workflowId === workflow?.id
                ? workflow?.label || '当前工作流' : '画布',
            stagedContextCount: stagedContext.list().length,
            isRunning: Boolean(activeId && executionService?.getRunState(activeId))
        };
    }

    function publishToolbarState() {
        onToolbarStateChange(getToolbarSnapshot());
    }

    function renderModels() {
        const select = element('conversation-model');
        if (!select) return;
        const selected = activeConversation?.defaultModelId || '';
        select.innerHTML = '<option value="">选择模型</option>' + (state.models || []).map((model) => (
            `<option value="${escapeHtml(model.id)}"${model.id === selected ? ' selected' : ''}>${escapeHtml(model.name || model.modelId || model.id)}</option>`
        )).join('');
    }

    function renderList() {
        const list = element('conversation-list');
        if (!list) return;
        list.innerHTML = conversations.length ? conversations.map((conversation) => {
            const selected = conversation.id === activeConversation?.id;
            const running = conversation.runStatus === 'running';
            return `<button class="conversation-list-item${selected ? ' is-selected' : ''}" type="button" role="option" data-conversation-id="${escapeHtml(conversation.id)}" aria-selected="${selected}">
                <span class="conversation-list-item-title">${escapeHtml(conversation.title || '新对话')}</span>
                <span class="conversation-list-item-meta">${running ? '生成中' : escapeHtml(conversation.workflowLabel || '独立对话')}</span>
            </button>`;
        }).join('') : '<div class="conversation-list-empty">暂无对话</div>';
    }

    function renderMessages() {
        const container = element('conversation-messages');
        if (!container) return;
        const allMessages = activeConversation?.messages || [];
        const versionGroups = new Map();
        allMessages.filter((message) => message.role === 'assistant').forEach((message) => {
            const key = message.parentMessageId || message.id;
            if (!versionGroups.has(key)) versionGroups.set(key, []);
            versionGroups.get(key).push(message);
        });
        const messages = allMessages.filter((message) => {
            if (message.role !== 'assistant') return true;
            const group = versionGroups.get(message.parentMessageId || message.id);
            const selected = visibleVersionByParent.get(message.parentMessageId) ?? group.length - 1;
            return group.indexOf(message) === selected;
        });
        container.innerHTML = messages.length ? messages.map((message) => {
            const group = message.role === 'assistant' ? versionGroups.get(message.parentMessageId || message.id) : [];
            const versionIndex = group.indexOf(message);
            return (
            `<article class="conversation-message is-${escapeHtml(message.role)}" data-message-id="${escapeHtml(message.id)}" data-message-status="${escapeHtml(message.status)}">
                <header><strong>${message.role === 'assistant' ? '助手' : '你'}</strong><span>${group.length > 1 ? `版本 ${versionIndex + 1}/${group.length} · ` : ''}${statusLabel(message.status)}</span></header>
                <div class="conversation-message-content">${renderMessageParts(message)}</div>
                ${message.role === 'assistant' && ['completed', 'partial'].includes(message.status) ? `<footer class="conversation-message-actions">${group.length > 1 ? `<button class="btn btn-ghost" type="button" data-version-parent="${escapeHtml(message.parentMessageId)}" data-version-index="${Math.max(0, versionIndex - 1)}">上一版</button><button class="btn btn-ghost" type="button" data-version-parent="${escapeHtml(message.parentMessageId)}" data-version-index="${Math.min(group.length - 1, versionIndex + 1)}">下一版</button>` : ''}<button class="btn btn-ghost" type="button" data-regenerate-message="${escapeHtml(message.id)}">重新生成</button><button class="btn btn-ghost" type="button" data-materialize-message="${escapeHtml(message.id)}" data-text-node-type="Text">添加为 Text</button><button class="btn btn-ghost" type="button" data-materialize-message="${escapeHtml(message.id)}" data-text-node-type="TextChat">添加为 TextChat</button></footer>` : ''}
            </article>`);
        }).join('') : '<div class="conversation-empty-state"><strong>从一个明确的问题开始</strong><span>可以附加工作流节点、历史资源或本地媒体。</span></div>';
    }

    function renderStagedContext() {
        const container = element('conversation-staged-context');
        const summary = element('conversation-send-summary');
        const preview = element('conversation-send-preview');
        const items = stagedContext.list();
        if (container) container.innerHTML = items.map((item) => (
            `<span class="conversation-context-chip" data-staged-id="${escapeHtml(item.id)}">${escapeHtml(item.label || item.snapshot?.nodeType || item.mediaType || '资源')}<button type="button" aria-label="前移" data-move-staged="${escapeHtml(item.id)}" data-move-direction="-1">←</button><button type="button" aria-label="后移" data-move-staged="${escapeHtml(item.id)}" data-move-direction="1">→</button><button type="button" aria-label="移除 ${escapeHtml(item.label || '资源')}" data-remove-staged="${escapeHtml(item.id)}">×</button></span>`
        )).join('');
        if (summary) summary.textContent = items.length
            ? `本次将发送：历史范围 + 工作流摘要 + ${items.filter((item) => item.type === 'node-source').length} 个节点快照 + ${items.filter((item) => item.type === 'media').length} 项媒体`
            : '本次将发送：历史范围 + 文字';
        const workflow = getActiveWorkflow();
        const linkedWorkflow = workflow?.id && activeConversation?.workflowId === workflow.id ? workflow : null;
        const collection = state.connections || state.edges || [];
        const edgeCount = collection instanceof Map || collection instanceof Set ? collection.size : collection.length || 0;
        const nodeTypes = [...(state.nodes?.values?.() || [])].map((node) => node.type);
        const durableCount = (activeConversation?.messages || []).filter((message) =>
            ['user', 'assistant'].includes(message.role) && ['completed', 'partial'].includes(message.status)).length;
        if (preview) preview.innerHTML = [
            `<div><strong>历史范围</strong>：${durableCount} 条可用消息，超出上下文上限时从最早消息开始省略</div>`,
            linkedWorkflow
                ? `<div><strong>工作流</strong>：${escapeHtml(linkedWorkflow.id)} · revision ${escapeHtml(linkedWorkflow.revision ?? 0)} · 节点类型 ${escapeHtml([...new Set(nodeTypes)].join(', ') || '无')} · ${edgeCount} 条连接</div>`
                : '<div><strong>工作流</strong>：本次不发送</div>',
            ...items.map((item) => item.type === 'node-source'
                ? `<div><strong>${escapeHtml(item.label || item.snapshot?.nodeType || '节点')}</strong>：${escapeHtml(item.snapshot?.textSnapshot || '空快照')}</div>`
                : `<div><strong>媒体</strong>：${escapeHtml(item.label || item.assetKey || '资源')}</div>`)
        ].join('');
        publishToolbarState();
    }

    function stageSelectedNodes() {
        const workflow = getActiveWorkflow();
        if (!workflow?.id) return stagedContext.list();
        for (const nodeId of state.selectedNodes || []) {
            const node = state.nodes?.get?.(nodeId);
            if (!node) continue;
            const snapshot = snapshotWorkflowNode({ workflowId: workflow?.id, node });
            stagedContext.add({ id: `node:${workflow.id}:${nodeId}`, type: 'node-source', label: node.type, snapshot });
        }
        renderStagedContext();
        return stagedContext.list();
    }

    async function stageSelectedHistory() {
        for (const historyId of state.selectedHistoryIds || []) {
            const entry = await getHistoryEntry(historyId);
            const assetKey = entry?.videoAssetKey || entry?.imageAssetKey;
            if (!assetKey) continue;
            stagedContext.add({
                id: `history:${historyId}`,
                type: 'media',
                label: entry.prompt || `历史资源 ${historyId}`,
                assetKey,
                mediaType: entry.mediaType || (entry.videoAssetKey ? 'video' : 'image'),
                url: entry.image || entry.video || ''
            });
        }
        renderStagedContext();
        return stagedContext.list();
    }

    function stageMedia(item) {
        stagedContext.add(item);
        renderStagedContext();
        return stagedContext.list();
    }

    async function stageLocalImages(files) {
        for (const file of files || []) {
            if (!String(file.type || '').startsWith('image/')) continue;
            const ownerId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
            const asset = await putMediaAsset(file, 'conversation-staging', ownerId);
            if (!asset?.asset_key) throw new Error(`无法暂存图片：${file.name || '未命名图片'}`);
            stageMedia({
                id: `upload:${ownerId}`, type: 'media', label: file.name || '本地图片',
                assetKey: asset.asset_key, mediaType: 'image', stagingOwnerId: ownerId
            });
        }
        return stagedContext.list();
    }

    function renderActiveConversation() {
        const title = element('conversation-title');
        if (title) title.textContent = activeConversation?.title || '新对话';
        const status = element('conversation-status');
        if (status) status.textContent = activeConversation?.runStatus === 'running' ? '生成中' : '就绪';
        const lifecycleButton = element('conversation-lifecycle-action');
        if (lifecycleButton) lifecycleButton.textContent = ['archived', 'trashed'].includes(activeConversation?.status) ? '恢复' : '归档';
        const trashButton = element('conversation-trash');
        if (trashButton) trashButton.textContent = activeConversation?.status === 'trashed' ? '永久删除' : '移到回收站';
        renderModels();
        renderMessages();
        renderList();
        const workflow = getActiveWorkflow();
        const linkedToVisibleWorkflow = Boolean(activeConversation?.workflowId && activeConversation.workflowId === workflow?.id);
        const workflowSummary = element('conversation-workflow-summary');
        if (workflowSummary) workflowSummary.textContent = activeConversation?.workflowId
            ? `${linkedToVisibleWorkflow ? workflow.label || '当前工作流' : '关联的工作流当前不可用，请重新关联'} · revision ${workflow?.revision ?? 'unknown'} · ${linkedToVisibleWorkflow ? state.nodes?.size || 0 : 0} 个节点 · ${state.connections?.length || state.edges?.length || 0} 条连接`
            : '未关联工作流';
        const linkWorkflow = element('conversation-link-workflow');
        if (linkWorkflow) linkWorkflow.textContent = linkedToVisibleWorkflow ? '解除关联' : '关联当前';
        const nodeResources = element('conversation-node-resources');
        if (nodeResources) nodeResources.textContent = state.selectedNodes?.size
            ? `已选择 ${state.selectedNodes.size} 个节点，发送时生成快照`
            : '暂无已选择节点';
        const historyResources = element('conversation-history-resources');
        if (historyResources) historyResources.textContent = state.selectedHistoryIds?.size
            ? `已选择 ${state.selectedHistoryIds.size} 项历史资源`
            : '暂无已选择资源';
        const systemPrompt = element('conversation-system-prompt-summary');
        if (systemPrompt) systemPrompt.textContent = activeConversation?.systemPrompt
            ? activeConversation.systemPrompt.slice(0, 160)
            : '使用默认提示词';
        publishToolbarState();
    }

    async function refresh() {
        conversations = await api.listConversations({
            status: listStatus,
            workflowId: element('conversation-workflow-filter')?.value || '',
            search: element('conversation-search')?.value || ''
        });
        renderList();
        return conversations;
    }

    async function selectConversation(conversationId) {
        activeConversation = await api.getConversation(conversationId);
        renderActiveConversation();
        return activeConversation;
    }

    async function createConversation() {
        const workflow = getActiveWorkflow();
        const model = (state.models || [])[0];
        const created = await api.createConversation({
            title: '新对话',
            workflowId: workflow?.id || '',
            defaultModelId: model?.id || '',
            defaultProviderId: model?.providerId || ''
        });
        await refresh();
        await selectConversation(created.id);
        element('conversation-composer')?.focus?.();
        return created;
    }

    async function updateLifecycle(changes) {
        if (!activeConversation) return null;
        activeConversation = await api.updateConversation(activeConversation.id, {
            revision: activeConversation.revision,
            ...changes
        });
        renderActiveConversation();
        await refresh();
        return activeConversation;
    }

    async function permanentlyDeleteCurrent() {
        if (!activeConversation || activeConversation.status !== 'trashed') throw new Error('对话必须先移到回收站');
        const conversationId = activeConversation.id;
        await api.permanentlyDeleteConversation(conversationId, activeConversation.revision);
        activeConversation = null;
        await refresh();
        if (conversations[0]) await selectConversation(conversations[0].id);
        else renderActiveConversation();
        return conversationId;
    }

    function projectRunState(conversationId, runState) {
        const summary = conversations.find((item) => item.id === conversationId);
        if (summary) summary.runStatus = runState.status;
        if (activeConversation?.id === conversationId) {
            activeConversation.runStatus = runState.status;
            const status = element('conversation-status');
            if (status) status.textContent = statusLabel(runState.status);
            const sendButton = element('conversation-send');
            if (sendButton) sendButton.textContent = ['starting', 'running', 'streaming'].includes(runState.status) ? '停止' : '发送';
        }
        renderList();
        publishToolbarState();
    }

    async function sendCurrentMessage() {
        if (!activeConversation || !executionService) return null;
        const sendingConversation = {
            ...activeConversation,
            messages: selectConversationBranch(activeConversation.messages, visibleVersionByParent)
        };
        const composer = element('conversation-composer');
        const text = composer?.value?.trim() || '';
        if (!text) return null;
        const modelId = element('conversation-model')?.value || sendingConversation.defaultModelId;
        const model = (state.models || []).find((item) => item.id === modelId);
        const providerId = model?.providerId || model?.providerIds?.[0] || sendingConversation.defaultProviderId;
        const provider = (state.providers || []).find((item) => item.id === providerId);
        if (!model || !provider) throw new Error('请先选择可用的模型与 Provider');
        if (composer) composer.value = '';
        try {
            const workflow = getActiveWorkflow();
            const linkedWorkflow = workflow?.id && sendingConversation.workflowId === workflow.id ? workflow : null;
            const collection = state.connections || state.edges || [];
            const edges = collection instanceof Map ? [...collection.values()] : [...collection];
            const endpoint = (value) => typeof value === 'object' ? value?.nodeId || value?.id || '?' : value || '?';
            const connections = edges.map((edge) =>
                `${endpoint(edge.source || edge.from)}→${endpoint(edge.target || edge.to)}`);
            await executionService.send({
                conversation: sendingConversation, text, model, provider,
                contextParts: stagedContext.toMessageParts(),
                workflowSummary: linkedWorkflow ? {
                    workflowId: linkedWorkflow.id, revision: linkedWorkflow.revision,
                    nodeTypes: [...(state.nodes?.values?.() || [])].map((node) => node.type), connections
                } : null
            });
            await Promise.all(stagedContext.list().filter((item) => item.stagingOwnerId).map((item) => (
                removeMediaReference('conversation-staging', item.stagingOwnerId, item.assetKey)
            )));
            stagedContext.clear();
            renderStagedContext();
        } finally {
            if (activeConversation?.id === sendingConversation.id) await selectConversation(sendingConversation.id);
            else await refresh();
        }
        return activeConversation;
    }

    function setPaneExpanded(paneId, triggerId, expanded) {
        const pane = element(paneId);
        const trigger = element(triggerId);
        pane?.classList.toggle('is-collapsed', !expanded);
        if (pane) pane.inert = !expanded;
        trigger?.setAttribute('aria-expanded', String(expanded));
        const backdrop = element('conversation-drawer-backdrop');
        if (backdrop) backdrop.hidden = !expanded;
        if (!expanded) trigger?.focus?.();
    }

    function togglePane(kind) {
        const paneId = kind === 'list' ? 'conversation-list-pane' : 'conversation-context-pane';
        const triggerId = kind === 'list' ? 'conversation-list-toggle' : 'conversation-context-toggle';
        const pane = element(paneId);
        setPaneExpanded(paneId, triggerId, pane?.classList?.contains?.('is-collapsed'));
    }

    function stopCurrentRun() {
        if (!activeConversation || !executionService?.stop(activeConversation.id)) return false;
        publishToolbarState();
        return true;
    }

    function showExecutionRecord() {
        const execution = [...(activeConversation?.messages || [])].reverse().find((message) => message.execution)?.execution;
        showToast(execution
            ? `${execution.providerName || execution.providerId || 'Provider'} · ${execution.modelName || execution.modelId || 'Model'} · ${execution.status || 'completed'}`
            : '当前对话还没有执行记录', 'info');
    }

    function bind() {
        element('conversation-new')?.addEventListener('click', () => void createConversation().catch((error) => showToast(error.message, 'error')));
        element('conversation-search')?.addEventListener('input', () => void refresh().catch((error) => showToast(error.message, 'error')));
        element('conversation-workflow-filter')?.addEventListener('change', () => void refresh().catch((error) => showToast(error.message, 'error')));
        element('conversation-archive-entry')?.addEventListener('click', (event) => {
            listStatus = listStatus === 'active' ? 'archived' : listStatus === 'archived' ? 'trashed' : 'active';
            if (event.currentTarget) event.currentTarget.textContent = ({ active: '归档', archived: '回收站', trashed: '返回' })[listStatus];
            void refresh().catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-list')?.addEventListener('click', (event) => {
            const target = event.target?.closest?.('[data-conversation-id]');
            if (target?.dataset.conversationId) void selectConversation(target.dataset.conversationId).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-messages')?.addEventListener('click', (event) => {
            const recoveryKey = event.target?.dataset?.recoverAsset;
            if (recoveryKey) {
                const operation = recoverMissingMedia
                    ? recoverMissingMedia(recoveryKey)
                    : api.resolveConversationMessageMedia(activeConversation.id, event.target.dataset.messageId, {
                        revision: activeConversation.revision, partIndex: Number(event.target.dataset.partIndex),
                        assetKey: recoveryKey, action: 'recover'
                    });
                void operation.then(() => selectConversation(activeConversation.id))
                    .catch((error) => showToast(error.message, 'error'));
                return;
            }
            const removalKey = event.target?.dataset?.removeMissing;
            if (removalKey) {
                const operation = removeMissingMedia
                    ? removeMissingMedia({ conversation: activeConversation, assetKey: removalKey })
                    : api.resolveConversationMessageMedia(activeConversation.id, event.target.dataset.messageId, {
                        revision: activeConversation.revision, partIndex: Number(event.target.dataset.partIndex),
                        assetKey: removalKey, action: 'remove'
                    });
                void operation
                    .then(() => selectConversation(activeConversation.id)).catch((error) => showToast(error.message, 'error'));
                return;
            }
            if (event.target?.dataset?.versionParent) {
                visibleVersionByParent.set(event.target.dataset.versionParent, Number(event.target.dataset.versionIndex));
                renderMessages();
                return;
            }
            const regenerateMessageId = event.target?.dataset?.regenerateMessage;
            if (regenerateMessageId) {
                const model = (state.models || []).find((item) => item.id === activeConversation.defaultModelId);
                const providerId = model?.providerId || model?.providerIds?.[0] || activeConversation.defaultProviderId;
                const provider = (state.providers || []).find((item) => item.id === providerId);
                if (!model || !provider) { showToast('请先选择可用的模型与 Provider', 'error'); return; }
                const selectedConversation = {
                    ...activeConversation,
                    messages: selectConversationBranch(activeConversation.messages, visibleVersionByParent)
                };
                void executionService.regenerate({ conversation: selectedConversation, assistantMessageId: regenerateMessageId, model, provider })
                    .then(() => selectConversation(activeConversation.id)).catch((error) => showToast(error.message, 'error'));
                return;
            }
            const messageId = event.target?.dataset?.materializeMessage;
            if (!messageId) return;
            const message = activeConversation?.messages?.find((item) => item.id === messageId);
            if (!message) return;
            void materializeMessage({ conversation: activeConversation, message, textNodeType: event.target.dataset.textNodeType })
                .catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-list-collapse')?.addEventListener('click', () => setPaneExpanded('conversation-list-pane', 'conversation-list-collapse', false));
        element('conversation-list-toggle')?.addEventListener('click', () => setPaneExpanded('conversation-list-pane', 'conversation-list-toggle', true));
        element('conversation-context-collapse')?.addEventListener('click', () => setPaneExpanded('conversation-context-pane', 'conversation-context-toggle', false));
        element('conversation-context-toggle')?.addEventListener('click', () => setPaneExpanded('conversation-context-pane', 'conversation-context-toggle', true));
        element('conversation-model')?.addEventListener('change', async (event) => {
            if (!activeConversation) return;
            try {
                activeConversation = await api.updateConversation(activeConversation.id, {
                    revision: activeConversation.revision,
                    defaultModelId: event.target.value,
                    defaultProviderId: (state.models || []).find((item) => item.id === event.target.value)?.providerId
                        || (state.models || []).find((item) => item.id === event.target.value)?.providerIds?.[0] || ''
                });
                renderActiveConversation();
            } catch (error) {
                showToast(error.message, 'error');
            }
        });
        element('conversation-rename')?.addEventListener('click', () => {
            const title = promptRef?.('重命名对话', activeConversation?.title || '');
            if (title?.trim()) void updateLifecycle({ title: title.trim() }).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-lifecycle-action')?.addEventListener('click', () => {
            const status = ['archived', 'trashed'].includes(activeConversation?.status) ? 'active' : 'archived';
            void updateLifecycle({ status }).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-execution-record')?.addEventListener('click', showExecutionRecord);
        element('conversation-trash')?.addEventListener('click', () => {
            if (activeConversation?.status === 'trashed') {
                if (confirmRef?.('永久删除此对话及其消息？此操作不可恢复。')) void permanentlyDeleteCurrent().catch((error) => showToast(error.message, 'error'));
                return;
            }
            void updateLifecycle({ status: 'trashed' }).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-stage-selected-nodes')?.addEventListener('click', stageSelectedNodes);
        element('conversation-link-workflow')?.addEventListener('click', () => {
            const workflow = getActiveWorkflow();
            if (!workflow?.id && !activeConversation?.workflowId) { showToast('当前没有可关联的工作流', 'warning'); return; }
            const workflowId = activeConversation?.workflowId === workflow?.id ? '' : workflow?.id;
            void updateLifecycle({ workflowId }).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-stage-selected-history')?.addEventListener('click', () => void stageSelectedHistory().catch((error) => showToast(error.message, 'error')));
        element('conversation-attach-file')?.addEventListener('click', () => element('conversation-file-input')?.click());
        element('conversation-file-input')?.addEventListener('change', (event) => void stageLocalImages(event.target.files).catch((error) => showToast(error.message, 'error')));
        element('conversation-composer')?.addEventListener('paste', (event) => {
            const images = [...(event.clipboardData?.files || [])].filter((file) => String(file.type || '').startsWith('image/'));
            if (!images.length) return;
            event.preventDefault();
            void stageLocalImages(images).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-staged-context')?.addEventListener('click', (event) => {
            const moveId = event.target?.dataset?.moveStaged;
            if (moveId) {
                const items = stagedContext.list();
                const index = items.findIndex((item) => item.id === moveId);
                stagedContext.move(moveId, index + Number(event.target.dataset.moveDirection || 0));
                renderStagedContext();
                return;
            }
            const itemId = event.target?.dataset?.removeStaged;
            if (!itemId) return;
            const item = stagedContext.list().find((candidate) => candidate.id === itemId);
            stagedContext.remove(itemId);
            renderStagedContext();
            if (item?.stagingOwnerId) void removeMediaReference('conversation-staging', item.stagingOwnerId, item.assetKey);
        });
        element('conversation-send')?.addEventListener('click', () => {
            if (activeConversation && executionService?.getRunState(activeConversation.id)) {
                executionService.stop(activeConversation.id);
                return;
            }
            void sendCurrentMessage().catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-composer')?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            event.preventDefault();
            void sendCurrentMessage().catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-drawer-backdrop')?.addEventListener('click', () => {
            setPaneExpanded('conversation-list-pane', 'conversation-list-collapse', false);
            setPaneExpanded('conversation-context-pane', 'conversation-context-toggle', false);
        });
    }

    async function init() {
        bind();
        renderModels();
        renderStagedContext();
        await refresh();
        if (conversations[0]) {
            await selectConversation(conversations[0].id);
            const recovered = await executionService?.recoverInterrupted?.(activeConversation);
            if (recovered?.messages?.length) await selectConversation(activeConversation.id);
        }
        return getSnapshot();
    }

    function getSnapshot() {
        return { conversations: [...conversations], activeConversationId: activeConversation?.id || null };
    }

    return { init, refresh, selectConversation, createConversation, updateLifecycle, permanentlyDeleteCurrent, sendCurrentMessage, stageSelectedNodes, stageSelectedHistory, stageMedia, stageLocalImages, projectRunState, setPaneExpanded, togglePane, stopCurrentRun, showExecutionRecord, getSnapshot, getToolbarSnapshot };
}
