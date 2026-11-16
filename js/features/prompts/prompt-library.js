import { readPromptLibrary, updatePromptLibrary } from './prompt-library-store.js';

// Keep a page comfortably below the MCP bridge limit, including Unicode JSON escaping.
const PROMPT_PAGE_CHARACTERS = 100_000;
const TEXT_NODE_WIDTH = 260;
const TEXT_NODE_HEIGHT = 190;
const NODE_MARGIN = 36;
const GRID_SIZE = 20;

export function createPromptLibraryApi({
    state,
    canvasContainer,
    viewportApi,
    addNode,
    saveState,
    showToast,
    copyToClipboard,
    documentRef = document,
    localStorageRef = localStorage,
    confirmRef = confirm
}) {
    let prompts = [];
    let editingPrompt = null;
    let editorRevision = 0;
    let libraryRevision = 0;
    let selectionMode = false;
    let searchQuery = '';
    const selectedPromptIds = new Set();
    let importCandidates = [];
    const selectedImportIds = new Set();

    function getEls() {
        return {
            button: documentRef.getElementById('btn-prompt-library'),
            modal: documentRef.getElementById('prompt-library-modal'),
            body: documentRef.querySelector('.prompt-library-body'),
            closeButton: documentRef.getElementById('btn-close-prompt-library'),
            newButton: documentRef.getElementById('btn-new-prompt'),
            selectToggleButton: documentRef.getElementById('btn-toggle-prompt-select'),
            selectAllButton: documentRef.getElementById('btn-select-all-prompts'),
            deleteSelectedButton: documentRef.getElementById('btn-delete-selected-prompts'),
            cancelSelectButton: documentRef.getElementById('btn-cancel-prompt-select'),
            grid: documentRef.getElementById('prompt-library-grid'),
            count: documentRef.getElementById('prompt-library-count'),
            search: documentRef.getElementById('prompt-library-search'),
            clearSearch: documentRef.getElementById('btn-clear-prompt-search'),
            searchSummary: documentRef.getElementById('prompt-library-search-summary'),
            editor: documentRef.getElementById('prompt-editor'),
            editorTitle: documentRef.getElementById('prompt-editor-title'),
            nameInput: documentRef.getElementById('prompt-name-input'),
            contentInput: documentRef.getElementById('prompt-content-input'),
            saveButton: documentRef.getElementById('btn-save-prompt'),
            cancelButton: documentRef.getElementById('btn-cancel-prompt'),
            closeEditorButton: documentRef.getElementById('btn-cancel-prompt-edit'),
            importDialog: documentRef.getElementById('prompt-import-dialog'),
            importList: documentRef.getElementById('prompt-import-list'),
            importSummary: documentRef.getElementById('prompt-import-summary'),
            importSelectAllButton: documentRef.getElementById('btn-import-select-all'),
            confirmImportButton: documentRef.getElementById('btn-confirm-import-prompts'),
            cancelImportButton: documentRef.getElementById('btn-cancel-import-prompts'),
            closeImportButton: documentRef.getElementById('btn-close-prompt-import')
        };
    }

    function createId() {
        return `prompt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizePrompt(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const content = typeof raw.content === 'string' ? raw.content : '';
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name && !content.trim()) return null;
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy-prompt-${index}`,
            name: name || buildFallbackName(content),
            content,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
        };
    }

    async function loadPrompts() {
        const revision = ++libraryRevision;
        const loaded = await readPromptLibrary(localStorageRef);
        if (revision === libraryRevision) prompts = loaded.map(normalizePrompt).filter(Boolean);
    }

    async function commitPrompts(update, options) {
        const stored = await updatePromptLibrary(localStorageRef, current => update(current.map(normalizePrompt).filter(Boolean)), options);
        libraryRevision++;
        prompts = stored;
        const retainedIds = new Set(prompts.map(({ id }) => id));
        selectedPromptIds.forEach(id => { if (!retainedIds.has(id)) selectedPromptIds.delete(id); });
        renderPromptGrid();
    }

    async function listPrompts({ query = '', offset = 0, limit = 20 } = {}) {
        if (typeof query !== 'string' || query.length > 200
            || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
            throw new Error('请提供有效的搜索词、起始位置和 1 至 50 的返回数量');
        }
        const needle = query.trim().toLocaleLowerCase();
        const entries = (await readPromptLibrary(localStorageRef)).map(normalizePrompt).filter(prompt =>
            prompt && (!needle || `${prompt.name}\n${prompt.content}`.toLocaleLowerCase().includes(needle)));
        const page = [];
        let characters = 0;
        for (const prompt of entries.slice(offset, offset + limit)) {
            const exposed = {
                id: prompt.id.slice(0, 200), name: prompt.name.slice(0, 200),
                content: prompt.content.slice(0, 20_000),
                createdAt: prompt.createdAt.slice(0, 100), updatedAt: prompt.updatedAt.slice(0, 100),
                ...(prompt.content.length > 20_000 ? { contentOmitted: true } : {})
            };
            characters += JSON.stringify(exposed).length;
            if (characters > PROMPT_PAGE_CHARACTERS) break;
            page.push(exposed);
        }
        const end = offset + page.length;
        return { prompts: page, total: entries.length, nextOffset: end < entries.length ? end : null };
    }

    async function getPrompt({ promptId, name } = {}) {
        const query = promptId ?? name;
        if ((promptId === undefined) === (name === undefined)
            || typeof query !== 'string' || !query.trim() || query.length > 200) {
            throw new Error('请提供提示词库中的一个 ID 或准确名称');
        }
        const saved = await readPromptLibrary(localStorageRef);
        const matches = saved.map(normalizePrompt).filter((prompt, index) => prompt && (promptId !== undefined
            ? saved[index]?.id === promptId : prompt.name === name.trim()));
        if (!matches.length) throw new Error('提示词库中找不到该预设，请检查 ID 或名称');
        if (matches.length > 1) throw new Error('提示词库中有多条匹配项，请使用唯一的预设 ID');
        const [prompt] = matches;
        if (!prompt.content.trim() || prompt.content.length > 20_000) throw new Error('预设内容应为 1 至 20000 字');
        return prompt;
    }

    async function upsertPrompt({ name, content }, options = {}) {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 80
            || typeof content !== 'string' || !content.trim() || content.length > 20_000) {
            throw new Error('请提供 1 至 80 字的名称和 1 至 20000 字的提示词内容');
        }
        name = name.trim();
        const now = new Date().toISOString();
        const id = createId();
        let saved;
        await commitPrompts(current => {
            const matches = current.filter(prompt => prompt.name === name);
            if (matches.length > 1) throw new Error('提示词库中有多条同名预设，请使用唯一名称');
            const existing = matches[0];
            saved = { id, createdAt: now, ...existing, name, content, updatedAt: now };
            return existing ? current.map(prompt => prompt.id === existing.id ? saved : prompt) : [saved, ...current];
        }, options);
        return { ...saved };
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function buildFallbackName(content) {
        const firstLine = String(content || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        return firstLine ? firstLine.slice(0, 40) : '未命名提示词';
    }

    function toTransferPrompt(prompt) {
        return {
            id: prompt.id,
            name: prompt.name,
            content: prompt.content,
            createdAt: prompt.createdAt,
            updatedAt: prompt.updatedAt
        };
    }

    function normalizeImportedPrompt(raw, index) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error(`第 ${index + 1} 条预设不是有效对象`);
        }
        if (raw.name !== undefined && typeof raw.name !== 'string') {
            throw new Error(`第 ${index + 1} 条预设的 name 必须是字符串`);
        }
        if (typeof raw.content !== 'string') {
            throw new Error(`第 ${index + 1} 条预设的 content 必须是字符串`);
        }

        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        const content = raw.content;
        if (!name && !content.trim()) {
            throw new Error(`第 ${index + 1} 条预设缺少名称和内容`);
        }

        const now = new Date().toISOString();
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
            name: name || buildFallbackName(content),
            content,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
        };
    }

    function loadPromptsFromTransfer(rawPrompts) {
        if (!Array.isArray(rawPrompts)) throw new Error('配置文件缺少 prompts 数组');
        return rawPrompts.map((item, index) => normalizeImportedPrompt(item, index));
    }

    function getVisiblePrompts() {
        const query = searchQuery.trim().toLocaleLowerCase();
        return query ? prompts.filter((prompt) => `${prompt.name}\n${prompt.content}`.toLocaleLowerCase().includes(query)) : prompts;
    }

    function applySearch() {
        searchQuery = getEls().search?.value || '';
        selectedPromptIds.clear();
        renderPromptGrid();
    }

    function renderPromptGrid() {
        const { grid, count, searchSummary, clearSearch } = getEls();
        if (!grid) return;
        const visible = getVisiblePrompts();

        if (count) count.textContent = String(prompts.length);
        if (searchSummary) searchSummary.textContent = searchQuery.trim()
            ? `找到 ${visible.length} / 共 ${prompts.length} 条` : `共 ${prompts.length} 条`;
        if (clearSearch) clearSearch.disabled = !searchQuery;

        if (!prompts.length) {
            grid.innerHTML = '<div class="prompt-library-empty">暂无提示词预设</div>';
            updateSelectionControls();
            return;
        }

        if (!visible.length) {
            grid.innerHTML = '<div class="prompt-library-empty">没有匹配的提示词，请更换关键词或清空搜索</div>';
            updateSelectionControls();
            return;
        }

        grid.innerHTML = visible.map((prompt) => `
            <article class="prompt-card ${selectionMode ? 'selectable' : ''} ${selectedPromptIds.has(prompt.id) ? 'selected' : ''}" data-id="${escapeHtml(prompt.id)}">
                ${selectionMode ? `
                    <button class="prompt-card-select" type="button" title="选择提示词" data-action="select" aria-pressed="${selectedPromptIds.has(prompt.id) ? 'true' : 'false'}">
                        ${selectedPromptIds.has(prompt.id) ? '✓' : ''}
                    </button>
                ` : ''}
                <div class="prompt-card-main">
                    <h3>${escapeHtml(prompt.name)}</h3>
                    <p>${escapeHtml(prompt.content)}</p>
                </div>
                <div class="prompt-card-actions">
                    <button class="prompt-card-btn prompt-import-btn" type="button" data-action="import">导入画布</button>
                    <button class="prompt-card-btn" type="button" data-action="copy">复制</button>
                    <button class="prompt-card-btn" type="button" data-action="edit">编辑</button>
                    <button class="prompt-card-icon-btn" type="button" title="删除" data-action="delete">
                        <svg class="icon-sm">
                            <use href="#icon-trash" />
                        </svg>
                    </button>
                </div>
            </article>
        `).join('');
        updateSelectionControls();
    }

    async function openLibrary() {
        const { modal, button, search } = getEls();
        searchQuery = '';
        if (search) search.value = '';
        modal?.classList.remove('hidden');
        button?.classList.add('active');
        try {
            await loadPrompts();
            renderPromptGrid();
        } catch (error) {
            showToast(`读取提示词库失败：${error.message}`, 'error');
        }
    }

    function updateSelectionControls() {
        const { selectToggleButton, selectAllButton, deleteSelectedButton, cancelSelectButton, newButton } = getEls();
        const selectionButtons = [selectAllButton, deleteSelectedButton, cancelSelectButton].filter(Boolean);
        selectionButtons.forEach((button) => button.classList.toggle('hidden', !selectionMode));
        selectToggleButton?.classList.toggle('hidden', selectionMode);
        if (newButton) newButton.disabled = selectionMode;
        if (deleteSelectedButton) {
            deleteSelectedButton.disabled = selectedPromptIds.size === 0;
            deleteSelectedButton.textContent = selectedPromptIds.size > 0
                ? `删除选中 (${selectedPromptIds.size})`
                : '删除选中';
        }
        if (selectAllButton) {
            const visible = getVisiblePrompts();
            const hasPrompts = visible.length > 0;
            selectAllButton.disabled = !hasPrompts;
            const allSelected = hasPrompts && visible.every((prompt) => selectedPromptIds.has(prompt.id));
            selectAllButton.textContent = allSelected ? '取消全选' : (searchQuery.trim() ? '全选搜索结果' : '全选');
        }
    }

    function enterSelectionMode() {
        if (prompts.length === 0) {
            showToast('暂无可选择的提示词', 'info');
            return;
        }
        selectionMode = true;
        selectedPromptIds.clear();
        closeEditor();
        renderPromptGrid();
    }

    function exitSelectionMode() {
        selectionMode = false;
        selectedPromptIds.clear();
        renderPromptGrid();
        updateSelectionControls();
    }

    function togglePromptSelection(id) {
        if (selectedPromptIds.has(id)) selectedPromptIds.delete(id);
        else selectedPromptIds.add(id);
        renderPromptGrid();
    }

    function toggleSelectAllPrompts() {
        if (!selectionMode) return;
        const visible = getVisiblePrompts();
        if (visible.every((prompt) => selectedPromptIds.has(prompt.id))) {
            selectedPromptIds.clear();
        } else {
            visible.forEach((prompt) => selectedPromptIds.add(prompt.id));
        }
        renderPromptGrid();
    }

    async function deleteSelectedPrompts() {
        if (!selectionMode || selectedPromptIds.size === 0) {
            showToast('请先选择要删除的提示词', 'warning');
            return;
        }
        const count = selectedPromptIds.size;
        if (!confirmRef(`确定要删除选中的 ${count} 条提示词吗？此操作无法撤销。`)) return;
        const ids = new Set(selectedPromptIds);
        try {
            await commitPrompts(current => current.filter(item => !ids.has(item.id)));
            exitSelectionMode();
            showToast(`已删除 ${count} 条提示词`, 'info');
        } catch (error) {
            showToast(`删除提示词失败：${error.message}`, 'error');
        }
    }

    function renderImportDialog() {
        const { importList, importSummary, importSelectAllButton, confirmImportButton } = getEls();
        if (!importList) return;

        importList.innerHTML = importCandidates.map(({ importId, prompt }) => `
            <article class="prompt-import-item ${selectedImportIds.has(importId) ? 'selected' : ''}" data-id="${escapeHtml(importId)}">
                <button class="prompt-import-check" type="button" data-action="toggle-import" aria-pressed="${selectedImportIds.has(importId) ? 'true' : 'false'}">
                    ${selectedImportIds.has(importId) ? '✓' : ''}
                </button>
                <div class="prompt-import-preview">
                    <h4>${escapeHtml(prompt.name)}</h4>
                    <p>${escapeHtml(prompt.content)}</p>
                </div>
            </article>
        `).join('');

        const selectedCount = selectedImportIds.size;
        if (importSummary) importSummary.textContent = `已选择 ${selectedCount} / ${importCandidates.length} 条`;
        if (confirmImportButton) {
            confirmImportButton.disabled = selectedCount === 0;
            confirmImportButton.textContent = selectedCount > 0 ? `导入选中 (${selectedCount})` : '导入选中';
        }
        if (importSelectAllButton) {
            importSelectAllButton.textContent = selectedCount === importCandidates.length ? '取消全选' : '全选';
        }
    }

    function closeEditor() {
        const { body, editor, nameInput, contentInput } = getEls();
        editingPrompt = null;
        editorRevision++;
        body?.classList.remove('editor-open');
        editor?.classList.add('hidden');
        if (nameInput) nameInput.value = '';
        if (contentInput) contentInput.value = '';
    }

    function closeLibrary() {
        const { modal, button } = getEls();
        modal?.classList.add('hidden');
        button?.classList.remove('active');
        if (button && documentRef.activeElement === button) {
            button.blur();
        }
        closeEditor();
        selectionMode = false;
        selectedPromptIds.clear();
        updateSelectionControls();
    }

    function openEditor(prompt = null) {
        const { body, editor, editorTitle, nameInput, contentInput } = getEls();
        editingPrompt = prompt;
        editorRevision++;
        if (editorTitle) editorTitle.textContent = prompt ? '编辑提示词' : '新建提示词';
        if (nameInput) nameInput.value = prompt?.name || '';
        if (contentInput) contentInput.value = prompt?.content || '';
        body?.classList.add('editor-open');
        editor?.classList.remove('hidden');
        setTimeout(() => (nameInput || contentInput)?.focus(), 0);
    }

    async function savePrompt() {
        const { nameInput, contentInput, saveButton } = getEls();
        const rawName = nameInput?.value.trim() || '';
        const content = contentInput?.value || '';
        if (!rawName && !content.trim()) {
            showToast('请输入提示词名称或内容', 'warning');
            return;
        }

        const expected = editingPrompt;
        const revision = editorRevision;
        const now = new Date().toISOString();
        const nextPrompt = {
            id: expected?.id || createId(),
            name: rawName || buildFallbackName(content),
            content,
            createdAt: expected?.createdAt || now,
            updatedAt: now
        };

        if (saveButton) saveButton.disabled = true;
        try {
            await commitPrompts(current => {
                if (!expected) return [nextPrompt, ...current.filter(prompt => prompt.id !== nextPrompt.id)];
                const latest = current.find(prompt => prompt.id === expected.id);
                if (latest?.updatedAt === nextPrompt.updatedAt && latest.name === nextPrompt.name && latest.content === nextPrompt.content) return current;
                if (!latest || latest.name !== expected.name || latest.content !== expected.content || latest.updatedAt !== expected.updatedAt) {
                    throw new Error('此提示词已更新或删除，请重新打开后编辑');
                }
                return current.map(prompt => prompt.id === expected.id ? nextPrompt : prompt);
            });
            if (revision === editorRevision) closeEditor();
            showToast(expected ? '提示词已更新' : '提示词已保存', 'success');
        } catch (error) {
            showToast(`保存提示词失败：${error.message}`, 'error');
        } finally {
            if (saveButton) saveButton.disabled = false;
        }
    }

    function getPromptById(id) {
        return prompts.find((prompt) => prompt.id === id) || null;
    }

    function snap(value) {
        return Math.round(value / GRID_SIZE) * GRID_SIZE;
    }

    function getNodeBounds(node) {
        const width = Number(node?.width) > 0 ? Number(node.width) : (node?.el?.offsetWidth || TEXT_NODE_WIDTH);
        const height = Number(node?.height) > 0 ? Number(node.height) : (node?.el?.offsetHeight || TEXT_NODE_HEIGHT);
        return { x: node.x, y: node.y, width, height };
    }

    function intersects(candidate, nodeBounds) {
        return candidate.x < nodeBounds.x + nodeBounds.width + NODE_MARGIN
            && candidate.x + candidate.width + NODE_MARGIN > nodeBounds.x
            && candidate.y < nodeBounds.y + nodeBounds.height + NODE_MARGIN
            && candidate.y + candidate.height + NODE_MARGIN > nodeBounds.y;
    }

    function isPositionFree(x, y) {
        const candidate = { x, y, width: TEXT_NODE_WIDTH, height: TEXT_NODE_HEIGHT };
        return Array.from(state.nodes.values()).every((node) => !intersects(candidate, getNodeBounds(node)));
    }

    function getCanvasCenterPosition() {
        const rect = canvasContainer.getBoundingClientRect();
        const center = viewportApi.screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
            x: snap(center.x - TEXT_NODE_WIDTH / 2),
            y: snap(center.y - TEXT_NODE_HEIGHT / 2)
        };
    }

    function findEmptyCanvasPosition() {
        const origin = getCanvasCenterPosition();
        const stepX = TEXT_NODE_WIDTH + NODE_MARGIN * 2;
        const stepY = TEXT_NODE_HEIGHT + NODE_MARGIN * 2;

        for (let ring = 0; ring <= 18; ring += 1) {
            for (let dy = -ring; dy <= ring; dy += 1) {
                for (let dx = -ring; dx <= ring; dx += 1) {
                    if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const x = snap(origin.x + dx * stepX);
                    const y = snap(origin.y + dy * stepY);
                    if (isPositionFree(x, y)) return { x, y };
                }
            }
        }

        const bounds = Array.from(state.nodes.values()).map(getNodeBounds);
        const maxRight = bounds.reduce((max, node) => Math.max(max, node.x + node.width), origin.x);
        const minY = bounds.reduce((min, node) => Math.min(min, node.y), origin.y);
        let fallbackY = snap(minY);
        let fallbackX = snap(maxRight + NODE_MARGIN * 2);
        while (!isPositionFree(fallbackX, fallbackY)) {
            fallbackY = snap(fallbackY + stepY);
        }
        return { x: fallbackX, y: fallbackY };
    }

    function importPromptToCanvas(prompt) {
        const position = findEmptyCanvasPosition();
        const nodeId = addNode('Text', position.x, position.y, {
            text: prompt.content,
            width: TEXT_NODE_WIDTH,
            height: TEXT_NODE_HEIGHT
        });
        const node = state.nodes.get(nodeId);
        const textarea = node?.el?.querySelector(`#${nodeId}-text`);
        if (node) node.data.text = prompt.content;
        if (textarea) textarea.value = prompt.content;
        saveState();
        closeLibrary();
        showToast(`已导入「${prompt.name}」到画布`, 'success');
    }

    async function handleGridClick(event) {
        const actionButton = event.target.closest('[data-action]');
        const card = event.target.closest('.prompt-card');
        if (!card) return;

        const prompt = getPromptById(card.dataset.id);
        if (!prompt) return;

        const action = actionButton?.dataset.action || '';
        if (selectionMode && (!action || action === 'select')) {
            togglePromptSelection(prompt.id);
            return;
        }

        if (!actionButton) return;

        if (action === 'import') {
            importPromptToCanvas(prompt);
        } else if (action === 'copy') {
            copyToClipboard(prompt.content);
        } else if (action === 'edit') {
            openEditor(prompt);
        } else if (action === 'delete') {
            if (!confirmRef(`确定要删除「${prompt.name}」吗？`)) return;
            try {
                await commitPrompts(current => current.filter(item => item.id !== prompt.id));
                if (editingPrompt?.id === prompt.id) closeEditor();
                showToast('提示词已删除', 'info');
            } catch (error) {
                showToast(`删除提示词失败：${error.message}`, 'error');
            }
        }
    }

    function initPromptLibrary() {
        const {
            button,
            modal,
            closeButton,
            newButton,
            selectToggleButton,
            selectAllButton,
            deleteSelectedButton,
            cancelSelectButton,
            grid,
            saveButton,
            cancelButton,
            closeEditorButton,
            search,
            clearSearch
        } = getEls();
        if (!button || !modal) return;

        button.addEventListener('click', openLibrary);
        search?.addEventListener('input', applySearch);
        clearSearch?.addEventListener('click', () => {
            if (search) search.value = '';
            applySearch();
            search?.focus();
        });
        search?.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                if (search.value) { search.value = ''; applySearch(); }
                else closeLibrary();
            }
        });
        closeButton?.addEventListener('click', closeLibrary);
        newButton?.addEventListener('click', () => openEditor());
        selectToggleButton?.addEventListener('click', enterSelectionMode);
        selectAllButton?.addEventListener('click', toggleSelectAllPrompts);
        deleteSelectedButton?.addEventListener('click', deleteSelectedPrompts);
        cancelSelectButton?.addEventListener('click', exitSelectionMode);
        saveButton?.addEventListener('click', savePrompt);
        cancelButton?.addEventListener('click', closeEditor);
        closeEditorButton?.addEventListener('click', closeEditor);
        grid?.addEventListener('click', handleGridClick);

        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeLibrary();
        });

        documentRef.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
                closeLibrary();
            }
        });
    }

    return {
        initPromptLibrary,
        openLibrary,
        closeLibrary,
        listPrompts,
        getPrompt,
        upsertPrompt
    };
}
