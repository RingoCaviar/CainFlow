function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

import * as defaultConversationApi from '../../services/conversation-api.js';

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

function statusLabel(status) {
    return ({ pending: '等待中', streaming: '生成中', completed: '已完成', partial: '部分回复', failed: '失败', cancelled: '已停止' })[status] || '就绪';
}

export function createConversationWorkbenchController({
    documentRef = document,
    api = defaultConversationApi,
    state = {},
    showToast = () => {},
    getActiveWorkflow = () => null
} = {}) {
    let conversations = [];
    let activeConversation = null;
    let listStatus = 'active';

    const element = (id) => documentRef.getElementById(id);

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
        const messages = activeConversation?.messages || [];
        container.innerHTML = messages.length ? messages.map((message) => (
            `<article class="conversation-message is-${escapeHtml(message.role)}" data-message-status="${escapeHtml(message.status)}">
                <header><strong>${message.role === 'assistant' ? '助手' : '你'}</strong><span>${statusLabel(message.status)}</span></header>
                <div class="conversation-message-content">${renderConversationMarkdown(messageText(message))}</div>
            </article>`
        )).join('') : '<div class="conversation-empty-state"><strong>从一个明确的问题开始</strong><span>可以附加工作流节点、历史资源或本地媒体。</span></div>';
    }

    function renderActiveConversation() {
        const title = element('conversation-title');
        if (title) title.textContent = activeConversation?.title || '新对话';
        const status = element('conversation-status');
        if (status) status.textContent = activeConversation?.runStatus === 'running' ? '生成中' : '就绪';
        renderModels();
        renderMessages();
        renderList();
        const workflow = getActiveWorkflow();
        const linkedToVisibleWorkflow = Boolean(activeConversation?.workflowId && activeConversation.workflowId === workflow?.id);
        const workflowSummary = element('conversation-workflow-summary');
        if (workflowSummary) workflowSummary.textContent = activeConversation?.workflowId
            ? `${linkedToVisibleWorkflow ? workflow.label || '当前工作流' : '已关联工作流'} · ${state.nodes?.size || 0} 个节点`
            : '未关联工作流';
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

    function bind() {
        element('conversation-new')?.addEventListener('click', () => void createConversation().catch((error) => showToast(error.message, 'error')));
        element('conversation-search')?.addEventListener('input', () => void refresh().catch((error) => showToast(error.message, 'error')));
        element('conversation-workflow-filter')?.addEventListener('change', () => void refresh().catch((error) => showToast(error.message, 'error')));
        element('conversation-archive-entry')?.addEventListener('click', (event) => {
            listStatus = listStatus === 'archived' ? 'active' : 'archived';
            if (event.currentTarget) event.currentTarget.textContent = listStatus === 'archived' ? '返回' : '归档';
            void refresh().catch((error) => showToast(error.message, 'error'));
        });
        element('conversation-list')?.addEventListener('click', (event) => {
            const target = event.target?.closest?.('[data-conversation-id]');
            if (target?.dataset.conversationId) void selectConversation(target.dataset.conversationId).catch((error) => showToast(error.message, 'error'));
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
                    defaultModelId: event.target.value
                });
                renderActiveConversation();
            } catch (error) {
                showToast(error.message, 'error');
            }
        });
        element('conversation-drawer-backdrop')?.addEventListener('click', () => {
            setPaneExpanded('conversation-list-pane', 'conversation-list-collapse', false);
            setPaneExpanded('conversation-context-pane', 'conversation-context-toggle', false);
        });
    }

    async function init() {
        bind();
        renderModels();
        await refresh();
        if (conversations[0]) await selectConversation(conversations[0].id);
        return getSnapshot();
    }

    function getSnapshot() {
        return { conversations: [...conversations], activeConversationId: activeConversation?.id || null };
    }

    return { init, refresh, selectConversation, createConversation, setPaneExpanded, getSnapshot };
}
