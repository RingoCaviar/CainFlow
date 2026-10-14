function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

import * as defaultConversationApi from '../../services/conversation-api.js';
import { createStagedConversationContext } from './conversation-context.js';

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
    const failure = message?.role === 'assistant' && message?.status === 'failed'
        ? `<div class="conversation-message-error">${escapeHtml(message.execution?.attempts?.at(-1)?.error?.summary || '请求失败，请重试或换模型后重试')}</div>`
        : '';
    const attachments = (message?.parts || []).map((part, partIndex) => ({ part, partIndex }))
        .filter(({ part }) => part?.type !== 'text').map(({ part, partIndex }) => {
        const label = part.type === 'node-source' ? `${part.nodeType || '节点'} · ${part.nodeId || ''}` : `${part.mediaType || '媒体'} · ${part.assetKey || ''}`;
        if (part.missing) {
            const keys = part.missingAssetKeys?.length ? part.missingAssetKeys : [part.assetKey].filter(Boolean);
            return keys.map((key) => `<div class="conversation-missing-media">${escapeHtml(label)}<span>资源缺失</span><button class="btn btn-ghost" type="button" data-message-id="${escapeHtml(message.id)}" data-part-index="${partIndex}" data-recover-asset="${escapeHtml(key)}">恢复</button><button class="btn btn-ghost" type="button" data-message-id="${escapeHtml(message.id)}" data-part-index="${partIndex}" data-remove-missing="${escapeHtml(key)}">移除</button></div>`).join('');
        }
        return `<div class="conversation-message-attachment">${escapeHtml(label)}</div>`;
    }).join('');
    return text + failure + attachments;
}

