/**
 * 管理提示词预设的本地存储、全屏编辑界面，以及导入画布时的空位查找。
 */
const PROMPT_LIBRARY_STORAGE_KEY = 'cainflow_prompt_library';
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
    let editingId = null;
    let selectionMode = false;
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
            importButton: documentRef.getElementById('btn-import-prompts'),
            exportButton: documentRef.getElementById('btn-export-prompts'),
            importInput: documentRef.getElementById('input-import-prompts'),
            selectToggleButton: documentRef.getElementById('btn-toggle-prompt-select'),
            selectAllButton: documentRef.getElementById('btn-select-all-prompts'),
            deleteSelectedButton: documentRef.getElementById('btn-delete-selected-prompts'),
            cancelSelectButton: documentRef.getElementById('btn-cancel-prompt-select'),
            grid: documentRef.getElementById('prompt-library-grid'),
            count: documentRef.getElementById('prompt-library-count'),
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

    function normalizePrompt(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const content = typeof raw.content === 'string' ? raw.content : '';
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name && !content.trim()) return null;
        return {
            id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
            name: name || buildFallbackName(content),
            content,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
        };
    }

    function loadPrompts() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(PROMPT_LIBRARY_STORAGE_KEY) || '[]');
            prompts = Array.isArray(parsed) ? parsed.map(normalizePrompt).filter(Boolean) : [];
        } catch (error) {
            prompts = [];
            console.warn('Load prompt library failed:', error);
        }
    }

    function persistPrompts() {
        localStorageRef.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(prompts));
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

    function downloadJsonFile(payload, filename) {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = documentRef.createElement('a');
        link.href = url;
        link.download = filename;
        documentRef.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function getExportTargetPrompts() {
        if (selectedPromptIds.size === 0) return prompts;
        return prompts.filter((prompt) => selectedPromptIds.has(prompt.id));
    }

    function exportPrompts() {
        if (prompts.length === 0) {
            showToast('暂无提示词可导出', 'info');
            return;
        }

        const targetPrompts = getExportTargetPrompts();
        if (targetPrompts.length === 0) {
            showToast('未找到选中的提示词，将导出全部预设', 'info');
        }

        const promptsToExport = targetPrompts.length > 0 ? targetPrompts : prompts;
        const payload = {
            type: 'cainflow-prompt-library',
            version: 1,
            exportedAt: new Date().toISOString(),
            prompts: promptsToExport.map(toTransferPrompt)
        };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const scope = selectedPromptIds.size > 0 && targetPrompts.length > 0 ? 'selected' : 'all';
        downloadJsonFile(payload, `cainflow_prompts_${scope}_${stamp}.json`);
        showToast(`已导出 ${promptsToExport.length} 条提示词预设`, 'success');
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
            importId: `import_${index}_${createId()}`,
            prompt: {
                id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
                name: name || buildFallbackName(content),
                content,
                createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
                updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
            }
        };
    }

    function parseImportPayload(text) {
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            throw new Error('文件不是有效的 JSON');
        }

        if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.type && payload.type !== 'cainflow-prompt-library') {
            throw new Error('文件类型不是 CainFlow 提示词库');
        }

        const rawPrompts = Array.isArray(payload)
            ? payload
            : (payload && typeof payload === 'object' && Array.isArray(payload.prompts) ? payload.prompts : null);

        if (!rawPrompts) {
            throw new Error('文件缺少 prompts 数组');
        }
        if (rawPrompts.length === 0) {
            throw new Error('文件中没有可导入的提示词预设');
        }

        return rawPrompts.map((item, index) => normalizeImportedPrompt(item, index));
    }

    function renderPromptGrid() {
        const { grid, count } = getEls();
        if (!grid) return;

        if (count) count.textContent = String(prompts.length);

        if (!prompts.length) {
            grid.innerHTML = '<div class="prompt-library-empty">暂无提示词预设</div>';
            updateSelectionControls();
            return;
        }

        grid.innerHTML = prompts.map((prompt) => `
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

    function openLibrary() {
        const { modal, button } = getEls();
        loadPrompts();
        renderPromptGrid();
        modal?.classList.remove('hidden');
        button?.classList.add('active');
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
            const hasPrompts = prompts.length > 0;
            selectAllButton.disabled = !hasPrompts;
            selectAllButton.textContent = selectedPromptIds.size === prompts.length && hasPrompts ? '取消全选' : '全选';
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
        if (selectedPromptIds.size === prompts.length) {
            selectedPromptIds.clear();
        } else {
            prompts.forEach((prompt) => selectedPromptIds.add(prompt.id));
        }
        renderPromptGrid();
    }

    function deleteSelectedPrompts() {
        if (!selectionMode || selectedPromptIds.size === 0) {
            showToast('请先选择要删除的提示词', 'warning');
            return;
        }
        const count = selectedPromptIds.size;
        if (!confirmRef(`确定要删除选中的 ${count} 条提示词吗？此操作无法撤销。`)) return;
        prompts = prompts.filter((item) => !selectedPromptIds.has(item.id));
        persistPrompts();
        exitSelectionMode();
        showToast(`已删除 ${count} 条提示词`, 'info');
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

    function openImportDialog(candidates) {
        const { importDialog } = getEls();
        importCandidates = candidates;
        selectedImportIds.clear();
        candidates.forEach((item) => selectedImportIds.add(item.importId));
        closeEditor();
        selectionMode = false;
        selectedPromptIds.clear();
        renderPromptGrid();
        importDialog?.classList.remove('hidden');
        renderImportDialog();
    }

    function closeImportDialog() {
        const { importDialog } = getEls();
        importDialog?.classList.add('hidden');
        importCandidates = [];
        selectedImportIds.clear();
    }

    function handleImportFile(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            try {
                const candidates = parseImportPayload(String(reader.result || ''));
                openImportDialog(candidates);
            } catch (error) {
                showToast(`导入失败：${error.message}`, 'error', 5000);
            }
        };
        reader.onerror = () => {
            showToast('读取导入文件失败', 'error');
        };
        reader.readAsText(file, 'utf-8');
    }

    function toggleImportSelection(importId) {
        if (selectedImportIds.has(importId)) selectedImportIds.delete(importId);
        else selectedImportIds.add(importId);
        renderImportDialog();
    }

    function toggleSelectAllImportCandidates() {
        if (selectedImportIds.size === importCandidates.length) {
            selectedImportIds.clear();
        } else {
            importCandidates.forEach((item) => selectedImportIds.add(item.importId));
        }
        renderImportDialog();
    }

    function confirmImportPrompts() {
        if (selectedImportIds.size === 0) {
            showToast('请先选择要导入的预设', 'warning');
            return;
        }

        const now = new Date().toISOString();
        const selectedPrompts = importCandidates
            .filter((item) => selectedImportIds.has(item.importId))
            .map(({ prompt }) => ({
                ...prompt,
                id: createId(),
                createdAt: prompt.createdAt || now,
                updatedAt: now
            }));

        prompts = [...selectedPrompts, ...prompts];
        persistPrompts();
        renderPromptGrid();
        closeImportDialog();
        showToast(`已导入 ${selectedPrompts.length} 条提示词预设`, 'success');
    }

    function closeEditor() {
        const { body, editor, nameInput, contentInput } = getEls();
        editingId = null;
        body?.classList.remove('editor-open');
        editor?.classList.add('hidden');
        if (nameInput) nameInput.value = '';
        if (contentInput) contentInput.value = '';
    }

    function closeLibrary() {
        const { modal, button } = getEls();
        modal?.classList.add('hidden');
        button?.classList.remove('active');
        closeEditor();
        closeImportDialog();
        selectionMode = false;
        selectedPromptIds.clear();
        updateSelectionControls();
    }

    function openEditor(prompt = null) {
        const { body, editor, editorTitle, nameInput, contentInput } = getEls();
        editingId = prompt?.id || null;
        if (editorTitle) editorTitle.textContent = editingId ? '编辑提示词' : '新建提示词';
        if (nameInput) nameInput.value = prompt?.name || '';
        if (contentInput) contentInput.value = prompt?.content || '';
        body?.classList.add('editor-open');
        editor?.classList.remove('hidden');
        setTimeout(() => (nameInput || contentInput)?.focus(), 0);
    }

    function savePrompt() {
        const { nameInput, contentInput } = getEls();
        const rawName = nameInput?.value.trim() || '';
        const content = contentInput?.value || '';
        if (!rawName && !content.trim()) {
            showToast('请输入提示词名称或内容', 'warning');
            return;
        }

        const now = new Date().toISOString();
        const nextPrompt = {
            id: editingId || createId(),
            name: rawName || buildFallbackName(content),
            content,
            createdAt: prompts.find((item) => item.id === editingId)?.createdAt || now,
            updatedAt: now
        };

        if (editingId) {
            prompts = prompts.map((item) => item.id === editingId ? nextPrompt : item);
        } else {
            prompts = [nextPrompt, ...prompts];
        }

        const wasEditing = Boolean(editingId);
        persistPrompts();
        renderPromptGrid();
        closeEditor();
        showToast(wasEditing ? '提示词已更新' : '提示词已保存', 'success');
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

    function handleGridClick(event) {
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
            prompts = prompts.filter((item) => item.id !== prompt.id);
            persistPrompts();
            renderPromptGrid();
            if (editingId === prompt.id) closeEditor();
            selectedPromptIds.delete(prompt.id);
            showToast('提示词已删除', 'info');
        }
    }

    function handleImportListClick(event) {
        const item = event.target.closest('.prompt-import-item');
        if (!item) return;
        toggleImportSelection(item.dataset.id);
    }

    function initPromptLibrary() {
        const {
            button,
            modal,
            closeButton,
            newButton,
            importButton,
            exportButton,
            importInput,
            selectToggleButton,
            selectAllButton,
            deleteSelectedButton,
            cancelSelectButton,
            grid,
            saveButton,
            cancelButton,
            closeEditorButton,
            importDialog,
            importList,
            importSelectAllButton,
            confirmImportButton,
            cancelImportButton,
            closeImportButton
        } = getEls();
        if (!button || !modal) return;

        button.addEventListener('click', openLibrary);
        closeButton?.addEventListener('click', closeLibrary);
        newButton?.addEventListener('click', () => openEditor());
        importButton?.addEventListener('click', () => importInput?.click());
        exportButton?.addEventListener('click', exportPrompts);
        importInput?.addEventListener('change', () => {
            handleImportFile(importInput.files?.[0]);
            importInput.value = '';
        });
        selectToggleButton?.addEventListener('click', enterSelectionMode);
        selectAllButton?.addEventListener('click', toggleSelectAllPrompts);
        deleteSelectedButton?.addEventListener('click', deleteSelectedPrompts);
        cancelSelectButton?.addEventListener('click', exitSelectionMode);
        saveButton?.addEventListener('click', savePrompt);
        cancelButton?.addEventListener('click', closeEditor);
        closeEditorButton?.addEventListener('click', closeEditor);
        grid?.addEventListener('click', handleGridClick);
        importList?.addEventListener('click', handleImportListClick);
        importSelectAllButton?.addEventListener('click', toggleSelectAllImportCandidates);
        confirmImportButton?.addEventListener('click', confirmImportPrompts);
        cancelImportButton?.addEventListener('click', closeImportDialog);
        closeImportButton?.addEventListener('click', closeImportDialog);

        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeLibrary();
        });
        importDialog?.addEventListener('click', (event) => {
            if (event.target === importDialog) closeImportDialog();
        });

        documentRef.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
                const { importDialog: activeImportDialog } = getEls();
                if (activeImportDialog && !activeImportDialog.classList.contains('hidden')) {
                    closeImportDialog();
                    return;
                }
                closeLibrary();
            }
        });
    }

    return {
        initPromptLibrary,
        openLibrary,
        closeLibrary
    };
}
