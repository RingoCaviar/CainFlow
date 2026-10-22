import { createPromptAgentConversationStore, getPromptAgentReferenceKey } from './prompt-agent-conversation-store.js';
import { measurePromptAgentContext } from './prompt-agent-token-budget.js';
import { stampResultCompletion } from './prompt-agent-result-order.js';
import { createPromptAgentPanelWidth } from './prompt-agent-panel-width.js';
import { createPromptAgentModelMenus } from './prompt-agent-model-menu.js';
import { bindPromptAgentCanvasDismiss } from './prompt-agent-canvas-dismiss.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { createAgentSearchMenu, renderAgentSearch } from './prompt-agent-search-ui.js';
import { AGENT_RESULT_DRAG_TYPE, beginAgentResultDrag, takeAgentResultDrag, endAgentResultDrag } from './prompt-agent-result-drag.js';
import { renderCanvasPlan, attachCanvasMentions } from './prompt-agent-canvas-ui.js';
import { promptPlanToCanvas } from './prompt-agent-canvas-plan.js';

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
    canvasAdapter = null,
    documentRef = document,
    createReply = async (request) => buildDefaultReply(request),
    createCompaction = async () => { throw new Error('上下文压缩服务尚未配置。'); },
    captureRequestConfig = () => null,
    readWebImage = async () => { throw new Error('网络图片服务未配置。'); },
    nodeAdapter = null,
    executionAdapter = null,
    getChatModels = () => [],
    getSearchModels = getChatModels,
    getProviders = () => [],
    panelManager = null,
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
    referenceSource = null,
    resizeObserverFactory = (callback) => typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null
} = {}) {
    const surfaces = getSurfaceCoordinator(documentRef);
    let canvasMentions = null;
    const canvasViews = new Set();
    let initialized = false;
    let modelMenus = null;
    let searchMenu = null;
    let searchViewRevision = 0;
    let searchViewCleanups = [];
    let panelWidthController = null;
    let resizeObserver = null;
    let scrollToLatestOnOpen = false;
    let workflowRevision = 0;
    let conversationRevision = 0;
    let tokenObservation = null;
    let activeOperation = null;
    let requestPending = false;
    let commandMenuOpen = false;
    let commandMatches = [];
    let commandIndex = 0;
    let pendingReferenceImages = [];
    let referencePickerOpen = false;
    let referencePickerError = '';
    let referenceTab = 'scene';
    let referenceQuery = '';
    let referenceLimit = 60;
    let historyReferences = [];
    let historyLoading = false;
    let historyError = '';
    let historyLoadToken = 0;
    let importQueue = Promise.resolve();
    let importSlot = 0;
    let thumbnailObservers = [];
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
        searchMenu?.render();
        renderImageModelOptions();
        const { input, modelSelect, modelHint, sendButton } = getElements();
        const models = getChatModels().filter((model) => model?.id && model?.modelId);
        if (modelHint) modelHint.hidden = models.length > 0;
        // Local commands remain available without a model and during requests.
        if (sendButton) sendButton.disabled = !input?.value?.trim().startsWith('/')
            && (requestPending || models.length === 0 || pendingReferenceImages.some((image) => image.loading || image.error));
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
        canvasViews.forEach(view => view.sync());
    }

    function setCommandStatus(text = '') {
        const { commandStatus } = getElements();
        if (!commandStatus) return;
        commandStatus.textContent = text;
        commandStatus.hidden = !text;
    }

    function closeCommandMenu() {
        surfaces?.forgetPopover('agent-command');
        commandMenuOpen = false;
        const { commandMenu, input } = getElements();
        if (commandMenu) commandMenu.hidden = true;
        input?.setAttribute('aria-expanded', 'false');
        input?.removeAttribute('aria-activedescendant');
    }

    function compressionProgress(message = '', fixedModel = null) {
        const models = getChatModels();
        const model = fixedModel || models.find(item => item.id === (getElements().modelSelect?.value || getSelectedModelId())) || models[0];
        const conversation = conversationStore.getCompactionContext();
        const previous = conversation.messages.findLast(item => item.promptPlan)?.promptPlan || conversation.previousPromptPlan;
        const measurement = measurePromptAgentContext({ model, message, conversation,
            canvasContext: canvasAdapter?.context(canvasMentions?.read().map(item => item.id) || []) || null,
            searchAllowed: conversationStore.getSearchSettings().mode !== 'off',
            context: nodeAdapter?.getSelectedContext?.() || (previous?.targetNodeId ? nodeAdapter?.getContext?.(previous.targetNodeId) : null),
            referenceImages: pendingReferenceImages.filter(image => !image.loading && !image.error),
            workflowReferenceImages: uniqueReferenceImages([
                ...conversationStore.getReferenceImages(),
                ...(referenceSource?.getContextReferences?.(conversation) || [])
            ])
        }, tokenObservation);
        // An empty conversation has no accumulated context. Keep the full
        // request estimate for execution, but do not present system instructions
        // and ambient canvas candidates as uncleared conversation history.
        const emptyConversation = !conversation.messages.length && !conversation.archivedMessages?.length
            && !conversation.memory && !conversation.contextSummary && !conversation.previousPromptPlan
            && !conversationStore.getReferenceImages().length && !pendingReferenceImages.length && !message.trim();
        return { ...measurement, emptyConversation };
    }

    async function autoCompact(operation, modelId, message = '') {
        if (!compressionProgress(message, operation.model).reached) return true;
        const conversation = conversationStore.getCompactionContext();
        if (!conversation.messages.length && !conversation.memory) return true;
        const revision = conversationRevision;
        operation.kind = 'compact';
        setCommandStatus('已达到 Token 阈值，正在自动压缩上下文…');
        try {
            const result = await createCompaction({ conversation, modelId, config: operation.config, signal: operation.controller.signal });
            if (!isCurrentOperation(operation)) return false;
            if (revision !== conversationRevision) throw new Error('压缩期间对话已更新，请重试');
            conversationStore.compact(result?.summary);
            tokenObservation = null;
            conversationRevision += 1;
            onStateChange();
            if (commandMenuOpen) renderCommandMenu();
            setCommandStatus(compressionProgress(message, operation.model).reached
                ? '已自动压缩；保留的方案或素材仍超过阈值，不会继续循环压缩或截断。'
                : '已自动压缩上下文，历史记录、参考图和最新方案已保留。');
            return true;
        } catch (error) {
            if (isCurrentOperation(operation)) setCommandStatus(`自动压缩失败：${error?.message || '请重试'}。原上下文已保留，请重试发送或使用 /compact。`);
            return false;
        } finally {
            operation.kind = 'reply';
        }
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
            if (command.name === '/compact') {
                const usage = compressionProgress();
                const displayedPercent = usage.emptyConversation ? 0 : usage.percent;
                const meter = documentRef.createElement('span');
                meter.className = 'prompt-agent-context-usage';
                meter.style.setProperty('--context-usage', `${displayedPercent}%`);
                meter.setAttribute('role', 'meter');
                meter.setAttribute('aria-label', '自动压缩阈值进度');
                meter.setAttribute('aria-valuemin', '0');
                meter.setAttribute('aria-valuemax', '100');
                meter.setAttribute('aria-valuenow', String(displayedPercent));
                const detail = usage.emptyConversation
                    ? `暂无对话上下文。下次请求的系统指令和画布候选预计占用约 ${usage.used} / ${usage.threshold} Token，并非残留聊天；发送时按完整请求检查自动压缩阈值。`
                    : `自动压缩阈值进度：约 ${usage.used} / ${usage.threshold} Token（含系统指令及画布候选）；${usage.source}。发送前及回复后达到阈值时调用模型压缩，与圆环共用计数。`;
                meter.setAttribute('aria-valuetext', `${displayedPercent}%，${detail}`);
                meter.title = detail;
                const value = documentRef.createElement('span');
                value.textContent = usage.emptyConversation ? '0%' : `≈${displayedPercent}%`;
                meter.appendChild(value);
                option.appendChild(meter);
                option.classList.add('has-context-usage');
            }
            option.addEventListener('click', () => executeCommand(command.name));
            commandMenu.appendChild(option);
        });
        commandMenuOpen = true;
        commandMenu.hidden = false;
        surfaces?.openPopover('agent-command', { element: commandMenu, trigger: input, close: closeCommandMenu });
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
        else { setCommandStatus(); appendMessage('agent', '已取消本次 Agent 请求。'); }
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
            importQueue = Promise.resolve();
            const clearedRevision = workflowRevision;
            canvasMentions?.clear(); canvasViews.forEach(view => view.destroy()); canvasViews.clear();
            conversationStore.clear();
            tokenObservation = null;
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
        operation.config = captureRequestConfig(modelId);
        const revision = conversationRevision;
        setCommandStatus('正在压缩上下文，整理目标、约束与最新方案…');
        try {
            const result = await createCompaction({ conversation, modelId, config: operation.config, signal: operation.controller.signal });
            if (!isCurrentOperation(operation)) return;
            if (revision !== conversationRevision) throw new Error('压缩期间对话已更新，请重新压缩');
            conversationStore.compact(result?.summary);
            tokenObservation = null;
            // Keep the transcript and any running generation cards in place.
            onStateChange();
            if (commandMenuOpen) renderCommandMenu();
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
            if (reference.sourceNodeId) item.dataset.sourceNodeId = reference.sourceNodeId;
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
            if (reference.error && reference.retry) {
                const retry = documentRef.createElement('button');
                retry.type = 'button'; retry.textContent = '重试'; retry.title = reference.error;
                retry.addEventListener('click', reference.retry);
                item.appendChild(retry);
            }
            if (removable) {
                const removeButton = documentRef.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'prompt-agent-reference-remove';
                removeButton.textContent = '×';
                removeButton.setAttribute('aria-label', `移除 ${image.alt}`);
                removeButton.addEventListener('click', () => {
                    const currentIndex = pendingReferenceImages.indexOf(reference);
                    if (currentIndex >= 0) pendingReferenceImages.splice(currentIndex, 1);
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
        thumbnailObservers.forEach(observer => observer.disconnect()); thumbnailObservers = [];
        const focusedId = documentRef.activeElement?.getAttribute?.('data-reference-id');
        clearElement(referencePickerList);
        const allCandidates = referenceTab === 'history' ? historyReferences : (nodeAdapter?.getSceneReferenceImages?.() || []);
        const filtered = allCandidates.filter(item => `${item.name} ${item.prompt || ''}`.toLowerCase().includes(referenceQuery.toLowerCase()));
        const candidates = filtered.slice(0, referenceLimit);
        const selected = documentRef.getElementById('prompt-agent-picker-selected');
        if (selected) { clearElement(selected); appendReferencePreviews(selected, pendingReferenceImages, { removable: true }); }
        const more = documentRef.getElementById('prompt-agent-reference-more');
        if (more) more.hidden = filtered.length <= referenceLimit;
        for (const tab of ['scene', 'history']) documentRef.getElementById(`prompt-agent-tab-${tab}`)?.setAttribute('aria-selected', String(referenceTab === tab));
        if (referencePickerStatus) referencePickerStatus.textContent = referenceTab === 'history' && (historyLoading || historyError)
            ? (historyLoading ? '正在加载历史图片…' : historyError)
            : candidates.length
            ? `${filtered.length} 张图片${filtered.length > candidates.length ? ` · 显示前 ${candidates.length} 张` : ''} · 已选 ${pendingReferenceImages.length} 张，按勾选顺序编号`
            : (referenceTab === 'history' ? (historyLoading ? '正在加载历史图片…' : historyError || '没有匹配的历史图片。') : '当前场景还没有匹配的图片导入节点。');
        candidates.forEach((candidate) => {
            const candidateKey = candidate.historyId ? referenceSource?.getReferenceId?.(candidate) || candidate.referenceId : getPromptAgentReferenceKey(candidate);
            const index = pendingReferenceImages.findIndex((item) => item.selectionKey === candidate.referenceId || getPromptAgentReferenceKey(item) === candidateKey);
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
            if (candidate.previewUrl || candidate.thumbAssetKey) {
                const image = documentRef.createElement('img');
                if (candidate.previewUrl) image.src = candidate.previewUrl;
                else {
                    const load = async () => {
                        try { const src = await referenceSource.loadThumbnail(candidate); if (image.isConnected && src) image.src = src; }
                        catch { image.alt = '缩略图不可用'; }
                    };
                    const Observer = documentRef.defaultView?.IntersectionObserver;
                    if (Observer) {
                        const observer = new Observer(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); } });
                        observer.observe(image);
                        thumbnailObservers.push(observer);
                    } else void load();
                }
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
            button.addEventListener('click', () => candidate.historyId ? toggleImportedReference(candidate) : toggleSceneReference(candidate));
            const preview = documentRef.createElement('button');
            preview.type = 'button'; preview.className = 'prompt-agent-reference-preview'; preview.textContent = '预览';
            preview.setAttribute('aria-label', `预览 ${candidate.name}`);
            preview.addEventListener('click', async () => {
                const revision = workflowRevision;
                try {
                    const image = candidate.historyId ? await referenceSource.readHistory(candidate) : await nodeAdapter.readSceneReferenceImage(candidate);
                    if (revision === workflowRevision && image?.dataUrl) openResultPreview([image.dataUrl], 0);
                } catch (error) { if (revision === workflowRevision) { referencePickerError = error.message; renderPendingReferences(); } }
            });
            const cell = documentRef.createElement('div'); cell.className = 'prompt-agent-reference-cell';
            referencePickerList.appendChild(cell); cell.appendChild(button); cell.appendChild(preview);
            if (candidate.referenceId === focusedId) button.focus?.();
        });
        const { panel, form, referencePicker } = getElements();
        if (referencePicker?.style && panel?.getBoundingClientRect && form?.getBoundingClientRect) {
            referencePicker.style.maxHeight = `${Math.max(80, form.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12)}px`;
        }
    }

    function setReferencePickerOpen(open, focusTrigger = false) {
        if (open) closeCommandMenu();
        referencePickerOpen = open;
        if (!open) { thumbnailObservers.forEach(observer => observer.disconnect()); thumbnailObservers = []; }
        const { referencePicker, addReferenceButton, referencePickerList } = getElements();
        if (referencePicker) referencePicker.hidden = !open;
        if (open && referencePicker) surfaces?.openPopover('agent-reference', { element: referencePicker, trigger: addReferenceButton, close: () => setReferencePickerOpen(false) });
        else surfaces?.forgetPopover('agent-reference');
        addReferenceButton?.setAttribute('aria-expanded', String(open));
        if (open) {
            modelMenus?.close();
            renderReferencePicker();
            if (referenceTab === 'history') void loadHistoryReferences();
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

    async function loadHistoryReferences() {
        const revision = workflowRevision;
        const token = ++historyLoadToken;
        historyLoading = true; historyError = ''; renderReferencePicker();
        try {
            const items = await referenceSource?.listHistory();
            if (revision === workflowRevision && token === historyLoadToken) historyReferences = items || [];
        } catch (error) {
            if (revision === workflowRevision && token === historyLoadToken) historyError = `历史加载失败：${error.message}，请点击刷新重试。`;
        } finally {
            if (revision === workflowRevision && token === historyLoadToken) { historyLoading = false; renderReferencePicker(); }
        }
    }

    function toggleImportedReference(candidate, { toggle = true } = {}) {
        const key = referenceSource?.getReferenceId?.(candidate) || candidate.referenceId;
        const existing = pendingReferenceImages.findIndex(item => item.selectionKey === candidate.referenceId || item.referenceId === key);
        if (existing >= 0) { if (toggle) { pendingReferenceImages.splice(existing, 1); renderPendingReferences(); } return Promise.resolve(); }
        const pending = { name: candidate.name, referenceId: candidate.referenceId, selectionKey: candidate.referenceId, previewUrl: candidate.previewUrl, loading: true };
        const revision = workflowRevision;
        const slot = importSlot++;
        const isCurrent = () => revision === workflowRevision && pendingReferenceImages.includes(pending);
        const run = () => {
            if (!isCurrent()) return Promise.resolve();
            referencePickerError = '';
            pending.loading = true; delete pending.error; renderPendingReferences();
            const operation = importQueue.catch(() => {}).then(async () => {
                if (!isCurrent()) return;
                try {
                    const image = await referenceSource.importReference(candidate, { isCurrent, slot, read: () => readReferenceFile(candidate.file),
                        onSourceNode: (id) => { pending.sourceNodeId = id; }
                    });
                    if (!isCurrent()) return;
                    if (!image?.dataUrl) throw new Error('图片导入失败，请重试。');
                    Object.assign(pending, image);
                    delete pending.loading; delete pending.error;
                } catch (error) {
                    if (!isCurrent()) return;
                    delete pending.loading; pending.error = error.message;
                    referencePickerError = `${pending.name}：${error.message}`;
                }
                if (isCurrent()) renderPendingReferences();
            });
            importQueue = operation;
            return operation;
        };
        pending.retry = run;
        pendingReferenceImages.push(pending);
        return run();
    }

    async function addReferenceFiles(files = []) {
        const imageFiles = Array.from(files).filter((file) => String(file?.type || '').startsWith('image/'));
        if (imageFiles.length === 0) return false;
        if (referenceSource) {
            const operations = imageFiles.map(file => toggleImportedReference({ referenceId: `file:${globalThis.crypto?.randomUUID?.() || Math.random()}`, name: file.name || '粘贴图片', file }));
            await Promise.all(operations);
            return true;
        }
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
            searchMenu?.close();
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
        panelManager?.beforeOpen?.('agent');
        // Model settings can finish loading after the controller is initialized.
        // Refresh here so the first request always sees the current chat models.
        renderModelOptions();
        setOpen(true);
        if (documentRef.activeElement === getElements().button) getElements().input?.focus?.();
        panelWidthController?.apply();
        if (scrollToLatestOnOpen) scrollToLatest();
        updateScrollBottomButton();
    }
    function close() { canvasMentions?.close(); canvasViews.forEach(view => view.close()); setOpen(false); }
    function toggle() {
        const { panel } = getElements();
        if (panel?.classList.contains('active')) close();
        else open();
    }

    function appendMessage(role, text, workSummary = [], { record = true, promptPlan = null, canvasPlan = null, nodeMentions = [], referenceImages = [], intent, search } = {}) {
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
        if (search) {
            const revision = workflowRevision, viewRevision = searchViewRevision;
            const isCurrent = () => revision === workflowRevision && viewRevision === searchViewRevision;
            isCurrent.onCleanup = cleanup => searchViewCleanups.push(cleanup);
            renderAgentSearch({ documentRef, container: message, body, text, search, isCurrent, readImage: readWebImage,
                preview: openResultPreview, importImage: image => toggleImportedReference({
                    referenceId: `web:${image.imageUrl}`, historyId: `web:${image.imageUrl}`, name: image.title,
                    webImage: image
                }, { toggle: false }) });
        }
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
            message.promptAgentMessageIndex = conversationStore.append({ role, text, workSummary, promptPlan, canvasPlan, nodeMentions, referenceImages, intent, search });
            conversationRevision += 1;
            onStateChange();
            if (commandMenuOpen) renderCommandMenu();
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
            removeNodeReferences(removed) {
                if (!Array.isArray(plan.referenceImages)) return;
                const next = plan.referenceImages.filter((image) => !removed.has(image.sourceNodeId));
                if (next.length === plan.referenceImages.length) return;
                plan.referenceImages = next;
                planElement.textContent = formatPlan(plan);
                this.appliedModelId = '';
                this.sync();
            },
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

    function removeNodeReferences(nodeIds) {
        const removed = new Set(nodeIds);
        if (activeOperation) {
            activeOperation.removedReferenceNodeIds ||= new Set();
            nodeIds.forEach((id) => activeOperation.removedReferenceNodeIds.add(id));
        }
        pendingReferenceImages = pendingReferenceImages.filter((image) => !removed.has(image.sourceNodeId));
        referencePickerError = '';
        const changed = conversationStore.removeNodeReferences(nodeIds);
        for (const actionState of promptPlanActionStates) actionState.removeNodeReferences(removed);
        // Update only reference strips, retaining running result views and scroll position.
        const { messages } = getElements();
        messages?.querySelectorAll('.prompt-agent-message-references').forEach((strip) => {
            strip.querySelectorAll('.prompt-agent-reference').forEach((item) => {
                if (removed.has(item.dataset.sourceNodeId)) item.remove();
            });
            strip.querySelectorAll('.prompt-agent-reference-number').forEach((number, index) => { number.textContent = String(index + 1); });
            if (!strip.children.length) strip.remove();
        });
        renderPendingReferences();
        if (changed) {
            conversationRevision += 1;
            onStateChange();
        }
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
                if (update(run) === false) return false;
                stampResultCompletion(snapshot, run);
                return snapshot;
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
            // Capture completion before asynchronous ownership/save work. Retrying
            // persistence must never make an older batch appear newer.
            mutateRun(workflowId, runId, run => { run.status = 'completed'; }, revision);
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
            image.draggable = /^data:image\/[^;]+;base64,/i.test(source);
            image.title = '点击预览，或拖到 Agent / 画布作为参考图';
            let dragged = false;
            let dragToken;
            const revision = workflowRevision;
            image.addEventListener('pointerdown', () => { dragged = false; });
            image.addEventListener('dragstart', (event) => {
                dragToken = beginAgentResultDrag(event.dataTransfer, {
                    dataUrl: source, name: `生成结果 ${index + 1}`,
                    isCurrent: () => revision === workflowRevision && image.isConnected
                });
                if (!dragToken) { event.preventDefault(); return; }
                dragged = true;
                event.stopPropagation?.();
            });
            image.addEventListener('dragend', () => endAgentResultDrag(dragToken));
            const preview = () => openResultPreview(images.filter(Boolean), images.slice(0, index).filter(Boolean).length);
            image.addEventListener('click', () => { if (!dragged) preview(); });
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
        } else if (run.status === 'failed' && view.canvasPlan) {
            clearElement(element); element.textContent = `步骤失败：${run.error || '请使用方案中的重试按钮'}`;
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

    function appendCanvasPlan(message, plan, runs = []) {
        if (!canvasAdapter || !message) return;
        const revision = workflowRevision, workflowId = getWorkflowId();
        const isCurrent = () => revision === workflowRevision && getWorkflowId() === workflowId && message.isConnected !== false
            && [...(conversationStore.snapshot().archivedMessages || []), ...conversationStore.snapshot().messages].some(item => item.canvasPlan?.id === plan.id);
        const changed = () => {
            if (isCurrent()) { if (conversationStore.updateCanvasPlan(plan.id, plan)) onStateChange(); }
            else mutateWorkflowConversation?.(workflowId, snapshot => {
                const message = [...(snapshot.archivedMessages || []), ...(snapshot.messages || [])].find(item => item.canvasPlan?.id === plan.id);
                if (!message) return false;
                message.canvasPlan = JSON.parse(JSON.stringify(plan)); return snapshot;
            });
        };
        const addRunView = run => {
            const element = documentRef.createElement('section'); element.className = 'prompt-agent-run-state'; message.appendChild(element);
            const view = { element, workflowId, revision, canvasPlan: plan, plan: { targetNodeId: run.targetNodeId } };
            runViews.set(run.runId, view); renderRunView(view, run);
        };
        const view = renderCanvasPlan({ documentRef, parent: message, plan, adapter: canvasAdapter, getModels: getImageModels,
            getModelId: () => conversationStore.getImageModelId(), changed, isCurrent,
            run: async (plan, retry) => {
                if (!retry) plan.completedSteps = [];
                const attempt = { id: createRunId(), status: 'running', steps: [] };
                const resultRuns = new Map();
                for (const step of plan.steps.filter(step => step.execute !== false && (!retry || !plan.completedSteps?.includes(step.id)))) {
                    attempt.steps.push({ id: step.id, status: 'pending', ...canvasAdapter.executionRecord(plan, step.id) });
                    if (!['ImageGenerate', 'ImageResize', 'ImageMerge', 'ImageCompare'].includes(step.type)) continue;
                    const record = { runId: createRunId(), targetNodeId: plan.bindings[step.id], status: 'running', mediaAssetKeys: [] };
                    if (!conversationStore.beginRun(message.promptAgentMessageIndex, record)) throw new Error('会话已变化');
                    resultRuns.set(record.targetNodeId, record); activeRuns.set(runKey(workflowId, record.runId), true); addRunView(record);
                }
                plan.runs.push(attempt); changed();
                try {
                    const completion = await canvasAdapter.execute(plan, { retry, retainResults: async result => {
                        for (const entry of result.nodeResults || []) {
                            const record = resultRuns.get(entry.nodeId);
                            if (record && !entry.error && (entry.images?.length || entry.mediaAssetKeys?.length)) await persistRun(workflowId, record.runId, entry, revision);
                        }
                        return result;
                    } });
                    plan.completedSteps ||= [];
                    for (const step of attempt.steps) {
                        const entry = completion?.nodeResults?.find(item => item.nodeId === plan.bindings[step.id]);
                        step.status = entry?.succeeded ? 'completed' : entry?.error ? 'failed' : 'interrupted';
                        if (step.status === 'completed' && !plan.completedSteps.includes(step.id)) plan.completedSteps.push(step.id);
                        const record = resultRuns.get(plan.bindings[step.id]);
                        if (record && !readRun(workflowId, record.runId, revision)?.mediaAssetKeys?.length) mutateRun(workflowId, record.runId, run => Object.assign(run, { status: entry?.error ? 'failed' : 'stopped', error: entry?.error || '' }), revision);
                    }
                    attempt.status = completion?.outcome === 'completed' ? 'completed' : 'failed';
                    if (attempt.status === 'failed') throw new Error(completion?.error || '部分步骤未完成，已保留成功结果，可重试未完成步骤');
                } catch (error) {
                    attempt.status = 'failed';
                    for (const record of resultRuns.values()) mutateRun(workflowId, record.runId, run => {
                        if (run.status !== 'running') return false; Object.assign(run, { status: 'failed', error: error.message });
                    }, revision);
                    throw error;
                } finally {
                    for (const record of resultRuns.values()) activeRuns.delete(runKey(workflowId, record.runId));
                    changed(); if (isCurrent()) refreshRunViews();
                }
            }
        });
        canvasViews.add(view); runs.forEach(addRunView);
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
        if (requestPending || models.length === 0 || pendingReferenceImages.some((image) => image.loading || image.error)) return;
        if (!text && pendingReferenceImages.length === 0) return;
        const stagedReferences = pendingReferenceImages.slice();
        const operation = beginOperation('reply');
        const replyModelId = getElements().modelSelect?.value || getSelectedModelId() || models[0].id;
        operation.model = { ...models.find(model => model.id === replyModelId) };
        operation.config = captureRequestConfig(replyModelId);
        operation.searchSettings = conversationStore.getSearchSettings();
        let completedSearch = null;
        try {
            if (compressionProgress(text, operation.model).reached && !await autoCompact(operation, replyModelId, text)) return;
            if (!isCurrentOperation(operation)) return;
            const referenceImages = stagedReferences.filter(image => pendingReferenceImages.includes(image));
            if (!text && !referenceImages.length) return;
            const workflowMemory = conversationStore.getContext();
            // Snapshot before appending the current turn: preserve assistant drafts
            // and role boundaries without duplicating the new user request.
            const conversation = conversationStore.getCompactionContext();
            let workflowReferenceImages = uniqueReferenceImages([
                ...conversationStore.getReferenceImages(),
                ...referenceImages,
                ...(referenceSource?.getContextReferences?.(conversation) || [])
            ]);
            if (referenceSource?.hydrateLatestResults) {
                const readRevision = conversationRevision;
                workflowReferenceImages = await referenceSource.hydrateLatestResults(workflowReferenceImages, {
                    isCurrent: () => isCurrentOperation(operation) && conversationRevision === readRevision
                });
                if (!isCurrentOperation(operation)) return;
                if (!workflowReferenceImages) throw new Error('读取图片期间对话已更新，请重试。');
            }
            const nodeMentions = canvasMentions?.read() || [];
            const canvasContext = canvasAdapter?.context(nodeMentions.map(item => item.id)) || null;
            appendMessage('user', text || `添加了 ${referenceImages.length} 张参考图`, [], { referenceImages, nodeMentions });
            if (input.value.trim() === text) input.value = '';
            pendingReferenceImages = pendingReferenceImages.filter(image => !stagedReferences.includes(image));
            referencePickerError = '';
            setReferencePickerOpen(false);
            closeCommandMenu();
            setCommandStatus();
            renderPendingReferences();
            const previousPlan = conversation.messages.findLast((message) => message.promptPlan)?.promptPlan
                || conversation.previousPromptPlan;
            const context = nodeAdapter?.getSelectedContext?.()
                || (previousPlan?.targetNodeId ? nodeAdapter?.getContext?.(previousPlan.targetNodeId) : null)
                || null;
            const reply = await createReply({
                canvasContext,
                message: text,
                context,
                workflowMemory,
                conversation,
                referenceImages,
                workflowReferenceImages,
                modelId: replyModelId,
                config: operation.config,
                searchSettings: operation.searchSettings,
                onSearchStatus: status => { if (isCurrentOperation(operation)) setCommandStatus(status); },
                signal: operation.controller.signal
            });
            if (!isCurrentOperation(operation)) return;
            completedSearch = reply?.search || null;
            if (canvasAdapter && reply?.promptPlan && !reply.canvasPlan) {
                const target = canvasContext.nodes.find(node => node.id === reply.promptPlan.targetNodeId);
                const explicitlyNamed = target && (nodeMentions.some(item => item.id === target.id) || (text.includes(target.name) && canvasContext.nodes.filter(node => node.name === target.name).length === 1));
                reply.canvasPlan = promptPlanToCanvas({ ...reply.promptPlan, targetNodeId: explicitlyNamed ? reply.promptPlan.targetNodeId : null }, canvasContext);
                reply.promptPlan = null;
            }
            if (Array.isArray(reply?.promptPlan?.referenceImages)) {
                const selected = reply.promptPlan.referenceImages;
                const preparingNodes = new Set(selected.map(image => image.sourceNodeId).filter(Boolean));
                const sourcesExist = () => isCurrentOperation(operation)
                    && ![...preparingNodes].some(id => operation.removedReferenceNodeIds?.has(id));
                if (!sourcesExist()) throw new Error('所选参考图已删除，请重新提出方案。');
                if (referenceSource?.preparePlanReferences) {
                    const prepared = await referenceSource.preparePlanReferences(reply.promptPlan, {
                        isCurrent: sourcesExist,
                        onSourceNode: id => preparingNodes.add(id)
                    });
                    if (!isCurrentOperation(operation)) return;
                    if (!prepared) throw new Error('参考图已变化，请重新提出方案。');
                    reply.promptPlan.referenceImages = prepared;
                }
            }
            tokenObservation = reply?.tokenObservation || null;
            if (reply?.canvasPlan) canvasAdapter.prepare(reply.canvasPlan);
            const agentMessage = appendMessage('agent', reply?.message || '已整理本轮回复。', reply?.workSummary || [], {
                promptPlan: reply?.promptPlan || null, canvasPlan: reply?.canvasPlan, intent: reply?.intent, search: reply?.search
            });
            if (reply?.canvasPlan) appendCanvasPlan(agentMessage, reply.canvasPlan);
            appendPromptPlan(agentMessage, reply?.promptPlan);
            setCommandStatus();
            await autoCompact(operation, replyModelId);

        } catch (error) {
            if (!isCurrentOperation(operation)) return;
            setCommandStatus();
            appendMessage('agent', error?.message || 'Agent 暂时无法回复，请稍后重试。', [], { search: completedSearch });
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
        panelManager?.register?.('agent', { close });
        const { messages, scrollBottomButton } = getElements();
        messages?.addEventListener('scroll', updateScrollBottomButton, { passive: true });
        messages?.addEventListener('load', updateScrollBottomButton, true);
        scrollBottomButton?.addEventListener('click', scrollToLatest);
        const MutationObserverClass = documentRef.defaultView?.MutationObserver;
        if (messages && MutationObserverClass) {
            new MutationObserverClass(updateScrollBottomButton).observe(messages, { childList: true, subtree: true, characterData: true });
        }
        const { button, closeButton, form, input, modelSelect, addModelButton, cancelButton, addReferenceButton, referencePickerClose } = getElements();
        if (input && canvasAdapter) canvasMentions = attachCanvasMentions({ documentRef, input, adapter: canvasAdapter });
        button?.addEventListener('click', toggle);
        closeButton?.addEventListener('click', close);
        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submit();
        });
        modelSelect?.addEventListener('change', () => {
            setSelectedModelId(modelSelect.value);
            if (commandMenuOpen) renderCommandMenu();
        });
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
            if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return; }
            if (commandMenuOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation?.();
                if (event.key === 'Escape') closeCommandMenu();
                else if (event.key === 'Enter') await executeCommand(commandMatches[commandIndex].name);
                else {
                    commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) % commandMatches.length;
                    renderCommandMenu();
                }
            } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation?.();
                await submit();
            }
        });
        cancelButton?.addEventListener('click', () => cancelRequest());
        addReferenceButton?.addEventListener('click', () => setReferencePickerOpen(!referencePickerOpen));
        for (const tab of ['scene', 'history']) documentRef.getElementById(`prompt-agent-tab-${tab}`)?.addEventListener('click', () => {
            referenceTab = tab; referenceLimit = 60; renderReferencePicker();
            if (tab === 'history') void loadHistoryReferences();
        });
        for (const tab of ['scene', 'history']) documentRef.getElementById(`prompt-agent-tab-${tab}`)?.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const target = documentRef.getElementById(`prompt-agent-tab-${tab === 'scene' ? 'history' : 'scene'}`);
            target?.click(); target?.focus();
        });
        documentRef.getElementById('prompt-agent-reference-search')?.addEventListener('input', event => { referenceQuery = event.target.value; referenceLimit = 60; renderReferencePicker(); });
        documentRef.getElementById('prompt-agent-reference-more')?.addEventListener('click', () => { referenceLimit += 60; renderReferencePicker(); });
        documentRef.getElementById('prompt-agent-reference-refresh')?.addEventListener('click', () => referenceTab === 'history' ? loadHistoryReferences() : renderReferencePicker());
        documentRef.getElementById('prompt-agent-reference-clear')?.addEventListener('click', () => { pendingReferenceImages = []; referencePickerError = ''; renderPendingReferences(); });
        const upload = documentRef.getElementById('prompt-agent-reference-upload');
        documentRef.getElementById('prompt-agent-reference-upload-button')?.addEventListener('click', () => upload?.click());
        upload?.addEventListener('change', async () => { const files = [...upload.files]; upload.value = ''; await addReferenceFiles(files); });
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
            if (event.target?.closest?.('.fullscreen-overlay')) return;
            const { referencePicker, addReferenceButton, commandMenu, input } = getElements();
            if (referencePickerOpen && !referencePicker?.contains?.(event.target) && !addReferenceButton?.contains?.(event.target)) {
                setReferencePickerOpen(false);
            }
            if (commandMenuOpen && !commandMenu?.contains?.(event.target) && event.target !== input) closeCommandMenu();
        });
        renderModelOptions();
        const referenceDropZone = documentRef.defaultView ? getElements().panel : form;
        referenceDropZone?.addEventListener('paste', async (event) => {
            const itemFiles = Array.from(event.clipboardData?.items || [])
                .map((item) => item.kind === 'file' ? item.getAsFile?.() : null)
                .filter(Boolean);
            const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData?.files || []);
            if (files.some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                event.stopPropagation?.();
                insertPastedText(event.clipboardData?.getData?.('text/plain') || '');
                await addReferenceFiles(files);
            }
        });
        referenceDropZone?.addEventListener('dragover', (event) => {
            if (Array.from(event.dataTransfer?.types || []).some(type => ['Files', 'application/x-cainflow-history-image', AGENT_RESULT_DRAG_TYPE].includes(type)) || Array.from(event.dataTransfer?.files || []).some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                event.stopPropagation?.();
                form.classList.add('is-dragging-reference');
            }
        });
        referenceDropZone?.addEventListener('dragleave', () => form.classList.remove('is-dragging-reference'));
        referenceDropZone?.addEventListener('drop', async (event) => {
            form.classList.remove('is-dragging-reference');
            const files = Array.from(event.dataTransfer?.files || []);
            if (Array.from(event.dataTransfer?.types || []).includes(AGENT_RESULT_DRAG_TYPE)) {
                event.preventDefault(); event.stopPropagation?.();
                const image = takeAgentResultDrag(event.dataTransfer);
                if (!image || !referenceSource) {
                    referencePickerError = '生成图片拖拽已失效，请重新拖拽。';
                    renderPendingReferences();
                    return;
                }
                await toggleImportedReference({ referenceId: `result:${globalThis.crypto.randomUUID()}`, name: image.name, resolvedImage: image }, { toggle: false });
                return;
            }
            const historyId = event.dataTransfer?.getData?.('application/x-cainflow-history-image');
            if (historyId && referenceSource) {
                event.preventDefault(); event.stopPropagation?.();
                await toggleImportedReference({ referenceId: `history:${historyId}`, historyId, name: `历史图片 ${historyId}` }, { toggle: false });
                return;
            }
            if (files.some((file) => String(file.type || '').startsWith('image/'))) {
                event.preventDefault();
                event.stopPropagation?.();
                await addReferenceFiles(files);
            }
        });
        setOpen(false);
        searchMenu = createAgentSearchMenu({ documentRef, getModels: getSearchModels, getProviders,
            getCurrentModel: () => getChatModels().find(model => model.id === getElements().modelSelect?.value),
            configure: target => {
                const revision = workflowRevision;
                searchMenu.close();
                openModelSettings({ ...target, onClose: () => {
                    if (revision !== workflowRevision || !getElements().panel?.classList.contains('active')) return;
                    renderModelOptions(); searchMenu.open();
                } });
            },
            getSettings: conversationStore.getSearchSettings, setSettings: conversationStore.setSearchSettings,
            onChange: () => { tokenObservation = null; onStateChange(); }, closeModels: () => modelMenus?.close() });
        const searchModel = documentRef.getElementById('prompt-agent-search-model');
        searchModel?.addEventListener('focus', () => searchMenu.render());
        modelMenus = createPromptAgentModelMenus({ documentRef, selects: [modelSelect, getElements().imageModelSelect, searchModel] });
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
        canvasViews.forEach(view => view.destroy()); canvasViews.clear();
        searchViewRevision += 1;
        searchViewCleanups.forEach(cleanup => cleanup()); searchViewCleanups = [];
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
                search: item.search,
                referenceImages: item.referenceImages || []
            });
            if (message) message.promptAgentMessageIndex = index;
            if (item.canvasPlan) appendCanvasPlan(message, item.canvasPlan, item.runs || []);
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
        canvasMentions?.clear(); canvasViews.forEach(view => view.destroy()); canvasViews.clear();
        cancelRequest({ silent: true });
        workflowRevision += 1;
        importQueue = Promise.resolve();
        historyReferences = []; historyLoading = false; historyError = '';
        referenceTab = 'scene'; referenceQuery = ''; referenceLimit = 60;
        const search = documentRef.getElementById('prompt-agent-reference-search');
        if (search) search.value = '';
        pendingReferenceImages = [];
        referencePickerError = '';
        setCommandStatus();
        conversationStore.restore(value);
        tokenObservation = null;
        for (const message of [...(value?.archivedMessages || []), ...(value?.messages || [])]) {
            if (message.canvasPlan && !canvasAdapter?.isRunning(message.canvasPlan.id)) {
                const plan = JSON.parse(JSON.stringify(message.canvasPlan)); delete plan.historyId;
                for (const attempt of plan.runs || []) if (attempt.status === 'running') {
                    attempt.status = 'interrupted';
                    for (const step of attempt.steps || []) if (['pending', 'running'].includes(step.status)) step.status = 'interrupted';
                }
                conversationStore.updateCanvasPlan(plan.id, plan);
            }
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
        tokenObservation = null;
        conversationRevision += 1;
        refreshRunViews();
        refreshActionStates();
    }

    return {
        init, open, close, toggle, submit, cancelRequest, removeNodeReferences,
        restoreWorkflow, snapshotWorkflow, syncWorkflowState, refreshActionStates, refreshModels: renderModelOptions
    };
}
