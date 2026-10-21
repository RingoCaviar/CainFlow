import { createPromptAgentConversationStore, getPromptAgentReferenceKey } from './prompt-agent-conversation-store.js';
import { createPromptAgentPanelWidth } from './prompt-agent-panel-width.js';
import { createPromptAgentModelMenus } from './prompt-agent-model-menu.js';
import { bindPromptAgentCanvasDismiss } from './prompt-agent-canvas-dismiss.js';

const COMMANDS = [
    { name: '/clear', title: '清空上下文', description: '清除本场景的聊天、摘要、参考图和生成记录，重新开始。' },
    { name: '/compact', title: '压缩上下文', description: '用当前对话模型整理摘要，保留关键要求和最新方案。' }
];

function uniqueReferenceImages(images = []) {
    const seen = new Set();
    return images.filter((image) => {
        const key = getPromptAgentReferenceKey(image);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildDefaultReply({ message, context, workflowMemory = '', referenceImages = [], workflowReferenceImages = [] }) {
    const instruction = String(message || '').trim();
    const currentPrompt = String(context?.prompt || '').trim();
    const allReferenceImages = uniqueReferenceImages([
        ...(context?.referenceImages || []),
        ...workflowReferenceImages,
        ...referenceImages
    ]);
    const referenceInstruction = allReferenceImages.length
        ? `围绕参考图生成一张保持主体与构图一致的图像（${allReferenceImages.length} 张参考图）`
        : '';
    const prompt = currentPrompt
        ? `${workflowMemory ? `${workflowMemory}\n\n` : ''}${currentPrompt}${instruction ? `\n\n调整要求：${instruction}` : ''}`
        : (workflowMemory
            ? `${workflowMemory}${instruction ? `\n\n新要求：${instruction}` : ''}`
            : (instruction || referenceInstruction));
    return {
        message: context ? '已根据当前生图节点整理 Prompt Plan。' : '已整理 Prompt Plan；点击生成时会自动创建生图节点。',
        workSummary: context ? ['读取当前生图节点', '整理提示词与生成参数'] : ['理解创作需求', '整理提示词方向'],
        promptPlan: {
            targetNodeId: context?.nodeId || null,
            prompt,
            negativePrompt: context?.negativePrompt || '',
            parameters: { ...(context?.parameters || {}) },
            referenceImages: allReferenceImages
        }
    };
}

function readImageFile(file) {
    return new Promise((resolve, reject) => {
        if (!file || !String(file.type || '').startsWith('image/')) {
            reject(new TypeError('仅支持图片参考文件'));
            return;
        }
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve({
            name: String(file.name || '参考图'),
            type: String(file.type || 'image/*'),
            dataUrl: String(reader.result || '')
        }));
        reader.addEventListener('error', () => reject(reader.error || new Error('参考图读取失败')));
        reader.readAsDataURL(file);
    });
}

export function createPromptAgentController({
    documentRef = document,
    createReply = async (request) => buildDefaultReply(request),
    createCompaction = async () => { throw new Error('上下文压缩服务尚未配置。'); },
    nodeAdapter = null,
    executionAdapter = null,
    getChatModels = () => [],
    getImageModels = () => [],
    openModelSettings = () => {},
    getSelectedModelId = () => '',
    setSelectedModelId = () => {},
    getPanelWidth = () => null,
    setPanelWidth = () => {},
    conversationStore = createPromptAgentConversationStore(),
    onStateChange = () => {},
    getWorkflowId = () => '',
    mutateWorkflowConversation = null,
    retainRunResults = null,
    releaseRunResults = async () => {},
    saveConversation = async () => {},
    loadResultImages = async () => [],
    openResultPreview = () => {},
    createRunId = () => globalThis.crypto?.randomUUID?.() || `agent-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    readReferenceFile = readImageFile,
    resizeObserverFactory = (callback) => typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null
} = {}) {
    let initialized = false;
    let modelMenus = null;
    let panelWidthController = null;
    let resizeObserver = null;
    let scrollToLatestOnOpen = false;
    let workflowRevision = 0;
    let conversationRevision = 0;
    let activeOperation = null;
    let requestPending = false;
    let commandMenuOpen = false;
    let commandMatches = [];
    let commandIndex = 0;
    let pendingReferenceImages = [];
    let referencePickerOpen = false;
    let referencePickerError = '';
    const promptPlanActionStates = new Set();
    const runViews = new Map();
    const activeRuns = new Map();
    const runImages = new Map();
    const savingRuns = new Set();
    const runKey = (workflowId, runId) => `${workflowId}\0${runId}`;

    function getElements() {
        return {
            button: documentRef.getElementById('btn-prompt-agent'),
            panel: documentRef.getElementById('prompt-agent-panel'),
            closeButton: documentRef.getElementById('btn-close-prompt-agent'),
            form: documentRef.getElementById('prompt-agent-form'),
            input: documentRef.getElementById('prompt-agent-input'),
            sendButton: documentRef.getElementById('prompt-agent-send'),
            cancelButton: documentRef.getElementById('prompt-agent-cancel'),
            commandMenu: documentRef.getElementById('prompt-agent-command-menu'),
            commandStatus: documentRef.getElementById('prompt-agent-command-status'),
            modelSelect: documentRef.getElementById('prompt-agent-model'),
            modelHint: documentRef.getElementById('prompt-agent-model-hint'),
            addModelButton: documentRef.getElementById('prompt-agent-add-model'),
            imageModelSelect: documentRef.getElementById('prompt-agent-image-model'),
            imageModelHint: documentRef.getElementById('prompt-agent-image-model-hint'),
            imageModelStatus: documentRef.getElementById('prompt-agent-image-model-status'),
            addImageModelButton: documentRef.getElementById('prompt-agent-add-image-model'),
            messages: documentRef.getElementById('prompt-agent-messages'),
            scrollBottomButton: documentRef.getElementById('prompt-agent-scroll-bottom'),
            references: documentRef.getElementById('prompt-agent-references'),
            addReferenceButton: documentRef.getElementById('prompt-agent-add-reference'),
            referencePicker: documentRef.getElementById('prompt-agent-reference-picker'),
            referencePickerClose: documentRef.getElementById('prompt-agent-reference-picker-close'),
            referencePickerList: documentRef.getElementById('prompt-agent-reference-picker-list'),
            referencePickerStatus: documentRef.getElementById('prompt-agent-reference-picker-status'),
            referenceError: documentRef.getElementById('prompt-agent-reference-error')
        };
    }

    function renderModelOptions() {
        renderImageModelOptions();
        const { input, modelSelect, modelHint, sendButton } = getElements();
        const models = getChatModels().filter((model) => model?.id && model?.modelId);
        if (modelHint) modelHint.hidden = models.length > 0;
        // Local commands remain available without a model and during requests.
        if (sendButton) sendButton.disabled = !input?.value?.trim().startsWith('/')
            && (requestPending || models.length === 0 || pendingReferenceImages.some((image) => image.loading));
        if (!modelSelect) return models;
        const selected = getSelectedModelId() || models[0]?.id || '';
        modelSelect.replaceChildren?.();
        models.forEach((model) => {
            const option = documentRef.createElement('option');
            option.value = model.id;
            option.textContent = model.name || model.modelId;
            modelSelect.appendChild(option);
        });
        modelSelect.value = models.some((model) => model.id === selected) ? selected : (models[0]?.id || '');
        modelSelect.disabled = models.length === 0;
        return models;
    }

    function getSelectedImageModel() {
        const id = conversationStore.getImageModelId();
        return getImageModels().find((model) => model?.id === id && model?.modelId) || null;
    }

    function renderImageModelOptions() {
        const { imageModelSelect, imageModelHint, imageModelStatus, addImageModelButton } = getElements();
        const models = getImageModels().filter((model) => model?.id && model?.modelId);
        const selectedId = conversationStore.getImageModelId();
        const valid = models.some((model) => model.id === selectedId);
        if (imageModelSelect) {
            imageModelSelect.replaceChildren?.();
            const placeholder = documentRef.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '请选择生图模型';
            imageModelSelect.appendChild(placeholder);
            if (selectedId && !valid) {
                const missing = documentRef.createElement('option');
                missing.value = selectedId;
                missing.textContent = '已选模型不可用，请重新选择';
                missing.disabled = true;
                imageModelSelect.appendChild(missing);
            }
            models.forEach((model) => {
                const option = documentRef.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.modelId;
                imageModelSelect.appendChild(option);
            });
            // Never infer a selection from the first option or canvas node.
            imageModelSelect.value = selectedId;
            imageModelSelect.disabled = models.length === 0;
        }
        if (imageModelHint) imageModelHint.hidden = valid;
        if (imageModelStatus) imageModelStatus.textContent = selectedId && !valid
            ? '已选生图模型不可用，请重新选择。'
            : (models.length ? '请选择生图模型后再应用或生成。' : '暂无可用生图模型，');
        if (addImageModelButton) addImageModelButton.hidden = models.length > 0;
        promptPlanActionStates.forEach((actionState) => actionState.sync());
    }

    function setCommandStatus(text = '') {
        const { commandStatus } = getElements();
        if (!commandStatus) return;
        commandStatus.textContent = text;
        commandStatus.hidden = !text;
    }

    function closeCommandMenu() {
        commandMenuOpen = false;
        const { commandMenu, input } = getElements();
        if (commandMenu) commandMenu.hidden = true;
        input?.setAttribute('aria-expanded', 'false');
        input?.removeAttribute('aria-activedescendant');
    }

    function renderCommandMenu({ resetSelection = false } = {}) {
        const { commandMenu, input } = getElements();
        const query = input?.value?.trim().toLowerCase() || '';
        commandMatches = query.startsWith('/') && !/\s/.test(query)
            ? COMMANDS.filter((command) => command.name.startsWith(query) || command.title.includes(query.slice(1)))
            : [];
        if (!commandMenu || !commandMatches.length) {
            closeCommandMenu();
            return;
        }
        if (resetSelection) commandIndex = 0;
        commandIndex = Math.min(commandIndex, commandMatches.length - 1);
        setReferencePickerOpen(false);
        clearElement(commandMenu);
        commandMatches.forEach((command, index) => {
            const option = documentRef.createElement('button');
            option.type = 'button';
            option.className = 'prompt-agent-command-option';
            option.id = `prompt-agent-command-${command.name.slice(1)}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === commandIndex));
            option.classList.toggle('is-active', index === commandIndex);
            for (const field of ['name', 'title', 'description']) {
                const label = documentRef.createElement('span');
                label.className = `prompt-agent-command-${field}`;
                label.textContent = command[field];
                option.appendChild(label);
            }
            option.addEventListener('click', () => executeCommand(command.name));
            commandMenu.appendChild(option);
        });
        commandMenuOpen = true;
        commandMenu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('aria-activedescendant', `prompt-agent-command-${commandMatches[commandIndex].name.slice(1)}`);
    }

    function beginOperation(kind) {
        const operation = { kind, controller: new AbortController(), revision: workflowRevision };
        activeOperation = operation;
        requestPending = true;
        const { cancelButton } = getElements();
        if (cancelButton) cancelButton.hidden = false;
        renderModelOptions();
        return operation;
    }

    function isCurrentOperation(operation) {
        return activeOperation === operation && operation.revision === workflowRevision && !operation.controller.signal.aborted;
    }

    function finishOperation(operation) {
        // A late finally must never reset another workflow's newer request.
        if (activeOperation !== operation) return;
        activeOperation = null;
        requestPending = false;
        const { cancelButton } = getElements();
        if (cancelButton) cancelButton.hidden = true;
        renderModelOptions();
    }

    function cancelRequest({ silent = false } = {}) {
        const operation = activeOperation;
        if (!operation) return;
        operation.controller.abort();
        finishOperation(operation);
        if (silent) return;
        if (operation.kind === 'compact') setCommandStatus('已取消压缩，原上下文已保留。');
        else appendMessage('agent', '已取消本次 Agent 请求。');
    }

    async function executeCommand(name) {
        const { input } = getElements();
        closeCommandMenu();
        if (name === '/clear') {
            const clearedWorkflowId = getWorkflowId();
            const oldSnapshot = conversationStore.snapshot();
            const clearedRuns = [...(oldSnapshot.archivedMessages || []), ...(oldSnapshot.messages || [])]
                .flatMap((message) => message.runs || []);
            cancelRequest({ silent: true });
            workflowRevision += 1;
            const clearedRevision = workflowRevision;
            conversationStore.clear();
            const prefix = `${getWorkflowId()}\0`;
            for (const key of runImages.keys()) if (key.startsWith(prefix)) runImages.delete(key);
            pendingReferenceImages = [];
            referencePickerError = '';
            if (input) input.value = '';
            setReferencePickerOpen(false);
            renderConversation();
            renderPendingReferences();
            setCommandStatus('已清空上下文，可以开始新的对话。');
            onStateChange();
            input?.focus?.();
            try {
                await saveConversation();
                const released = await Promise.all(clearedRuns.map((run) => releaseRunResults({ ...run, workflowId: clearedWorkflowId })));
                if (released.some((value) => value === false)) throw new Error('媒体清理待重试');
            } catch {
                if (workflowRevision === clearedRevision && getWorkflowId() === clearedWorkflowId) {
                    setCommandStatus('上下文已清空，但保存或媒体清理失败，请稍后重试保存工作流。');
                }
            }
            return;
        }
        if (name !== '/compact') {
            setCommandStatus('未知命令。输入 / 选择 /clear 或 /compact。');
            return;
        }
        if (requestPending) {
            setCommandStatus('请等待当前请求完成，或先停止请求后再压缩。');
            return;
        }
        const conversation = conversationStore.getCompactionContext();
        const hasNewContext = conversation.messages.length > 0 || conversation.memory
            || (!conversation.contextSummary && conversation.previousPromptPlan);
        if (!hasNewContext) {
            setCommandStatus(conversation.contextSummary ? '上下文已压缩，还没有新增对话。' : '还没有需要压缩的上下文。');
            if (input) input.value = '';
            renderModelOptions();
            return;
        }
        const models = renderModelOptions();
        if (!models.length) {
            setCommandStatus('请先配置一个可用的对话模型，再压缩上下文。');
            return;
        }
        const modelId = getElements().modelSelect?.value || getSelectedModelId() || models[0].id;
        if (input) input.value = '';
        const operation = beginOperation('compact');
        const revision = conversationRevision;
        setCommandStatus('正在压缩上下文，整理目标、约束与最新方案…');
        try {
            const result = await createCompaction({ conversation, modelId, signal: operation.controller.signal });
            if (!isCurrentOperation(operation)) return;
            if (revision !== conversationRevision) throw new Error('压缩期间对话已更新，请重新压缩');
            conversationStore.compact(result?.summary);
            // Keep the transcript and any running generation cards in place.
            onStateChange();
            setCommandStatus('上下文已压缩。后续对话将使用摘要，历史记录仍可查看。');
        } catch (error) {
            if (!isCurrentOperation(operation)) return;
            setCommandStatus(`压缩失败：${error?.message || '请重试'}。原上下文已保留。`);
        } finally {
            finishOperation(operation);
        }
    }

    function appendReferencePreviews(container, referenceImages = [], { removable = false } = {}) {
        referenceImages.forEach((reference, index) => {
            const item = documentRef.createElement('span');
            item.className = 'prompt-agent-reference';
            const image = documentRef.createElement('img');
            image.src = reference.dataUrl || reference.previewUrl || '';
            image.alt = `参考图 ${index + 1}：${reference.name || '图片'}`;
            image.title = image.alt;
            image.draggable = false;
            item.appendChild(image);
            const number = documentRef.createElement('span');
            number.className = 'prompt-agent-reference-number';
            number.textContent = String(index + 1);
            number.setAttribute('aria-hidden', 'true');
            item.appendChild(number);
            if (reference.loading) {
                item.classList.add('is-loading');
                item.setAttribute('aria-busy', 'true');
                item.title = '正在读取原图…';
            }
            if (removable) {
                const removeButton = documentRef.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'prompt-agent-reference-remove';
                removeButton.textContent = '×';
                removeButton.setAttribute('aria-label', `移除 ${image.alt}`);
                removeButton.addEventListener('click', () => {
                    pendingReferenceImages.splice(index, 1);
                    referencePickerError = '';
                    renderPendingReferences();
                });
                item.appendChild(removeButton);
            }
            container.appendChild(item);
        });
    }

    function renderPendingReferences() {
        const { references, form, referenceError } = getElements();
        if (!references) return;
        clearElement(references);
        appendReferencePreviews(references, pendingReferenceImages, { removable: true });
        references.hidden = pendingReferenceImages.length === 0;
        form?.classList.toggle('has-reference-images', pendingReferenceImages.length > 0);
        if (referenceError) {
            referenceError.hidden = !referencePickerError;
            referenceError.textContent = referencePickerError;
        }
        renderReferencePicker();
        renderModelOptions();
    }

    function renderReferencePicker() {
        const { referencePickerList, referencePickerStatus } = getElements();
        if (!referencePickerOpen || !referencePickerList) return;
        const focusedId = documentRef.activeElement?.getAttribute?.('data-reference-id');
        clearElement(referencePickerList);
        const candidates = nodeAdapter?.getSceneReferenceImages?.() || [];
        if (referencePickerStatus) referencePickerStatus.textContent = candidates.length
            ? `${candidates.length} 张图片 · 已选 ${pendingReferenceImages.length} 张，按勾选顺序编号`
            : '当前场景还没有可用的图片导入节点。';
        candidates.forEach((candidate) => {
            const index = pendingReferenceImages.findIndex((item) => getPromptAgentReferenceKey(item) === getPromptAgentReferenceKey(candidate));
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'prompt-agent-reference-option';
            button.classList.toggle('is-selected', index >= 0);
            button.setAttribute('role', 'checkbox');
            button.setAttribute('aria-checked', String(index >= 0));
            button.setAttribute('aria-label', `${candidate.name}${index >= 0 ? `，参考图 ${index + 1}` : ''}`);
            button.setAttribute('data-reference-id', candidate.referenceId);
            const thumbnail = documentRef.createElement('span');
            thumbnail.className = 'prompt-agent-reference-option-preview';
            if (candidate.previewUrl) {
                const image = documentRef.createElement('img');
                image.src = candidate.previewUrl;
                image.alt = '';
                image.loading = 'lazy';
                image.draggable = false;
                thumbnail.appendChild(image);
            } else {
                thumbnail.textContent = '读取原图';
            }
            const check = documentRef.createElement('span');
            check.className = 'prompt-agent-reference-check';
            check.textContent = index >= 0 ? '✓' : '';
            check.setAttribute('aria-hidden', 'true');
            thumbnail.appendChild(check);
            if (index >= 0) {
                const number = documentRef.createElement('span');
                number.className = 'prompt-agent-reference-number';
                number.textContent = String(index + 1);
                number.setAttribute('aria-hidden', 'true');
                thumbnail.appendChild(number);
            }
            button.appendChild(thumbnail);
            const label = documentRef.createElement('span');
            label.className = 'prompt-agent-reference-option-label';
            label.textContent = candidate.name;
            label.title = candidate.name;
            button.appendChild(label);
            button.addEventListener('click', () => toggleSceneReference(candidate));
            referencePickerList.appendChild(button);
            if (candidate.referenceId === focusedId) button.focus?.();
        });
    }

    function setReferencePickerOpen(open, focusTrigger = false) {
        if (open) closeCommandMenu();
        referencePickerOpen = open;
        const { referencePicker, addReferenceButton, referencePickerList } = getElements();
        if (referencePicker) referencePicker.hidden = !open;
        addReferenceButton?.setAttribute('aria-expanded', String(open));
        if (open) {
            renderReferencePicker();
            referencePickerList?.querySelector?.('button')?.focus?.();
        } else if (focusTrigger) addReferenceButton?.focus?.();
    }

    async function toggleSceneReference(candidate) {
        referencePickerError = '';
        const key = getPromptAgentReferenceKey(candidate);
        const index = pendingReferenceImages.findIndex((item) => getPromptAgentReferenceKey(item) === key);
        if (index >= 0) {
            pendingReferenceImages.splice(index, 1);
            renderPendingReferences();
            return;
        }
        // Reserve the position immediately so slow image reads cannot reorder
        // the user's selections. Removing it cancels this pending selection.
        const pending = { ...candidate, loading: true };
        const revision = workflowRevision;
        pendingReferenceImages.push(pending);
        renderPendingReferences();
        try {
            const resolved = await nodeAdapter?.readSceneReferenceImage?.(candidate);
            if (revision !== workflowRevision || !pendingReferenceImages.includes(pending)) return;
            if (!resolved?.dataUrl?.startsWith('data:image/')) throw new Error('参考图读取失败，请重新选择。');
            Object.assign(pending, resolved);
            delete pending.loading;
        } catch (error) {
            if (revision !== workflowRevision || !pendingReferenceImages.includes(pending)) return;
            pendingReferenceImages.splice(pendingReferenceImages.indexOf(pending), 1);
            referencePickerError = `${candidate.name}：${error?.message || '参考图读取失败，请重试。'}`;
        }
        renderPendingReferences();
    }

    async function addReferenceFiles(files = []) {
        const imageFiles = Array.from(files).filter((file) => String(file?.type || '').startsWith('image/'));
        if (imageFiles.length === 0) return false;
        const requestWorkflowRevision = workflowRevision;
        const results = await Promise.allSettled(imageFiles.map((file) => readReferenceFile(file)));
        if (requestWorkflowRevision !== workflowRevision) return false;
        const references = results
            .filter((result) => result.status === 'fulfilled')
            .map((result) => result.value)
            .filter((reference) => typeof reference?.dataUrl === 'string' && reference.dataUrl.startsWith('data:image/'));
        if (references.length === 0) return false;
        pendingReferenceImages = uniqueReferenceImages([...pendingReferenceImages, ...references]);
        renderPendingReferences();
        return true;
    }

    function insertPastedText(text) {
        if (!text) return;
        const { input } = getElements();
        if (!input) return;
        const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
        const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
        if (typeof input.setRangeText === 'function') input.setRangeText(text, start, end, 'end');
        else input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
        input.dispatchEvent?.(new Event('input', { bubbles: true }));
    }

    function setOpen(open) {
        const { button, panel } = getElements();
        panel?.classList.toggle('active', open);
        panel?.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) panel?.removeAttribute('inert');
        else panel?.setAttribute('inert', '');
        button?.classList.toggle('active', open);
        button?.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) {
            modelMenus?.close();
            setReferencePickerOpen(false);
            closeCommandMenu();
        }
    }

    function updateScrollBottomButton() {
        const { messages, scrollBottomButton } = getElements();
        if (scrollBottomButton && messages) {
            scrollBottomButton.hidden = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
        }
    }

    function scrollToLatest() {
        const { messages } = getElements();
        scrollToLatestOnOpen = messages?.clientHeight === 0;
        if (messages) messages.scrollTop = messages.scrollHeight;
        updateScrollBottomButton();
    }

    function open() {
        // Model settings can finish loading after the controller is initialized.
        // Refresh here so the first request always sees the current chat models.
        renderModelOptions();
        setOpen(true);
        if (documentRef.activeElement === getElements().button) getElements().input?.focus?.();
        panelWidthController?.apply();
        if (scrollToLatestOnOpen) scrollToLatest();
        updateScrollBottomButton();
    }
    function close() { setOpen(false); }
    function toggle() {
        const { panel } = getElements();
        if (panel?.classList.contains('active')) close();
        else open();
    }

    function appendMessage(role, text, workSummary = [], { record = true, promptPlan = null, referenceImages = [], intent } = {}) {
        const { messages } = getElements();
        if (!messages) return null;
        const followLatest = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
        const emptyState = messages.querySelector?.('.prompt-agent-empty');
        emptyState?.remove?.();
        const message = documentRef.createElement('article');
        message.className = `prompt-agent-message prompt-agent-message-${role}`;
        message.setAttribute('data-role', role);

        if (role === 'agent' && workSummary.length) {
            const details = documentRef.createElement('details');
            details.className = 'prompt-agent-work-summary';
            details.open = false;
            const summary = documentRef.createElement('summary');
            summary.textContent = '工作过程';
            details.appendChild(summary);
            const list = documentRef.createElement('ol');
            workSummary.forEach((step) => {
                const item = documentRef.createElement('li');
                item.textContent = step;
                list.appendChild(item);
            });
            details.appendChild(list);
            message.appendChild(details);
        }

        const body = documentRef.createElement('div');
        body.className = 'prompt-agent-message-body';
        body.textContent = text;
        message.appendChild(body);
        if (referenceImages.length) {
            const references = documentRef.createElement('div');
            references.className = 'prompt-agent-message-references';
            appendReferencePreviews(references, referenceImages);
            message.appendChild(references);
        }
        messages.appendChild(message);
        if (followLatest) messages.scrollTop = messages.scrollHeight;
        updateScrollBottomButton();
        if (record) {
            message.promptAgentMessageIndex = conversationStore.append({ role, text, workSummary, promptPlan, referenceImages, intent });
            conversationRevision += 1;
            onStateChange();
        }
        return message;
    }

    function formatPlan(plan) {
        const parts = [`Prompt\n${plan.prompt || '—'}`];
        if (typeof plan.negativePrompt === 'string') parts.push(`Negative Prompt\n${plan.negativePrompt || '清空'}`);
        const parameters = Object.entries(plan.parameters || {})
            .filter(([, value]) => value !== '' && value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
        if (parameters.length) parts.push(`参数\n${parameters.join(' · ')}`);
        if (plan.referenceImages?.length) {
            const roleNames = { 'edit-target': '编辑目标', reference: '参考', supporting: '合成素材' };
            const roles = plan.referenceImages.filter((image) => roleNames[image.role])
                .map((image, index) => `${image.name || `图片 ${index + 1}`}：${roleNames[image.role]}`);
            parts.push([`参考图\n${plan.referenceImages.length} 张`, ...roles].join('\n'));
        }
        return parts.join('\n\n');
    }

    function appendPromptPlan(message, plan, runs = []) {
        if (!message || !plan) return;
        const revision = workflowRevision;
        // Target creation is an explicit action, never a side effect of rendering
        // or canvas selection. Persist the binding before a potentially failed run.
        const preparePlan = () => {
            if (revision !== workflowRevision) throw new Error('工作流或上下文已变化，请使用当前方案。');
            const model = getSelectedImageModel();
            if (!model) throw new Error('请先选择一个可用的生图模型。');
            const prepared = nodeAdapter?.ensureTarget ? nodeAdapter.ensureTarget(plan, { modelId: model.id }) : plan;
            if (!prepared?.targetNodeId) throw new Error('无法创建生图节点，请检查生图模型配置。');
            if (!conversationStore.bindPromptPlanTarget(message.promptAgentMessageIndex, prepared.targetNodeId)) {
                throw new Error('方案已变化，请重新整理方案。');
            }
            Object.assign(plan, prepared);
            conversationRevision += 1;
            onStateChange();
            return plan;
        };
        const planElement = documentRef.createElement('section');
        planElement.className = 'prompt-agent-plan';
        planElement.textContent = formatPlan(plan);
        message.appendChild(planElement);

        const actions = documentRef.createElement('div');
        actions.className = 'prompt-agent-actions';
        const actionState = {
            appliedModelId: '',
            running: runs.some((run) => run.status === 'running'),
            retryButtons: new Set(),
            isCurrent: () => revision === workflowRevision,
            preparePlan,
            sync() {
                const model = getSelectedImageModel();
                const available = this.isCurrent() && Boolean(nodeAdapter) && Boolean(model);
                const applied = Boolean(model && this.appliedModelId === model.id);
                applyButton.disabled = applied || this.running || !available;
                generateButton.disabled = this.running || !available || !executionAdapter;
                applyButton.textContent = applied ? '已应用' : (plan.targetNodeId ? '应用到节点' : '创建并应用');
                generateButton.textContent = plan.targetNodeId ? '应用并生成' : '创建并生成';
                this.retryButtons.forEach((button) => { button.disabled = this.running || !available; });
            }
        };
        promptPlanActionStates.add(actionState);
        const applyButton = documentRef.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'btn btn-primary';
        applyButton.textContent = '应用到节点';
        applyButton.addEventListener('click', () => {
            if (!actionState.isCurrent() || actionState.running
                || (actionState.appliedModelId && actionState.appliedModelId === getSelectedImageModel()?.id)) return;
            try {
                if (!nodeAdapter?.applyPromptPlan?.(preparePlan())) {
                    throw new Error('目标节点或可用参数已变化，请基于当前节点重新整理方案。');
                }
                actionState.appliedModelId = getSelectedImageModel().id;
                applyButton.textContent = '已应用';
            } catch (error) {
                appendMessage('agent', `方案未应用：${error.message}`);
            }
            actionState.sync();
        });
        actions.appendChild(applyButton);

        const generateButton = documentRef.createElement('button');
        generateButton.type = 'button';
        generateButton.className = 'btn btn-secondary';
        generateButton.textContent = '应用并生成';
        generateButton.addEventListener('click', async () => {
            await runPromptPlan(message, plan, actions, null, actionState);
        });
        actions.appendChild(generateButton);
        message.appendChild(actions);
        actionState.applyButton = applyButton;
        actionState.generateButton = generateButton;
        actionState.sync();
        return actionState;
    }

    function refreshActionStates() {
        renderImageModelOptions();
        renderReferencePicker();
    }

    function clearElement(element) {
        if (typeof element.replaceChildren === 'function') element.replaceChildren();
        else if (Array.isArray(element.children)) element.children.length = 0;
    }

    function mutateRun(workflowId, runId, update, revision = workflowRevision) {
        if (mutateWorkflowConversation) {
            return mutateWorkflowConversation(workflowId, (snapshot) => {
                const run = [...(snapshot?.archivedMessages || []), ...(snapshot?.messages || [])]
                    .flatMap((message) => message.runs || []).find((candidate) => candidate.runId === runId);
                if (!run) return false;
                return update(run) === false ? false : snapshot;
            });
        }
        if (revision !== workflowRevision || getWorkflowId() !== workflowId) return false;
        const run = conversationStore.getRun(runId);
        if (!run || update(run) === false) return false;
        conversationStore.finishRun(runId, run);
        conversationRevision += 1;
        onStateChange();
        refreshRunViews();
        return true;
    }

    function readRun(workflowId, runId, revision) {
        let found = null;
        mutateRun(workflowId, runId, (run) => { found = { ...run }; return false; }, revision);
        return found;
    }

    async function persistRun(workflowId, runId, result, revision) {
        const key = runKey(workflowId, runId);
        if (savingRuns.has(key)) return;
        savingRuns.add(key);
        let retained = result.mediaOwnershipTemporaryOwners?.length
            ? { ...result, persistenceStatus: 'retained', persistenceError: '' } : result;
        let handoffComplete = false;
        try {
            if (!readRun(workflowId, runId, revision)) return;
            if (result.images?.length) runImages.set(key, result.images.slice());
            if (retainRunResults && !result.mediaOwnershipTemporaryOwners?.length && result.persistenceStatus !== 'saved') {
                retained = { ...result, ...await retainRunResults({ workflowId, runId,
                    images: result.images || runImages.get(key) || [], mediaAssetKeys: result.mediaAssetKeys || [] }) };
            }
            const accepted = mutateRun(workflowId, runId, (run) => Object.assign(run, {
                status: 'completed', mediaAssetKeys: retained.mediaAssetKeys || [],
                persistenceStatus: retained.persistenceStatus || 'retained',
                persistenceError: retained.persistenceError || '',
                mediaOwnershipTemporaryOwners: retained.mediaOwnershipTemporaryOwners || []
            }), revision);
            if (!accepted) {
                await releaseRunResults({ workflowId, runId, ...retained });
                runImages.delete(key);
                return;
            }
            if (retained.persistenceStatus === 'failed') return;
            await saveConversation();
            if (!readRun(workflowId, runId, revision)) {
                await releaseRunResults({ workflowId, runId, ...retained });
                return;
            }
            if (await releaseRunResults({ workflowId, runId, ...retained }) === false) {
                throw new Error('图片已保存，媒体引用交接尚未完成，请重试保存。');
            }
            handoffComplete = true;
            mutateRun(workflowId, runId, (run) => Object.assign(run, {
                persistenceStatus: 'saved', persistenceError: '', mediaOwnershipTemporaryOwners: []
            }), revision);
            await saveConversation();
        } catch (error) {
            // The first flush already committed the pictures and the release
            // completed. A failed cleanup-status flush must not rematerialize
            // this now-fenced operation when the user returns to the result.
            if (handoffComplete) return;
            mutateRun(workflowId, runId, (run) => Object.assign(run, {
                status: 'completed', persistenceStatus: 'failed',
                persistenceError: error?.message || '本地保存失败'
            }), revision);
        } finally {
            savingRuns.delete(key);
            if (getWorkflowId() === workflowId) refreshRunViews();
        }
    }

    function renderCompletedRun(runState, result, images = result?.images || []) {
        clearElement(runState);
        runState.textContent = result.persistenceStatus === 'failed'
            ? `生成完成，但保存失败：${result.persistenceError || '请重试保存'}` : '生成完成';
        images.forEach((source, index) => {
            if (!source) {
                const missing = documentRef.createElement('span');
                missing.className = 'prompt-agent-result-missing';
                missing.textContent = `第 ${index + 1} 张图片文件缺失`;
                runState.appendChild(missing);
                return;
            }
            const image = documentRef.createElement('img');
            image.className = 'prompt-agent-result-image';
            image.src = source;
            image.alt = `查看第 ${index + 1} 张生成结果`;
            image.tabIndex = 0;
            image.loading = 'lazy';
            image.setAttribute('role', 'button');
            const preview = () => openResultPreview(images.filter(Boolean), images.slice(0, index).filter(Boolean).length);
            image.addEventListener('click', preview);
            image.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                preview();
            });
            runState.appendChild(image);
        });
    }

    function renderRunView(view, run) {
        const { element, workflowId, revision } = view;
        const key = runKey(workflowId, run.runId);
        const token = {};
        view.token = token;
        const renderImages = (images) => {
            if (view.token !== token || runViews.get(run.runId) !== view) return;
            renderCompletedRun(element, run, images);
            if (run.persistenceStatus === 'failed' || run.persistenceStatus === 'retained') {
                const retry = documentRef.createElement('button');
                retry.type = 'button';
                retry.className = 'btn btn-secondary';
                retry.textContent = '重试保存';
                retry.disabled = savingRuns.has(key);
                retry.addEventListener('click', () => persistRun(workflowId, run.runId, {
                    ...run, images: runImages.get(key) || images
                }, revision));
                element.appendChild(retry);
            }
        };
        if (run.status === 'completed') {
            const images = runImages.get(key);
            if (images) renderImages(images);
            else if (run.mediaAssetKeys?.length) {
                clearElement(element);
                element.textContent = '正在读取生成结果…';
                void loadResultImages(run.mediaAssetKeys).then((resolved) => {
                    const slots = run.mediaAssetKeys.map((_, index) => resolved[index] || null);
                    renderImages(slots);
                }).catch(() => renderImages(run.mediaAssetKeys.map(() => null)));
            } else renderImages([]);
        } else if (run.status === 'failed') {
            renderFailedRun(element, view.plan, run.error || '未知错误', view.actionState);
        } else {
            clearElement(element);
            element.textContent = run.status === 'running' ? '正在生成…' : run.status === 'stopped' ? '已停止' : '上次生成已中断';
            if (run.status === 'running') {
                const stop = documentRef.createElement('button');
                stop.type = 'button';
                stop.className = 'btn btn-ghost';
                stop.textContent = '停止';
                stop.addEventListener('click', () => {
                    if (getWorkflowId() === workflowId) executionAdapter?.stop?.(run.targetNodeId);
                });
                element.appendChild(stop);
            }
        }
    }

    function refreshRunViews() {
        for (const [runId, view] of runViews) {
            const run = conversationStore.getRun(runId);
            if (run) renderRunView(view, run);
        }
    }

    function renderFailedRun(runState, plan, message, actionState = null) {
        clearElement(runState);
        runState.textContent = `生成失败：${message}`;
        const retryButton = documentRef.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'btn btn-secondary';
        retryButton.textContent = '重试';
        actionState?.retryButtons.add(retryButton);
        retryButton.addEventListener('click', async () => runPromptPlan(runState.parentElement || null, plan, null, null, actionState));
        const focusButton = documentRef.createElement('button');
        focusButton.type = 'button';
        focusButton.className = 'btn btn-ghost';
        focusButton.textContent = '返回节点';
        focusButton.disabled = !plan.targetNodeId;
        focusButton.addEventListener('click', () => {
            if (actionState?.isCurrent() && plan.targetNodeId) executionAdapter?.focus?.(plan.targetNodeId);
        });
        runState.appendChild(retryButton);
        runState.appendChild(focusButton);
    }

    async function runPromptPlan(message, plan, actions = null, existingRunState = null, actionState = null) {
        if (!executionAdapter || !plan || actionState?.running || !actionState?.isCurrent()) return;
        const revision = workflowRevision;
        const workflowId = getWorkflowId();
        const runId = createRunId();
        const key = runKey(workflowId, runId);
        let runState = existingRunState;
        if (!runState) {
            runState = documentRef.createElement('section');
            runState.className = 'prompt-agent-run-state';
            message?.appendChild(runState);
        }
        clearElement(runState);
        runState.textContent = '正在生成…';
        const stopButton = documentRef.createElement('button');
        stopButton.type = 'button';
        stopButton.className = 'btn btn-ghost';
        stopButton.textContent = '停止';
        stopButton.addEventListener('click', () => {
            if (actionState.isCurrent() && plan.targetNodeId) executionAdapter.stop?.(plan.targetNodeId);
        });
        runState.appendChild(stopButton);
        if (actionState) {
            // A generation may switch this target to another model even if
            // execution later fails. An earlier apply badge is no longer valid.
            actionState.appliedModelId = '';
            actionState.running = true;
            actionState.sync();
        }
        Array.from(actions?.children || []).forEach((button) => { button.disabled = true; });
        try {
            const prepared = actionState.preparePlan();
            if (!conversationStore.beginRun(message.promptAgentMessageIndex, {
                runId, targetNodeId: prepared.targetNodeId, status: 'running', mediaAssetKeys: [], persistenceStatus: 'pending'
            })) throw new Error('方案已变化，请重新整理方案。');
            activeRuns.set(key, true);
            runViews.set(runId, { element: runState, workflowId, revision, plan, actionState });
            onStateChange();
            let retainedByRuntime = false;
            const result = await executionAdapter.applyAndGenerate(prepared, {
                retainResults: async (completion) => {
                    const entry = completion.nodeResults?.find((node) => node.nodeId === prepared.targetNodeId);
                    if (entry && !entry.error && completion.outcome === 'completed'
                        && completion.started !== false && completion.executed !== false) {
                        retainedByRuntime = true;
                        await persistRun(workflowId, runId, entry, revision);
                    }
                    return completion;
                }
            });
            if (result?.status === 'stopped') {
                mutateRun(workflowId, runId, (run) => { run.status = 'stopped'; }, revision);
            } else if (!retainedByRuntime) await persistRun(workflowId, runId, result, revision);
        } catch (error) {
            const recorded = mutateRun(workflowId, runId, (run) => Object.assign(run, {
                status: 'failed', error: error?.message || '未知错误'
            }), revision);
            if (!recorded && actionState.isCurrent()) renderFailedRun(runState, plan, error?.message || '未知错误', actionState);
        } finally {
            activeRuns.delete(key);
            Array.from(actions?.children || []).forEach((button) => { button.disabled = false; });
            if (actionState) {
                actionState.running = false;
                actionState.sync();
            }
            if (getWorkflowId() === workflowId) {
                for (const view of runViews.values()) {
                    if (view.plan === plan || view.plan.targetNodeId === plan.targetNodeId) {
                        view.actionState.running = false;
                        view.actionState.sync();
                    }
                }
                refreshRunViews();
            }
        }
    }

    async function submit() {
        const { input } = getElements();
        const text = input?.value?.trim();
        if (text?.startsWith('/')) {
            await executeCommand(text.toLowerCase());
            return;
        }
        // Do this immediately before reading the select value. This covers late
        // settings hydration and prevents an otherwise valid request from being
        // sent without a modelId.
        const models = renderModelOptions();
        if (requestPending || models.length === 0 || pendingReferenceImages.some((image) => image.loading)) return;
        const referenceImages = pendingReferenceImages.slice();
        if (!text && referenceImages.length === 0) return;
        const workflowMemory = conversationStore.getContext();
        // Snapshot before appending the current turn: preserve assistant drafts
        // and role boundaries without duplicating the new user request.
        const conversation = conversationStore.snapshot();
        const workflowReferenceImages = uniqueReferenceImages([
            ...conversationStore.getReferenceImages(),
            ...referenceImages
        ]);
        appendMessage('user', text || `添加了 ${referenceImages.length} 张参考图`, [], { referenceImages });
        input.value = '';
        pendingReferenceImages = [];
        referencePickerError = '';
        setReferencePickerOpen(false);
        closeCommandMenu();
        setCommandStatus();
        renderPendingReferences();
        const operation = beginOperation('reply');
        try {
            const previousPlan = conversation.messages.findLast((message) => message.promptPlan)?.promptPlan
                || conversation.previousPromptPlan;
            const context = nodeAdapter?.getSelectedContext?.()
                || (previousPlan?.targetNodeId ? nodeAdapter?.getContext?.(previousPlan.targetNodeId) : null)
                || null;
            const reply = await createReply({
                message: text,
                context,
                workflowMemory,
                conversation,
                referenceImages,
                workflowReferenceImages,
                modelId: getElements().modelSelect?.value || getSelectedModelId() || models[0].id,
                signal: operation.controller.signal
            });
            if (!isCurrentOperation(operation)) return;
            const agentMessage = appendMessage('agent', reply?.message || '已整理本轮回复。', reply?.workSummary || [], {
                promptPlan: reply?.promptPlan || null, intent: reply?.intent
            });
            appendPromptPlan(agentMessage, reply?.promptPlan);
        } catch (error) {
            if (!isCurrentOperation(operation)) return;
            appendMessage('agent', error?.message || 'Agent 暂时无法回复，请稍后重试。');
        } finally {
            finishOperation(operation);
        }
    }

    function ensurePanelWidth() {
        if (!panelWidthController) {
            panelWidthController = createPromptAgentPanelWidth({ panel: getElements().panel, handle: documentRef.getElementById('prompt-agent-resize'), windowRef: documentRef.defaultView, read: getPanelWidth, write: setPanelWidth });
        }
        return panelWidthController;
    }

    function init() {
        if (initialized) return;
        const { messages, scrollBottomButton } = getElements();
        messages?.addEventListener('scroll', updateScrollBottomButton, { passive: true });
        messages?.addEventListener('load', updateScrollBottomButton, true);
        scrollBottomButton?.addEventListener('click', scrollToLatest);
        const MutationObserverClass = documentRef.defaultView?.MutationObserver;
        if (messages && MutationObserverClass) {
            new MutationObserverClass(updateScrollBottomButton).observe(messages, { childList: true, subtree: true, characterData: true });
        }
        const { button, closeButton, form, input, modelSelect, addModelButton, cancelButton, addReferenceButton, referencePickerClose } = getElements();
        button?.addEventListener('click', toggle);
        closeButton?.addEventListener('click', close);
        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submit();
        });
        modelSelect?.addEventListener('change', () => setSelectedModelId(modelSelect.value));
        modelSelect?.addEventListener('focus', renderModelOptions);
        addModelButton?.addEventListener('click', openModelSettings);
        const { imageModelSelect, addImageModelButton } = getElements();
        imageModelSelect?.addEventListener('change', () => {
            const modelId = imageModelSelect.value;
            if (modelId && !getImageModels().some((model) => model.id === modelId)) return;
            if (conversationStore.setImageModelId(modelId)) onStateChange();
            renderImageModelOptions();
        });
        imageModelSelect?.addEventListener('focus', renderImageModelOptions);
        addImageModelButton?.addEventListener('click', openModelSettings);
        input?.addEventListener('focus', renderModelOptions);
        input?.addEventListener('input', () => {
            renderCommandMenu({ resetSelection: true });
            renderModelOptions();
        });
        input?.addEventListener('keydown', async (event) => {
            if (event.isComposing || event.keyCode === 229 || (event.key === 'Enter' && event.shiftKey)) return;
            if (commandMenuOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation?.();
                if (event.key === 'Escape') closeCommandMenu();
                else if (event.key === 'Enter') await executeCommand(commandMatches[commandIndex].name);
                else {
                    commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) % commandMatches.length;
                    renderCommandMenu();
                }
            } else if (event.key === 'Enter' && !event.shiftKey && input.value.trim().startsWith('/')) {
                event.preventDefault();
                await submit();
            }
        });
        cancelButton?.addEventListener('click', () => cancelRequest());
        addReferenceButton?.addEventListener('click', () => setReferencePickerOpen(!referencePickerOpen));
        referencePickerClose?.addEventListener('click', () => setReferencePickerOpen(false, true));
        form?.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && commandMenuOpen) {
                event.preventDefault();
                event.stopPropagation?.();
                closeCommandMenu();
                input?.focus?.();
                return;
            }
            if (event.key !== 'Escape' || !referencePickerOpen) return;
            event.preventDefault();
            event.stopPropagation?.();
            setReferencePickerOpen(false, true);
        });
        documentRef.addEventListener?.('pointerdown', (event) => {
            const { referencePicker, addReferenceButton, commandMenu, input } = getElements();
            if (referencePickerOpen && !referencePicker?.contains?.(event.target) && !addReferenceButton?.contains?.(event.target)) {
                setReferencePickerOpen(false);
            }
            if (commandMenuOpen && !commandMenu?.contains?.(event.target) && event.target !== input) closeCommandMenu();
        });
        renderModelOptions();
        form?.addEventListener('paste', async (event) => {
            const files = Array.from(event.clipboardData?.items || [])
                .map((item) => item.kind === 'file' ? item.getAsFile?.() : null)
                .filter(Boolean);
            if (files.some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                insertPastedText(event.clipboardData?.getData?.('text/plain') || '');
                await addReferenceFiles(files);
            }
        });
        form?.addEventListener('dragover', (event) => {
            if (Array.from(event.dataTransfer?.files || []).some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                form.classList.add('is-dragging-reference');
            }
        });
        form?.addEventListener('dragleave', () => form.classList.remove('is-dragging-reference'));
        form?.addEventListener('drop', async (event) => {
            form.classList.remove('is-dragging-reference');
            const files = Array.from(event.dataTransfer?.files || []);
            if (files.some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                await addReferenceFiles(files);
            }
        });
        setOpen(false);
        modelMenus = createPromptAgentModelMenus({ documentRef, selects: [modelSelect, getElements().imageModelSelect] });
        bindPromptAgentCanvasDismiss({ documentRef, close });
        const { panel } = getElements();
        ensurePanelWidth();
        resizeObserver = resizeObserverFactory?.(() => {
            updateScrollBottomButton();
        }) || null;
        if (panel) resizeObserver?.observe?.(panel);
        if (messages) resizeObserverFactory?.(updateScrollBottomButton)?.observe?.(messages);
        initialized = true;
    }

    function renderConversation() {
        const { messages } = getElements();
        if (!messages) return;
        promptPlanActionStates.clear();
        runViews.clear();
        clearElement(messages);
        const snapshot = conversationStore.snapshot();
        const transcript = [...(snapshot.archivedMessages || []), ...snapshot.messages];
        if (transcript.length === 0) {
            const empty = documentRef.createElement('p');
            empty.className = 'prompt-agent-empty';
            empty.textContent = '描述你想生成的画面。确认方案后点击生成，自动创建生图节点。';
            messages.appendChild(empty);
            updateScrollBottomButton();
            return;
        }
        transcript.forEach((item, index) => {
            const message = appendMessage(item.role, item.text, item.workSummary || [], {
                record: false,
                referenceImages: item.referenceImages || []
            });
            if (message) message.promptAgentMessageIndex = index;
            if (item.role === 'agent' && item.promptPlan) {
                const actionState = appendPromptPlan(message, item.promptPlan, item.runs || []);
                for (const run of item.runs || []) {
                    const element = documentRef.createElement('section');
                    element.className = 'prompt-agent-run-state';
                    message.appendChild(element);
                    const view = { element, workflowId: getWorkflowId(), revision: workflowRevision, plan: item.promptPlan, actionState };
                    runViews.set(run.runId, view);
                    renderRunView(view, run);
                }
            }
        });
        scrollToLatest();
    }

    function restoreWorkflow(value) {
        cancelRequest({ silent: true });
        workflowRevision += 1;
        pendingReferenceImages = [];
        referencePickerError = '';
        setCommandStatus();
        conversationStore.restore(value);
        for (const message of [...(value?.archivedMessages || []), ...(value?.messages || [])]) {
            for (const run of message.runs || []) {
                if (['running', 'pending'].includes(run.status) && !activeRuns.has(runKey(getWorkflowId(), run.runId))) {
                    conversationStore.finishRun(run.runId, { status: 'interrupted' });
                }
            }
        }
        renderImageModelOptions();
        ensurePanelWidth().migrate(value?.panelWidth);
        renderConversation();
        renderPendingReferences();
        close();
    }

    function snapshotWorkflow() {
        return conversationStore.snapshot();
    }

    function syncWorkflowState(value) {
        conversationStore.restore(value);
        conversationRevision += 1;
        refreshRunViews();
        refreshActionStates();
    }

    return {
        init, open, close, toggle, submit, cancelRequest,
        restoreWorkflow, snapshotWorkflow, syncWorkflowState, refreshActionStates, refreshModels: renderModelOptions
    };
}