function statusLabel(status) {
    return ({ pending: '等待中', starting: '准备中', running: '生成中', streaming: '生成中', completed: '已完成', partial: '部分回复', failed: '失败', cancelled: '已停止' })[status] || '就绪';
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
    imageGenerationService = null,
    openSettings = () => {},
    getHistoryEntry = async () => null,
    getHistoryMetadata = async () => [],
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
    let interactionMode = 'chat';
    let historyMediaEntries = [];
    const selectedModelIdByMode = { chat: '', image: '' };
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

    function modelTaskType(model) {
        return model?.taskType === 'image' ? 'image' : (model?.taskType === 'chat' ? 'chat' : 'unsupported');
    }

    function getAvailableModels() {
        return (state.models || []).filter((model) => modelTaskType(model) === interactionMode);
    }

    function getSelectedModel() {
        const selectedId = selectedModelIdByMode[interactionMode]
            || (interactionMode === 'chat' ? activeConversation?.defaultModelId : '');
        return getAvailableModels().find((model) => model.id === selectedId) || null;
    }

    function getReadiness() {
        const model = getSelectedModel();
        const providerId = model?.providerId || model?.providerIds?.[0] || (interactionMode === 'chat' ? activeConversation?.defaultProviderId : '');
        const provider = (state.providers || []).find((item) => item.id === providerId) || null;
        if (getAvailableModels().length === 0) return { ready: false, reason: `还没有可用的${interactionMode === 'image' ? '生图' : '对话'}模型`, model: null, provider: null };
        if (!model) return { ready: false, reason: `请选择一个${interactionMode === 'image' ? '生图' : '对话'}模型`, model: null, provider: null };
        if (!provider) return { ready: false, reason: '所选模型没有可用的 Provider 配置', model, provider: null };
        return { ready: true, reason: '', model, provider };
    }

    function renderModels() {
        const select = element('conversation-model');
        if (!select) return;
        const selected = getSelectedModel()?.id || '';
        select.innerHTML = `<option value="">选择${interactionMode === 'image' ? '生图' : '对话'}模型</option>` + getAvailableModels().map((model) => (
            `<option value="${escapeHtml(model.id)}"${model.id === selected ? ' selected' : ''}>${escapeHtml(model.name || model.modelId || model.id)}</option>`
        )).join('');
    }

    function renderGuidance() {
        const guidance = element('conversation-guidance');
        const modeChat = element('conversation-mode-chat');
        const modeImage = element('conversation-mode-image');
        const sendButton = element('conversation-send');
        const composer = element('conversation-composer');
        const readiness = getReadiness();
        modeChat?.classList.toggle('is-selected', interactionMode === 'chat');
        modeImage?.classList.toggle('is-selected', interactionMode === 'image');
        modeChat?.setAttribute('aria-pressed', String(interactionMode === 'chat'));
        modeImage?.setAttribute('aria-pressed', String(interactionMode === 'image'));
        if (sendButton) sendButton.textContent = interactionMode === 'image' ? '生成图片' : '发送';
        if (composer) composer.placeholder = interactionMode === 'image'
            ? '描述你想生成的图片，例如：雨夜霓虹街道，电影感，16:9'
            : '输入消息，Enter 发送，Shift+Enter 换行';
        if (guidance) {
            guidance.hidden = readiness.ready;
            guidance.innerHTML = readiness.ready ? '' : `<strong>还差一步：${escapeHtml(readiness.reason)}</strong><span>前往设置添加${interactionMode === 'image' ? '生图' : '对话'}模型与 Provider 后，回到这里选择它即可开始。</span><button id="conversation-open-settings" class="btn btn-primary" type="button">去设置</button>`;
            element('conversation-open-settings')?.addEventListener('click', openSettings);
        }
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
                ${message.role === 'assistant' && ['completed', 'partial', 'failed'].includes(message.status) ? `<footer class="conversation-message-actions">${group.length > 1 ? `<button class="btn btn-ghost" type="button" data-version-parent="${escapeHtml(message.parentMessageId)}" data-version-index="${Math.max(0, versionIndex - 1)}">上一版</button><button class="btn btn-ghost" type="button" data-version-parent="${escapeHtml(message.parentMessageId)}" data-version-index="${Math.min(group.length - 1, versionIndex + 1)}">下一版</button>` : ''}<button class="btn btn-ghost" type="button" data-regenerate-message="${escapeHtml(message.id)}">重新生成</button></footer>` : ''}
            </article>`);
        }).join('') : '<div class="conversation-empty-state"><strong>从一个明确的问题开始</strong><span>普通对话默认不会读取或修改画布；需要时可手动附加节点、历史资源或本地媒体。</span></div>';
    }

    function renderStagedContext() {
        const container = element('conversation-staged-context');
        const summary = element('conversation-send-summary');
        const items = stagedContext.list();
        if (container) container.innerHTML = items.map((item) => (
            `<span class="conversation-context-chip" data-staged-id="${escapeHtml(item.id)}">${escapeHtml(item.label || item.snapshot?.nodeType || item.mediaType || '资源')}<button type="button" aria-label="前移" data-move-staged="${escapeHtml(item.id)}" data-move-direction="-1">←</button><button type="button" aria-label="后移" data-move-staged="${escapeHtml(item.id)}" data-move-direction="1">→</button><button type="button" aria-label="移除 ${escapeHtml(item.label || '资源')}" data-remove-staged="${escapeHtml(item.id)}">×</button></span>`
        )).join('');
        if (summary) summary.textContent = items.length
            ? `将发送当前对话与 ${items.filter((item) => item.type === 'media').length} 张附件图片`
            : '仅发送当前对话';
        publishToolbarState();
    }

    function renderHistoryMediaOptions() {
        const select = element('conversation-history-media');
        if (!select) return;
        const currentValue = select.value;
        const imageEntries = historyMediaEntries.filter((entry) => (
            entry?.mediaType !== 'video' && (entry?.imageAssetKey || entry?.mediaAssetKey)
        ));
        select.innerHTML = '<option value="">选择共享图片</option>' + imageEntries.map((entry) => {
            const label = entry.prompt || entry.title || `历史图片 #${entry.id}`;
            return `<option value="${escapeHtml(String(entry.id))}">${escapeHtml(label)}</option>`;
        }).join('');
        if (currentValue && imageEntries.some((entry) => String(entry.id) === currentValue)) select.value = currentValue;
    }

    async function refreshHistoryMedia() {
        try {
            historyMediaEntries = await getHistoryMetadata({ limit: 100, includeThumbs: false });
        } catch {
            historyMediaEntries = [];
        }
        renderHistoryMediaOptions();
        return historyMediaEntries;
    }


    function stageMedia(item) {
        if (item?.type !== 'media' || !(item.assetKey || item.mediaAssetKey)) {
            showToast('独立对话只允许附加图片 Media asset', 'warning');
            return stagedContext.list();
        }
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
        renderGuidance();
        renderMessages();
        renderList();
        renderStagedContext();
    }

    async function refresh() {
        conversations = await api.listConversations({
            status: listStatus,
            workflowId: '',
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
        const model = (state.models || []).find((candidate) => modelTaskType(candidate) === 'chat');
        const created = await api.createConversation({
            title: '新对话',
            workflowId: '',
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
            if (sendButton) sendButton.textContent = ['starting', 'running', 'streaming'].includes(runState.status)
                ? '停止' : (interactionMode === 'image' ? '生成图片' : '发送');
        }
        renderList();
        publishToolbarState();
    }

    function projectPersistedMessage(conversationId, message, { conversationRevision } = {}) {
        if (activeConversation?.id !== conversationId || !message?.id) return;
        const messages = activeConversation.messages || [];
        const index = messages.findIndex((item) => item.id === message.id);
        activeConversation.messages = index === -1
            ? [...messages, message]
            : messages.map((item, itemIndex) => itemIndex === index ? { ...item, ...message } : item);
        if (conversationRevision !== undefined) activeConversation.revision = conversationRevision;
        renderMessages();
        renderStagedContext();
    }

    async function changeChatModel(modelId) {
        if (!activeConversation) return null;
        selectedModelIdByMode.chat = modelId;
        const model = (state.models || []).find((item) => item.id === modelId);
        const updated = await api.updateConversation(activeConversation.id, {
            revision: activeConversation.revision,
            defaultModelId: modelId,
            defaultProviderId: model?.providerId || model?.providerIds?.[0] || ''
        });
        activeConversation = {
            ...activeConversation,
            ...updated,
            messages: updated.messages || activeConversation.messages || []
        };
        renderActiveConversation();
        showToast(`已切换到 ${model?.name || model?.modelId || modelId}，仅影响下一条消息`, 'info');
        return activeConversation;
    }

    async function sendCurrentMessage() {
        const composer = element('conversation-composer');
        const text = composer?.value?.trim() || '';
        if (!text) {
            showToast(interactionMode === 'image' ? '请先描述想生成的图片' : '请输入消息后再发送', 'warning');
            composer?.focus?.();
            return null;
        }
        if (!activeConversation) await createConversation();
        if (!activeConversation || !executionService) throw new Error('对话工作台尚未准备完成，请稍后重试');
        const sendingConversation = {
            ...activeConversation,
            messages: selectConversationBranch(activeConversation.messages, visibleVersionByParent)
        };
        const readiness = getReadiness();
        if (!readiness.ready) {
            renderGuidance();
            showToast(readiness.reason, 'warning');
            return null;
        }
        const { model, provider } = readiness;
        if (interactionMode === 'image') {
            if (composer) composer.value = '';
            const imageResult = await imageGenerationService?.generate({
                conversationId: sendingConversation.id, prompt: text, model, provider
            });
            if (!imageResult) throw new Error('生图服务当前不可用');
            showToast('图片已生成到当前画布；可切回画布查看或继续描述下一张。', 'success');
            return imageResult;
        }
        if (composer) composer.value = '';
        try {
            await executionService.send({
                conversation: sendingConversation, text, model, provider,
                contextParts: stagedContext.toMessageParts(),
                workflowSummary: null
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
        if (kind !== 'list') return;
        const paneId = 'conversation-list-pane';
        const triggerId = 'conversation-list-toggle';
        const pane = element(paneId);
        setPaneExpanded(paneId, triggerId, pane?.classList?.contains?.('is-collapsed'));
    }

    function stopCurrentRun() {
        if (!activeConversation) return false;
        if (!executionService?.stop(activeConversation.id) && !imageGenerationService?.stop(activeConversation.id)) return false;
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
        element('conversation-mode-chat')?.addEventListener('click', () => {
            interactionMode = 'chat';
            renderModels();
            renderGuidance();
        });
        element('conversation-mode-image')?.addEventListener('click', () => {
            interactionMode = 'image';
            renderModels();
            renderGuidance();
        });
        element('conversation-new')?.addEventListener('click', () => void createConversation().catch((error) => showToast(error.message, 'error')));
        element('conversation-search')?.addEventListener('input', () => void refresh().catch((error) => showToast(error.message, 'error')));
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
        element('conversation-model')?.addEventListener('change', async (event) => {
            if (!activeConversation) return;
            selectedModelIdByMode[interactionMode] = event.target.value;
            if (interactionMode === 'image') {
                renderGuidance();
                return;
            }
            try {
                await changeChatModel(event.target.value);
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
        element('conversation-trash')?.addEventListener('click', () => {
            if (activeConversation?.status === 'trashed') {
                if (confirmRef?.('永久删除此对话及其消息？此操作不可恢复。')) void permanentlyDeleteCurrent().catch((error) => showToast(error.message, 'error'));
                return;
            }
            void updateLifecycle({ status: 'trashed' }).catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-attach-file')?.addEventListener('click', () => element('conversation-file-input')?.click());
        element('conversation-file-input')?.addEventListener('change', (event) => void stageLocalImages(event.target.files).catch((error) => showToast(error.message, 'error')));
        element('conversation-history-media')?.addEventListener('change', async (event) => {
            const historyId = event.target.value;
            event.target.value = '';
            if (!historyId) return;
            const metadata = historyMediaEntries.find((entry) => String(entry.id) === String(historyId));
            const entry = await getHistoryEntry(historyId);
            const assetKey = entry?.imageAssetKey || entry?.mediaAssetKey || metadata?.imageAssetKey || metadata?.mediaAssetKey;
            if (!assetKey || entry?.mediaType === 'video' || metadata?.mediaType === 'video') {
                showToast('共享图片资源不可用，请先恢复该 Media asset', 'warning');
                return;
            }
            stageMedia({
                id: `history:${historyId}`,
                type: 'media',
                label: metadata?.prompt || metadata?.title || `历史图片 #${historyId}`,
                assetKey,
                mediaType: 'image',
                historyId: String(historyId)
            });
        });
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
            if (activeConversation && (executionService?.getRunState(activeConversation.id) || imageGenerationService?.getRunState(activeConversation.id))) {
                stopCurrentRun();
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
        });
    }

    async function init() {
        bind();
        renderModels();
        renderStagedContext();
        await refreshHistoryMedia();
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

    return { init, refresh, selectConversation, createConversation, updateLifecycle, permanentlyDeleteCurrent, changeChatModel, sendCurrentMessage, stageMedia, stageLocalImages, projectRunState, projectPersistedMessage, setPaneExpanded, togglePane, stopCurrentRun, getSnapshot, getToolbarSnapshot };
}
