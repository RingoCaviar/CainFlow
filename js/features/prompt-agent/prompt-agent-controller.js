import { bindTaskToReply, confirmTaskParameters, CreativeTaskConfirmationRequired, isCreativeTaskConfirmation } from './prompt-agent-task.js';
import { normalizePromptAgentChoices } from './prompt-agent-choices.js';
import { sizeCapabilities, replaceAgentSizeFields, resolveDraftImageSize, parseSizeAnswer } from './prompt-agent-size.js';
import { getPromptAgentCanvasImagePreview, imageParameterCapabilities, setAgentCanvasApplicationMode } from './prompt-agent-model.js';
import { mergeAgentSizeAnswer, resolveAgentParameterPatch } from './prompt-agent-parameters.js';
import { getEffectiveProtocol, getModelProviders } from '../execution/provider-request-utils.js';
import { getOpenAIChatCapabilities } from '../execution/openai-chat-capabilities.js';
import { createAgentSizeSettings } from './prompt-agent-size-ui.js';
import { createThinkingControl } from '../execution/thinking-control.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { createPromptAgentConversationStore, getPromptAgentReferenceKey } from './prompt-agent-conversation-store.js';
import { measurePromptAgentContext, countPromptText, fitPromptAgentContext } from './prompt-agent-token-budget.js';
import { stampResultCompletion } from './prompt-agent-result-order.js';
import { createPromptAgentResultPersistence } from './prompt-agent-result-persistence.js';
import { createPromptAgentPanelWidth } from './prompt-agent-panel-width.js';
import { createPromptAgentModelMenus, getAgentModelLabel } from './prompt-agent-model-menu.js';
import { bindPromptAgentCanvasDismiss } from './prompt-agent-canvas-dismiss.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { createAgentSearchMenu, renderAgentSearch } from './prompt-agent-search-ui.js';
import { AGENT_RESULT_DRAG_TYPE, beginAgentResultDrag, takeAgentResultDrag, endAgentResultDrag } from './prompt-agent-result-drag.js';
import { renderCanvasPlan, createCanvasMentions } from './prompt-agent-canvas-ui.js';
import { bindImageMentionPicker } from '../ui/image-mention-picker.js';
import { createSelectedReferenceClearReply, isSelectedReferenceClearRequest, promptPlanToCanvas } from './prompt-agent-canvas-plan.js';
import { createPromptAgentInput } from './prompt-agent-input.js';
import { renderAgentBody } from './prompt-agent-body.js';
import { createImageResultReferenceIdentity } from './prompt-agent-result-reference.js';
import { createUserMessageActions } from './prompt-agent-message-actions.js';
import { parseAgentAppRequest, runAgentAppRequest } from './prompt-agent-app-actions.js';
import { agentRequestFailureText, getAgentRequestFailure } from './prompt-agent-request.js';

const COMMANDS = [
    { name: '/clear', title: '清空上下文', description: '清除本场景的聊天、摘要、参考图和生成记录，重新开始。' },
    { name: '/compact', title: '压缩上下文', description: '用常规设置指定的模型整理摘要；未指定时跟随对话模型。' }
];

const IMAGE_MENTION = /@图片\d+(?![\d\[])/g;
const REFERENCE_TABS = ['scene', 'history'];

function uniqueReferenceImages(images = []) {
    const unique = new Map();
    for (const image of images) {
        const key = getPromptAgentReferenceKey(image);
        if (!key) continue;
        if (!unique.has(key)) unique.set(key, { ...image });
        else if (Object.hasOwn(image, 'description')) unique.get(key).description = image.description;
    }
    return [...unique.values()];
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
    appActions = null,
    notifyAppAction = () => {},
    documentRef = document,
    createReply = async (request) => buildDefaultReply(request),
    createCompaction = async () => { throw new Error('上下文压缩服务尚未配置。'); },
    compactionTimeoutMs = 120000,
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
    getSelectedCompactionModelId = () => '',
    getSelectedCompactionProviderId = () => '',
    getPanelWidth = () => null,
    setPanelWidth = () => {},
    getAutoCompactTokenLimit = () => 12000,
    getDiscardOverLimitContext = () => false,
    conversationStore = createPromptAgentConversationStore(),
    onStateChange = () => {},
    onDraftChange = onStateChange,
    onNativeClipboardWrite = () => {},
    getWorkflowId = () => '',
    mutateWorkflowConversation = null,
    resultPersistence = null,
    loadResultImages = async () => [],
    openResultPreview = () => {},
    createImageResultActions = null,
    createRunId = () => globalThis.crypto?.randomUUID?.() || `agent-run-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    readReferenceFile = readImageFile,
    referenceSource = null,
    referenceImageCatalog = null,
    createMentionThumbnail = async source => source,
    resizeObserverFactory = (callback) => typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null
} = {}) {
    const surfaces = getSurfaceCoordinator(documentRef);
    let canvasMentions = null;
    let imageMentions = null;
    const canvasViews = new Set();
    let initialized = false;
    let modelMenus = null;
    let searchMenu = null;
    let chatSettingsControl = null;
    let searchViewRevision = 0;
    let searchViewCleanups = [];
    let panelWidthController = null;
    let resizeObserver = null;
    let scrollToLatestOnOpen = false;
    let followLatestContent = false, lastScrollTop = 0, contentObserver = null;
    let workflowRevision = 0;
    let conversationRevision = 0;
    let tokenObservation = null;
    let activeOperation = null;
    const pendingOperations = new Map();
    const workflowStatuses = new Map();
    let visibleWorkflowId = '';
    let requestPending = false;
    let choiceView = null;
    let commandMenuOpen = false;
    let commandMatches = [];
    let commandIndex = 0;
    let pendingReferenceImages = [];
    const undoneImageMentions = new Map();
    let nextImageMentionNumber = 1;
    let mentionSelectionChanged = false;
    const mentionReplacementOperations = new Set();
    let preparedNodeContext = null;
    let preparedImageRequest = null;
    let referencePickerOpen = false;
    let referencePickerError = '';
    let referenceTab = 'scene';
    let referenceLimit = 60;
    let historyReferences = [];
    let historyLoading = false;
    let historyError = '';
    let historyLoadToken = 0;
    let importQueue = Promise.resolve();
    let thumbnailObservers = [];
    const promptPlanActionStates = new Set();
    const runViews = new Map();
    const resultLoaders = new Map();
    let resultObserver;
    const activeRuns = new Map();
    const runKey = (workflowId, runId) => `${workflowId}\0${runId}`;
    const results = resultPersistence || createPromptAgentResultPersistence({
        mutateConversation: (workflowId, reducer) => {
            if (mutateWorkflowConversation) return mutateWorkflowConversation(workflowId, reducer);
            if (getWorkflowId() !== workflowId) return false;
            const next = reducer(conversationStore.snapshot());
            if (!next) return false;
            conversationStore.restore(next);
            conversationRevision += 1;
            onStateChange();
            return true;
        },
        onChange: (workflowId, runId) => { if (getWorkflowId() === workflowId) refreshRunViews(runId); }
    });

    function getElements() {
        return {
            button: documentRef.getElementById('btn-prompt-agent'),
            closeButton: documentRef.getElementById('btn-close-prompt-agent'),
            panel: documentRef.getElementById('prompt-agent-panel'),
            form: documentRef.getElementById('prompt-agent-form'),
            input: documentRef.getElementById('prompt-agent-input'),
            sendButton: documentRef.getElementById('prompt-agent-send'),
            cancelButton: documentRef.getElementById('prompt-agent-cancel'),
            commandMenu: documentRef.getElementById('prompt-agent-command-menu'),
            commandStatus: documentRef.getElementById('prompt-agent-command-status'),
            modelSelect: documentRef.getElementById('prompt-agent-model'),
            modelHint: documentRef.getElementById('prompt-agent-model-hint'),
            modelStatus: documentRef.getElementById('prompt-agent-model-status'),
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

    const providerRoute = (purpose, getModels) => ({ getModels, getProviders,
        getProviderId: modelId => conversationStore.getProvider(purpose, modelId),
        setProviderId: (modelId, providerId) => conversationStore.setProvider(purpose, modelId, providerId) });
    function providerError(purpose, model) {
        if (!model) return null;
        try { resolveAgentProvider(model, getProviders(), conversationStore.getProvider(purpose, model.id)); return null; }
        catch (error) { return error; }
    }
    function initializeProvider(purpose, model) {
        if (!model || conversationStore.getProvider(purpose, model.id)) return;
        const providers = getProviders();
        const provider = getModelProviders(model, providers).find(candidate => {
            try { resolveAgentProvider(model, providers, candidate.id); return true; }
            catch { return false; }
        });
        if (provider) conversationStore.setProvider(purpose, model.id, provider.id);
    }
    function configureProvider(purpose, model) {
        openModelSettings(providerError(purpose, model)?.configurationTarget || { modelId: model?.id, field: 'providerIds' });
    }
    function selectedProvider(model, purpose) {
        try { return resolveAgentProvider(model, getProviders(), conversationStore.getProvider(purpose, model.id)); }
        catch { return {}; }
    }
    const thinkingControls = [];
    function captureThinkingConfig(modelId) {
        const config = captureRequestConfig(modelId);
        const thinking = conversationStore.getThinking('chat', modelId);
        if (!config) return config;
        const snapshot = JSON.parse(JSON.stringify(config));
        snapshot.providerId = conversationStore.getProvider('chat', modelId);
        snapshot.searchProviders = conversationStore.snapshot().providerSettings?.search || {};
        for (const model of [snapshot.model, ...(snapshot.models || [])]) if (thinking && model?.id === modelId) model.thinking = { ...model.thinking, default: thinking };
        return snapshot;
    }
    function compactionSelection(fallbackModelId) {
        const preferredId = getSelectedCompactionModelId();
        const modelId = preferredId || fallbackModelId;
        const model = getChatModels().find(model => model.id === modelId && model.modelId);
        if (!model) {
            throw new Error('所选压缩模型不可用，请在常规设置重新选择');
        }
        const config = captureThinkingConfig(modelId);
        if (!preferredId) return { modelId, config };
        const providerId = getSelectedCompactionProviderId(modelId);
        if (!providerId) throw new Error('请在常规设置中选择压缩模型与供应商。');
        if (config) resolveAgentProvider(config.model || model, config.providers || getProviders(), providerId);
        return { modelId, config: config && { ...config, providerId } };
    }
    function getUsableChatModels() {
        return getChatModels().filter((model) => model?.id && model?.modelId);
    }
    function syncModelOptions(select, options, selectedId, disabled) {
        if (!select) return;
        const currentOptions = Array.from(select.options || select.children || []);
        const unchanged = currentOptions.length === options.length && options.every((option, index) => {
            const current = currentOptions[index];
            return current.value === option.value && current.textContent === option.label &&
                Boolean(current.disabled) === Boolean(option.disabled);
        });
        if (!unchanged) {
            select.replaceChildren?.();
            for (const { value, label, disabled: optionDisabled = false } of options) {
                const option = documentRef.createElement('option');
                option.value = value;
                option.textContent = label;
                option.disabled = optionDisabled;
                select.appendChild(option);
            }
        }
        if (select.value !== selectedId) select.value = selectedId;
        if (select.disabled !== disabled) select.disabled = disabled;
    }
    function updateSendButtonState(models = getUsableChatModels()) {
        const { input, sendButton } = getElements();
        for (const selector of ['[data-message-action="resend"]', '[data-agent-request-retry]']) {
            getElements().messages?.querySelectorAll(selector).forEach(button => {
                const disabled = requestPending || models.length === 0;
                if (button.disabled !== disabled) button.disabled = disabled;
            });
        }
        if (!sendButton) return;
        const localAction = localAppRequest(input?.value);
        sendButton.disabled = localAction ? requestPending : !input?.value?.trim().startsWith('/')
            && (requestPending || mentionReplacementOperations.size > 0 || models.length === 0
                || pendingReferenceImages.some((image) => image.loading || image.error));
    }
    function renderModelOptions() {
        searchMenu?.render();
        renderImageModelOptions();
        const { modelSelect, modelHint, modelStatus, addModelButton } = getElements();
        const models = getUsableChatModels();
        // Local commands remain available without a model and during requests.
        updateSendButtonState(models);
        refreshChoiceButtons(models);
        if (!modelSelect) return models;
        const selected = conversationStore.getChatModelId() || getSelectedModelId() || models[0]?.id || '';
        if (selected && !conversationStore.getChatModelId()) conversationStore.setChatModelId(selected);
        const options = models.map(model => ({ value: model.id, label: getAgentModelLabel(model, getProviders()) }));
        if (selected && !models.some(model => model.id === selected)) {
            options.push({ value: selected, label: '已选对话模型不可用，请检查配置', disabled: true });
        }
        syncModelOptions(modelSelect, options, selected, models.length === 0);
        initializeProvider('chat', models.find(model => model.id === selected));
        const error = providerError('chat', models.find(model => model.id === selected));
        const statusText = models.length === 0 ? '让 Agent 回复前，请先配置对话模型。' : error?.message || '已选对话模型不可用，请检查配置。';
        if (modelStatus && modelStatus.textContent !== statusText) modelStatus.textContent = statusText;
        const hideHint = !error && models.some(model => model.id === selected);
        if (modelHint && modelHint.hidden !== hideHint) modelHint.hidden = hideHint;
        const configureLabel = models.length === 0 ? '配置对话模型' : '修复对话模型配置';
        if (addModelButton && addModelButton.textContent !== configureLabel) addModelButton.textContent = configureLabel;
        thinkingControls.forEach(control => control.refresh());
        modelMenus?.refresh();
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
        initializeProvider('image', models.find(model => model.id === selectedId));
        const options = [{ value: '', label: '请选择生图模型' }];
        if (selectedId && !valid) {
            options.push({ value: selectedId, label: '已选模型不可用，请重新选择', disabled: true });
        }
        options.push(...models.map(model => ({ value: model.id, label: getAgentModelLabel(model, getProviders()) })));
        // Never infer a selection from the first option or canvas node.
        syncModelOptions(imageModelSelect, options, selectedId, models.length === 0);
        const error = providerError('image', models.find(model => model.id === selectedId));
        const hideHint = (valid && !error) || (!selectedId && getUsableChatModels().length === 0);
        if (imageModelHint && imageModelHint.hidden !== hideHint) imageModelHint.hidden = hideHint;
        const statusText = error?.message || (selectedId && !valid
            ? '已选生图模型不可用，请重新选择。'
            : (models.length ? '生成图片前请选择生图模型。' : '生成图片需要配置生图模型。'));
        if (imageModelStatus && imageModelStatus.textContent !== statusText) imageModelStatus.textContent = statusText;
        if (addImageModelButton) {
            const hideConfigure = hideHint || (models.length > 0 && !error);
            const configureLabel = error ? '修复生图模型配置' : '配置生图模型';
            if (addImageModelButton.hidden !== hideConfigure) addImageModelButton.hidden = hideConfigure;
            if (addImageModelButton.textContent !== configureLabel) addImageModelButton.textContent = configureLabel;
        }
        promptPlanActionStates.forEach((actionState) => actionState.sync());
        canvasViews.forEach(view => view.sync());
        thinkingControls.forEach(control => control.refresh());
        // A provider preference can change without changing native options.
        modelMenus?.refresh();
    }

    function setCommandStatus(text = '') {
        const { commandStatus } = getElements();
        if (!commandStatus) return;
        commandStatus.textContent = text;
        commandStatus.hidden = !text;
    }

    function syncComposerPopovers() {
        if (!commandMenuOpen && !referencePickerOpen) return;
        const { panel, form } = getElements();
        if (!panel?.getBoundingClientRect || !form?.getBoundingClientRect) return;
        const offset = panel.getBoundingClientRect().bottom - form.getBoundingClientRect().top;
        panel.style?.setProperty('--prompt-agent-popup-offset', `${offset + 8}px`);
    }

    function announceCommandOptions(text = '') {
        const announcement = documentRef.getElementById('prompt-agent-command-announcement');
        if (announcement && announcement.textContent !== text) announcement.textContent = text;
    }

    function closeCommandMenu() {
        surfaces?.forgetPopover('agent-command');
        announceCommandOptions();
        if (!commandMenuOpen) return;
        commandMenuOpen = false;
        const { commandMenu, input } = getElements();
        if (commandMenu) commandMenu.hidden = true;
        input?.setAttribute('aria-controls', commandMenu?.id || 'prompt-agent-command-menu');
        input?.removeAttribute('aria-activedescendant');
    }

    function imageSizeCapabilities() {
        const model = getSelectedImageModel();
        return model ? sizeCapabilities(getEffectiveProtocol(model, selectedProvider(model, 'image')), model.modelId) : null;
    }
    function selectedImageParameterCapabilities() {
        const model = getSelectedImageModel();
        return imageParameterCapabilities(model, model && selectedProvider(model, 'image'));
    }
    function compressionProgress(message = '', fixedModel = null, operation = null) {
        const models = getChatModels();
        const model = fixedModel || models.find(item => item.id === (getElements().modelSelect?.value || getSelectedModelId())) || models[0];
        const store = operation?.store || conversationStore;
        const conversation = store.getCompactionContext();
        const previous = conversation.messages.findLast(item => item.promptPlan)?.promptPlan || conversation.previousPromptPlan;
        const references = operation ? operation.referenceImages : pendingReferenceImages.filter(image => !image.loading && !image.error);
        const measurement = measurePromptAgentContext({ model, message, conversation, confirmedNewTask: operation?.confirmedNewTask, choiceAnswer: operation?.choiceAnswer,
            autoCompactTokenLimit: operation ? operation.autoCompactTokenLimit : getAutoCompactTokenLimit(),
            sizeSettings: store.getSize(store.getImageModelId()), imageSizeCapabilities: operation ? operation.imageSizeCapabilities : imageSizeCapabilities(),
            imageParameterCapabilities: operation ? operation.imageParameterCapabilities : selectedImageParameterCapabilities(),
            canvasContext: operation ? operation.canvasContext : canvasAdapter?.context(canvasMentions?.read().map(item => item.id) || []) || null,
            searchAllowed: store.getSearchSettings().mode !== 'off',
            context: operation ? operation.selectedContext || (!operation.confirmedNewTask ? operation.nodeContexts?.get(previous?.targetNodeId) : null)
                : nodeAdapter?.getSelectedContext?.() || (previous?.targetNodeId ? nodeAdapter?.getContext?.(previous.targetNodeId) : null),
            referenceImages: references,
            workflowReferenceImages: uniqueReferenceImages([
                ...store.getReferenceImages(),
                ...(operation ? operation.contextReferences : referenceSource?.getContextReferences?.(conversation) || [])
            ])
        }, operation ? operation.observation : tokenObservation);
        // An empty conversation has no accumulated context. Keep the full
        // request estimate for execution, but do not present system instructions
        // and ambient canvas candidates as uncleared conversation history.
        const emptyConversation = !conversation.messages.length && !conversation.archivedMessages?.length
            && !conversation.memory && !conversation.contextSummary && !conversation.previousPromptPlan
            && !store.getReferenceImages().length && !references.length && !message.trim();
        return { ...measurement, emptyConversation };
    }

    async function compactWithProgress(operation, conversation, { modelId, config }) {
        const child = new AbortController();
        let timeout, timer, rejectWait, progress = '';
        const waiting = new Promise((_, reject) => { rejectWait = reject; });
        const cancel = () => { child.abort(); rejectWait(new DOMException('上下文压缩已取消', 'AbortError')); };
        const started = Date.now();
        const show = () => {
            setOperationStatus(operation, `正在压缩上下文${progress}，已等待 ${Math.floor((Date.now() - started) / 1000)} 秒；可点击停止取消。`);
        };
        const resetTimeout = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                rejectWait(new Error(`压缩请求超时（${Math.round(compactionTimeoutMs / 1000)} 秒未完成当前批次），请检查供应商连接后重试`));
                child.abort();
            }, compactionTimeoutMs);
        };
        operation.controller.signal.addEventListener('abort', cancel, { once: true });
        resetTimeout(); timer = setInterval(show, 1000);
        try {
            if (operation.controller.signal.aborted) cancel();
            return await Promise.race([waiting, createCompaction({ conversation, modelId, config,
                signal: child.signal, onProgress: ({ batch, total }) => {
                    if (child.signal.aborted || !isLiveOperation(operation)) return;
                    progress = `（第 ${batch}/${total} 批）`; resetTimeout(); show();
                } })]);
        } finally {
            clearTimeout(timeout); clearInterval(timer);
            operation.controller.signal.removeEventListener('abort', cancel);
        }
    }

    async function autoCompact(operation, modelId, message = '') {
        if (operation.discardOverLimitContext) return true;
        if (operation.compactionStatus) { setOperationStatus(operation, operation.compactionStatus); return true; }
        const progress = () => compressionProgress(message, operation.model, operation);
        if (!progress().reached) return true;
        const conversation = operation.store.getCompactionContext();
        if (!conversation.messages.length && !conversation.memory) return true;
        // A large retained plan/image batch cannot be shrunk by re-summarizing a few new words.
        const newText = createPromptAgentInput({ conversation: { messages: conversation.messages }, model: operation.model })
            .messages.slice(0, -1).map(turn => turn.content).join('\n') + (conversation.memory || '');
        if (conversation.contextSummary && countPromptText(newText) < Math.min(2000, progress().threshold * 0.2)) {
            setOperationStatus(operation, '保留的方案、图片或系统指令仍占用较多上下文；新增对话较少，暂不重复压缩。可在常规设置调整自动压缩阈值。');
            return true;
        }
        const revision = conversationRevision;
        operation.kind = 'compact';
        setOperationStatus(operation, '已达到 Token 阈值，正在自动压缩上下文…');
        try {
            if (operation.compactionError) throw operation.compactionError;
            const result = await compactWithProgress(operation, conversation, operation.compaction || compactionSelection(modelId));
            if (!isLiveOperation(operation)) return false;
            if (!operation.workflowId && revision !== conversationRevision) throw new Error('压缩期间对话已更新，请重试');
            if (mutateOperationConversation(operation, store => { store.compact(result?.summary); return true; }) === false) return false;
            operation.observation = null;
            if (isCurrentOperation(operation)) { tokenObservation = null; if (commandMenuOpen) renderCommandMenu(); }
            operation.compactionStatus = progress().reached
                ? '已自动压缩；保留的方案或素材仍超过阈值，不会继续循环压缩或截断。'
                : '已自动压缩上下文，历史记录、参考图和最新方案已保留。';
            setOperationStatus(operation, operation.compactionStatus);
            return true;
        } catch (error) {
            if (isLiveOperation(operation)) setOperationStatus(operation, `自动压缩失败：${error?.message || '请重试'}。原上下文已保留，请重试发送或使用 /compact。`);
            return false;
        } finally {
            operation.kind = 'reply';
        }
    }

    function renderCommandMenu({ resetSelection = false } = {}) {
        const { commandMenu, input } = getElements();
        const query = input?.value?.trim().toLowerCase() || '';
        const isCommand = query.startsWith('/') && !/\s/.test(query);
        commandMatches = isCommand
            ? COMMANDS.filter((command) => command.name.startsWith(query) || command.title.includes(query.slice(1)))
            : [];
        if (!commandMenu || !commandMatches.length) {
            closeCommandMenu();
            if (isCommand) announceCommandOptions('没有匹配的 Agent 命令。');
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
            option.tabIndex = -1;
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
                const discard = getDiscardOverLimitContext();
                meter.setAttribute('aria-label', discard ? '上下文阈值进度' : '自动压缩阈值进度');
                meter.setAttribute('aria-valuemin', '0');
                meter.setAttribute('aria-valuemax', '100');
                meter.setAttribute('aria-valuenow', String(displayedPercent));
                const detail = discard
                    ? `上下文用量约 ${usage.used} / ${usage.threshold} Token。超过阈值会移除最旧的对话，聊天记录仍可查看。${usage.source}。`
                    : usage.emptyConversation
                    ? `暂无对话上下文。下次请求的系统指令和画布候选预计占用约 ${usage.used} / ${usage.threshold} Token，并非残留聊天；发送时按完整请求检查自动压缩阈值。`
                    : `自动压缩阈值进度：约 ${usage.used} / ${usage.threshold} Token（文本约 ${usage.textTokens}，图片约 ${usage.imageTokens}，含系统指令及画布候选）；此阈值是自动压缩设置，并非模型最大容量；${usage.source}。发送前及回复后达到阈值时调用模型压缩，与圆环共用计数。`;
                meter.setAttribute('aria-valuetext', `${displayedPercent}%，${detail}`);
                meter.title = detail;
                const value = documentRef.createElement('span');
                value.textContent = usage.emptyConversation ? '0%' : `≈${displayedPercent}%`;
                meter.appendChild(value);
                option.appendChild(meter);
                option.classList.add('has-context-usage');
            }
            option.addEventListener('click', () => {
                input.focus({ preventScroll: true });
                void executeCommand(command.name);
            });
            commandMenu.appendChild(option);
        });
        commandMenuOpen = true;
        syncComposerPopovers();
        commandMenu.hidden = false;
        const activeOption = commandMenu.children?.[commandIndex];
        if (activeOption && commandMenu.clientHeight) {
            const top = activeOption.offsetTop;
            const bottom = top + activeOption.offsetHeight;
            commandMenu.scrollTop = Math.min(top, Math.max(commandMenu.scrollTop, bottom - commandMenu.clientHeight));
        }
        surfaces?.openPopover('agent-command', { element: commandMenu, trigger: input, close: closeCommandMenu });
        if (!commandMenuOpen) return;
        input.setAttribute('aria-controls', commandMenu.id);
        input.setAttribute('aria-activedescendant', `prompt-agent-command-${commandMatches[commandIndex].name.slice(1)}`);
        announceCommandOptions(`Agent 命令列表已展开，共 ${commandMatches.length} 项。使用上下方向键选择，Enter 执行。`);
    }

    function beginOperation(kind) {
        if (!visibleWorkflowId) visibleWorkflowId = getWorkflowId();
        const store = createPromptAgentConversationStore();
        store.restore(snapshotWorkflow());
        const operation = { kind, controller: new AbortController(), revision: workflowRevision,
            workflowId: getWorkflowId(), store, creativeTask: conversationStore.getCreativeTask() };
        pendingOperations.set(operation.workflowId, operation);
        activeOperation = operation;
        setOperationStatus(operation, '');
        requestPending = true;
        const { cancelButton, sendButton, input } = getElements();
        const returnToInput = sendButton && documentRef.activeElement === sendButton;
        if (cancelButton) cancelButton.hidden = false;
        renderModelOptions();
        if (returnToInput) input?.focus?.({ preventScroll: true });
        if (kind === 'reply') showProcessing(operation);
        return operation;
    }

    function isCurrentOperation(operation) {
        return isLiveOperation(operation) && activeOperation === operation
            && operation.workflowId === getWorkflowId()
            && (operation.workflowId || operation.revision === workflowRevision);
    }

    function isLiveOperation(operation) {
        return pendingOperations.get(operation.workflowId) === operation && !operation.controller.signal.aborted;
    }

    function setOperationStatus(operation, text) {
        if (!isLiveOperation(operation)) return;
        operation.status = text;
        if (operation.workflowId) {
            if (text) workflowStatuses.set(operation.workflowId, text);
            else workflowStatuses.delete(operation.workflowId);
        }
        if (isCurrentOperation(operation)) setCommandStatus(text);
    }

    function mutateOperationConversation(operation, reducer) {
        if (!isLiveOperation(operation)) return false;
        let result, attempted = false;
        const apply = value => {
            attempted = true;
            const store = createPromptAgentConversationStore();
            store.restore(value || operation.store.snapshot());
            result = reducer(store);
            if (result === false) return false;
            operation.store.restore(store.snapshot());
            return store.snapshot();
        };
        if (operation.workflowId && mutateWorkflowConversation) {
            if (!mutateWorkflowConversation(operation.workflowId, apply)) {
                if (!attempted) operation.controller.abort();
                return false;
            }
        } else {
            const next = apply(isCurrentOperation(operation) ? snapshotWorkflow() : operation.store.snapshot());
            if (!next) return false;
        }
        if (isCurrentOperation(operation)) {
            conversationStore.restore(operation.store.snapshot());
            tokenObservation = operation.observation || null;
            conversationRevision += 1;
            if (!mutateWorkflowConversation || !operation.workflowId) onStateChange();
        }
        return result;
    }

    function appendOperationMessage(operation, role, text, workSummary = [], extra = {}) {
        const index = mutateOperationConversation(operation, store => {
            if (role === 'user' && operation.discardedMessageCount !== undefined) {
                store.discardContextBefore(operation.discardedMessageCount);
            }
            if (role === 'user' && operation.consumeDraft) {
                const draft = store.getDraft();
                store.setDraft({ text: draft.text.trim() === operation.text ? '' : draft.text,
                    referenceImages: draft.referenceImages.filter(image => !operation.stagedReferenceKeys.has(getPromptAgentReferenceKey(image))) });
            }
            return store.append({ role, text, workSummary, ...extra });
        });
        if (index === false || !Number.isInteger(index)) return { index: -1, element: null };
        const element = isCurrentOperation(operation) ? appendMessage(role, text, workSummary, { ...extra, record: false }) : null;
        if (element) element.promptAgentMessageIndex = index;
        if (isCurrentOperation(operation)) refreshChoiceButtons();
        return { index, element };
    }

    function finishOperation(operation) {
        if (pendingOperations.get(operation.workflowId) === operation) pendingOperations.delete(operation.workflowId);
        operation.processingElement?.remove();
        // A late finally must never reset another workflow's newer request.
        if (activeOperation !== operation) return;
        activeOperation = null;
        requestPending = false;
        const { cancelButton, input } = getElements();
        const returnToInput = cancelButton && documentRef.activeElement === cancelButton;
        if (cancelButton) cancelButton.hidden = true;
        renderModelOptions();
        if (returnToInput) input?.focus?.({ preventScroll: true });
    }

    function cancelRequest({ silent = false } = {}) {
        const operation = activeOperation;
        if (!operation) return;
        if (operation.workflowId && operation.workflowId !== getWorkflowId()) return;
        if (!silent && operation.kind !== 'compact') appendOperationMessage(operation, 'agent', '已取消本次 Agent 请求。');
        setOperationStatus(operation, !silent && operation.kind === 'compact' ? '已取消压缩，原上下文已保留。' : '');
        operation.controller.abort();
        finishOperation(operation);
        if (silent) return;
        if (operation.kind === 'compact') setCommandStatus('已取消压缩，原上下文已保留。');
        else setCommandStatus();
    }

    function cancelWorkflowRequest(workflowId) {
        workflowStatuses.delete(workflowId);
        const operation = pendingOperations.get(workflowId);
        if (!operation) return false;
        operation.controller.abort();
        finishOperation(operation);
        return true;
    }

    function cancelAllRequests() {
        for (const workflowId of [...pendingOperations.keys()]) cancelWorkflowRequest(workflowId);
        workflowStatuses.clear();
        setCommandStatus();
    }

    function showProcessing(operation) {
        const { messages } = getElements();
        if (!messages) return;
        const indicator = documentRef.createElement('div');
        indicator.className = 'prompt-agent-processing';
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        const dot = documentRef.createElement('span');
        dot.className = 'prompt-agent-processing-dot';
        dot.setAttribute('aria-hidden', 'true');
        const label = documentRef.createElement('span');
        label.textContent = operation.status || '正在处理…';
        indicator.appendChild(dot);
        indicator.appendChild(label);
        messages.appendChild(indicator);
        operation.processingElement = indicator;
        operation.processingLabel = label;
        scrollToLatest();
    }

    async function executeCommand(name) {
        const { input } = getElements();
        closeCommandMenu();
        if (name === '/clear') {
            const clearedWorkflowId = getWorkflowId();
            cancelRequest({ silent: true });
            workflowRevision += 1;
            importQueue = Promise.resolve();
            const clearedRevision = workflowRevision;
            canvasMentions?.clear(); canvasViews.forEach(view => view.destroy()); canvasViews.clear();
            preparedNodeContext = null;
            preparedImageRequest = null;
            const clearing = results.clear(clearedWorkflowId);
            pendingReferenceImages = [];
            undoneImageMentions.clear();
            mentionReplacementOperations.clear();
            nextImageMentionNumber = 1;
            if (input) input.value = '';
            // Persistence may have no workflow document yet. Clear the visible
            // store independently, after result cleanup captures its old runs.
            conversationStore.clear();
            conversationRevision += 1;
            onStateChange();
            tokenObservation = null;
            referencePickerError = '';
            setReferencePickerOpen(false);
            renderConversation();
            renderPendingReferences();
            setCommandStatus('已清空上下文，可以开始新的对话。');
            input?.focus?.();
            try {
                await clearing;
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
        if (getDiscardOverLimitContext()) {
            if (input) input.value = '';
            setCommandStatus('已开启「不压缩上下文」，超过阈值时会移除最旧的对话。');
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
        const replyModelId = getElements().modelSelect?.value || getSelectedModelId() || models[0].id;
        let selection;
        try { selection = compactionSelection(replyModelId); }
        catch (error) { setCommandStatus(error.message); return; }
        if (input) input.value = '';
        const operation = beginOperation('compact');
        const revision = conversationRevision;
        setOperationStatus(operation, '正在压缩上下文，整理目标、约束与最新方案…');
        try {
            const result = await compactWithProgress(operation, conversation, selection);
            if (!isLiveOperation(operation)) return;
            if (!operation.workflowId && revision !== conversationRevision) throw new Error('压缩期间对话已更新，请重新压缩');
            if (mutateOperationConversation(operation, store => { store.compact(result?.summary); return true; }) === false) return;
            if (isCurrentOperation(operation)) tokenObservation = null;
            // Keep the transcript and any running generation cards in place.
            if (isCurrentOperation(operation) && commandMenuOpen) renderCommandMenu();
            setOperationStatus(operation, '上下文已压缩。后续对话将使用摘要，历史记录仍可查看。');
        } catch (error) {
            if (!isLiveOperation(operation)) return;
            setOperationStatus(operation, `压缩失败：${error?.message || '请重试'}。原上下文已保留。`);
        } finally {
            finishOperation(operation);
        }
    }

    function appendReferencePreviews(container, referenceImages = [], { removable = false, snapshot = false, numberOffset = 0 } = {}) {
        referenceImages.forEach((reference, index) => {
            const item = documentRef.createElement('span');
            item.className = 'prompt-agent-reference';
            if (reference.sourceNodeId) item.dataset.sourceNodeId = reference.sourceNodeId;
            const image = documentRef.createElement('img');
            image.src = reference.dataUrl || reference.previewUrl || '';
            image.alt = reference.mentionToken ? `${reference.mentionToken}：${reference.name || '图片'}`
                : `${snapshot ? '自动读取的上下文图片' : '参考图'} ${numberOffset + index + 1}：${reference.name || '图片'}`;
            image.title = image.alt;
            image.draggable = false;
            if (!reference.loading && (reference.dataUrl || reference.previewUrl)) {
                image.style.cursor = 'pointer';
                image.addEventListener('click', () => openResultPreview([reference.dataUrl || reference.previewUrl], 0, {
                    description: reference.description || '',
                    onDescriptionChange: snapshot ? undefined : value => {
                        reference.description = value;
                        if (reference.sourceNodeId) nodeAdapter?.setSceneReferenceDescription?.(reference, value);
                        const messageIndex = container.parentElement?.promptAgentMessageIndex;
                        if (Number.isInteger(messageIndex) && conversationStore.updateReferenceDescription(messageIndex, index, value)) {
                            conversationRevision += 1;
                            onStateChange();
                        }
                        if (removable) renderPendingReferences();
                    }
                }));
            }
            item.appendChild(image);
            const number = documentRef.createElement('span');
            number.className = 'prompt-agent-reference-number';
            if (reference.mentionToken) number.dataset.mentionToken = reference.mentionToken;
            number.textContent = reference.mentionToken ? `@${reference.mentionToken.slice('@图片'.length)}` : String(numberOffset + index + 1);
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
                    removePendingReference(reference);
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
        const heading = documentRef.getElementById('prompt-agent-reference-heading');
        const clearSelection = documentRef.getElementById('prompt-agent-reference-clear');
        if (heading) {
            heading.hidden = pendingReferenceImages.length === 0;
            heading.textContent = `本轮待发送附件 · ${pendingReferenceImages.length}`;
        }
        if (clearSelection) clearSelection.hidden = pendingReferenceImages.length === 0;
        renderPreparedNodeContext();
        renderPreparedImageRequest();
        form?.classList.toggle('has-reference-images', pendingReferenceImages.length > 0);
        if (referenceError) {
            referenceError.hidden = !referencePickerError;
            referenceError.textContent = referencePickerError;
        }
        renderReferencePicker();
        renderModelOptions();
        captureDraft(true);
        imageMentions?.refresh();
    }

    function renderReferencePicker() {
        const { referencePickerList, referencePickerStatus } = getElements();
        if (!referencePickerOpen || !referencePickerList) return;
        thumbnailObservers.forEach(observer => observer.disconnect()); thumbnailObservers = [];
        const focusedId = documentRef.activeElement?.getAttribute?.('data-reference-id');
        clearElement(referencePickerList);
        const allCandidates = referenceTab === 'history' ? historyReferences : (nodeAdapter?.getSceneReferenceImages?.() || []);
        const filtered = allCandidates;
        const candidates = filtered.slice(0, referenceLimit);
        const done = documentRef.getElementById('prompt-agent-reference-picker-close');
        if (done) done.textContent = pendingReferenceImages.length ? `完成（${pendingReferenceImages.length}）` : '完成';
        const more = documentRef.getElementById('prompt-agent-reference-more');
        if (more) more.hidden = filtered.length <= referenceLimit;
        for (const tab of REFERENCE_TABS) {
            const button = documentRef.getElementById(`prompt-agent-tab-${tab}`);
            const source = documentRef.getElementById(`prompt-agent-reference-${tab}`);
            const selected = referenceTab === tab;
            if (button) {
                button.setAttribute('aria-selected', String(selected));
                button.tabIndex = selected ? 0 : -1;
            }
            if (source) {
                source.hidden = !selected;
                if (selected && referencePickerList.parentElement !== source) {
                    source.append(...[referencePickerStatus, referencePickerList, more].filter(Boolean));
                }
            }
        }
        if (referencePickerStatus) referencePickerStatus.textContent = referenceTab === 'history' && (historyLoading || historyError)
            ? (historyLoading ? '正在加载历史图片…' : historyError)
            : candidates.length
            ? ''
            : (referenceTab === 'history' ? (historyLoading ? '正在加载历史图片…' : historyError || '没有匹配的历史图片。') : '没有匹配的画布图片，可上传图片。');
        if (referencePickerStatus) referencePickerStatus.hidden = !referencePickerStatus.textContent;
        let focusedOption;
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
            preview.type = 'button'; preview.className = 'prompt-agent-reference-preview';
            preview.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
            preview.title = '预览原图';
            preview.setAttribute('aria-label', `预览 ${candidate.name}`);
            preview.addEventListener('click', async () => {
                const revision = workflowRevision;
                try {
                    const image = candidate.historyId ? await referenceSource.readHistory(candidate) : await nodeAdapter.readSceneReferenceImage(candidate);
                    if (revision === workflowRevision && image?.dataUrl) openResultPreview([image.dataUrl], 0, {
                        description: candidate.description || image.description || '',
                        onDescriptionChange: value => {
                            candidate.description = value;
                            referenceSource?.saveDescription?.(candidate, value);
                            if (candidate.sourceNodeId) nodeAdapter?.setSceneReferenceDescription?.(candidate, value);
                            if (candidate.nodeId) nodeAdapter?.setSceneReferenceDescription?.({ sourceNodeId: candidate.nodeId, sourceImageIndex: 0 }, value);
                            pendingReferenceImages.filter(item => item.selectionKey === candidate.referenceId
                                || item.referenceId === candidate.referenceId
                                || (candidate.sourceNodeId && item.sourceNodeId === candidate.sourceNodeId)
                                || (candidate.nodeId && item.sourceNodeId === candidate.nodeId))
                                .forEach(item => { item.description = value; });
                            renderPendingReferences();
                        }
                    });
                } catch (error) { if (revision === workflowRevision) { referencePickerError = error.message; renderPendingReferences(); } }
            });
            const cell = documentRef.createElement('div'); cell.className = 'prompt-agent-reference-cell';
            referencePickerList.appendChild(cell); cell.appendChild(button); cell.appendChild(preview);
            if (candidate.referenceId === focusedId) focusedOption = button;
        });
        if (focusedId) (focusedOption || documentRef.getElementById(`prompt-agent-tab-${referenceTab}`))?.focus?.({ preventScroll: true });
        syncComposerPopovers();
    }

    function setReferencePickerOpen(open, focusTrigger = false) {
        if (open) { closeCommandMenu(); imageMentions?.close(); }
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
            if (referencePickerOpen) {
                const firstControl = documentRef.getElementById(`prompt-agent-tab-${referenceTab}`)
                    || referencePickerList?.querySelector?.('button');
                firstControl?.focus?.({ preventScroll: true });
            }
        } else if (focusTrigger) addReferenceButton?.focus?.();
    }

    function removePendingReference(reference) {
        const index = pendingReferenceImages.indexOf(reference);
        if (index >= 0) pendingReferenceImages.splice(index, 1);
        if (!reference.mentionToken) return;
        undoneImageMentions.delete(reference.mentionToken);
        const input = getElements().input;
        if (input) input.value = input.value.replace(IMAGE_MENTION, token => token === reference.mentionToken ? '' : token);
    }

    function reconcileImageMentions() {
        const text = getElements().input?.value || '';
        const used = new Set(text.match(IMAGE_MENTION) || []);
        let changed = mentionSelectionChanged;
        mentionSelectionChanged = false;
        pendingReferenceImages = pendingReferenceImages.filter((image, index) => {
            if (!image.mentionToken || used.has(image.mentionToken)) return true;
            changed = true;
            if (image.dataUrl && !image.error) undoneImageMentions.set(image.mentionToken, { image: { ...image }, index });
            if (image.mentionOnly) return false;
            delete image.mentionToken;
            delete image.mentionMode;
            delete image.mentionCandidateId;
            return true;
        });
        for (const token of used) {
            const restored = undoneImageMentions.get(token);
            if (!restored) continue;
            const existing = pendingReferenceImages.find(image => getPromptAgentReferenceKey(image) === getPromptAgentReferenceKey(restored.image));
            if (existing) Object.assign(existing, {
                mentionToken: token, mentionMode: restored.image.mentionMode, mentionCandidateId: restored.image.mentionCandidateId
            });
            else pendingReferenceImages.splice(restored.index, 0, restored.image);
            undoneImageMentions.delete(token);
            changed = true;
        }
        // Keep a short undo history without retaining every original removed from a long draft.
        while (undoneImageMentions.size > 8) undoneImageMentions.delete(undoneImageMentions.keys().next().value);
        if (changed) { referencePickerError = ''; renderPendingReferences(); }
    }

    async function toggleSceneReference(candidate, { toggle = true, mention } = {}) {
        referencePickerError = '';
        const key = getPromptAgentReferenceKey(candidate);
        const index = pendingReferenceImages.findIndex((item) => getPromptAgentReferenceKey(item) === key);
        if (index >= 0) {
            const pending = pendingReferenceImages[index];
            if (toggle) { removePendingReference(pending); renderPendingReferences(); }
            else if (mention) { Object.assign(pending, mention); renderPendingReferences(); }
            return pending;
        }
        // Reserve the position immediately so slow image reads cannot reorder
        // the user's selections. Removing it cancels this pending selection.
        const pending = { ...candidate, loading: true, ...mention, ...(mention ? { mentionOnly: true } : {}) };
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
            removePendingReference(pending);
            referencePickerError = `${candidate.name}：${error?.message || '参考图读取失败，请重试。'}`;
        }
        renderPendingReferences();
        return pending;
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

    function toggleImportedReference(candidate, { toggle = true, mention, read } = {}) {
        const key = referenceSource?.getReferenceId?.(candidate) || candidate.referenceId;
        const existing = pendingReferenceImages.findIndex(item => item.selectionKey === candidate.referenceId || item.referenceId === key);
        if (existing >= 0) {
            const pending = pendingReferenceImages[existing];
            if (toggle) { removePendingReference(pending); renderPendingReferences(); }
            else if (mention) { Object.assign(pending, mention); renderPendingReferences(); }
            return Promise.resolve(pending);
        }
        const pending = { name: candidate.name, description: candidate.description || '', referenceId: candidate.referenceId,
            selectionKey: candidate.referenceId, previewUrl: candidate.previewUrl, loading: true,
            ...mention, ...(mention ? { mentionOnly: true } : {}) };
        const revision = workflowRevision;
        const isCurrent = () => revision === workflowRevision && pendingReferenceImages.includes(pending);
        const run = () => {
            if (!isCurrent()) return Promise.resolve();
            referencePickerError = '';
            pending.loading = true; delete pending.error; renderPendingReferences();
            const operation = importQueue.catch(() => {}).then(async () => {
                if (!isCurrent()) return;
                try {
                    const image = await referenceSource.importReference(candidate, { isCurrent,
                        read: read || (candidate.file ? () => readReferenceFile(candidate.file) : undefined),
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

    function getUpstreamMentionImages() {
        if (!referenceImageCatalog) return [];
        const mentions = canvasMentions?.read() || [];
        const selected = canvasAdapter?.context()?.summary?.selectedIds || [];
        const targets = mentions.length ? mentions.map(item => item.id) : selected;
        return targets.flatMap(id => referenceImageCatalog.getUpstream(id));
    }

    async function getSceneMentionImages() {
        const scene = await referenceImageCatalog?.getScene() || [];
        const conversation = conversationStore.getCompactionContext();
        const results = (referenceSource?.getContextReferences?.(conversation) || [])
            .filter(image => image.runId && image.assetKey)
            .map(image => ({ ...image, id: image.referenceId, kind: 'canvas', searchText: image.prompt }));
        return Object.assign([...scene, ...results], { warning: scene.warning });
    }

    function getImageMention(token) {
        const image = pendingReferenceImages.find(image => image.mentionToken === token);
        if (!image) return null;
        return {
            id: image.mentionCandidateId || image.selectionKey || image.referenceId,
            name: image.name,
            mode: image.mentionMode || 'scene',
            // Agent attachments retain the original selected for the draft even if the canvas changes.
            ...(image.dataUrl ? { original: image.dataUrl } : { previewUrl: image.previewUrl })
        };
    }

    function selectMentionImage(candidate, { isCurrent, mode, replacing, token: replacedToken, signal }) {
        if (!referenceSource || !referenceImageCatalog || !isCurrent()) return null;
        const input = getElements().input;
        const sourceId = candidate.sourceId || candidate.id;
        let sceneImport;
        if (candidate.kind === 'import') {
            if (!referenceImageCatalog.getCanvas().some(image => image.id === sourceId)) throw new Error('图片已变化，请重新选择。');
            sceneImport = nodeAdapter?.getSceneReferenceImages?.().find(image => image.sourceNodeId === candidate.sourceNodeId
                && image.sourceImageIndex === candidate.sourceImageIndex);
        }
        const historyId = candidate.historyId || `agent-asset:${sourceId}`;
        const referenceId = sceneImport?.referenceId || sourceId;
        const resolvedId = sceneImport?.referenceId || referenceSource.getReferenceId?.({ historyId, historyVersion: candidate.historyVersion, referenceId });
        const matches = image => image.selectionKey === referenceId || (resolvedId && image.referenceId === resolvedId);
        const existing = pendingReferenceImages.find(matches) || [...undoneImageMentions.values()].find(({ image }) => matches(image))?.image;
        const createMention = image => {
            const used = new Set(input.value.match(IMAGE_MENTION) || []);
            while (used.has(`@图片${nextImageMentionNumber}`)) nextImageMentionNumber += 1;
            return { mentionToken: image?.mentionToken || `@图片${nextImageMentionNumber++}`,
                mentionMode: mode, mentionCandidateId: candidate.id };
        };
        const importCandidate = { historyId, historyVersion: candidate.historyVersion, referenceId, name: candidate.name,
            description: candidate.kind === 'history' ? undefined : candidate.description, previewUrl: candidate.previewUrl };
        const read = async () => {
            const source = await referenceImageCatalog.readImage(candidate);
            const dataUrl = /^https?:\/\//i.test(source) ? await readWebImage(source) : source;
            if (!/^data:image\//i.test(dataUrl)) throw new Error('参考原图不可用，请重新选择。');
            return { name: candidate.name, dataUrl, type: dataUrl.slice(5, dataUrl.indexOf(';')) };
        };
        if (replacing) {
            const commitReplacement = (attached, original) => {
                const mention = createMention(attached);
                if (mention.mentionToken === replacedToken) return replacedToken;
                return { token: mention.mentionToken, commit() {
                    if (undoneImageMentions.has(mention.mentionToken)) return;
                    if (attached) Object.assign(attached, mention);
                    else {
                        const previousIndex = pendingReferenceImages.findIndex(image => image.mentionToken === replacedToken);
                        pendingReferenceImages.splice(previousIndex < 0 ? pendingReferenceImages.length : previousIndex + 1, 0,
                            { ...original, selectionKey: referenceId, ...mention, mentionOnly: true });
                    }
                    mentionSelectionChanged = true;
                } };
            };
            if (existing?.dataUrl && !existing.error) return commitReplacement(existing);
            const revision = workflowRevision;
            const current = () => revision === workflowRevision && documentRef.documentElement?.dataset.canvasLoadState !== 'loading' && isCurrent();
            const replacement = {};
            const finish = () => {
                signal?.removeEventListener('abort', finish);
                if (mentionReplacementOperations.delete(replacement)) updateSendButtonState();
            };
            mentionReplacementOperations.add(replacement);
            signal?.addEventListener('abort', finish, { once: true });
            updateSendButtonState();
            const operation = importQueue.catch(() => {}).then(async () => {
                if (!current()) return null;
                const original = sceneImport ? await nodeAdapter?.readSceneReferenceImage?.(sceneImport)
                    : await referenceSource.importReference(importCandidate, { isCurrent: current, read, signal });
                if (!current()) return null;
                if (!original?.dataUrl) throw new Error('参考原图不可用，请重新选择。');
                const attached = pendingReferenceImages.find(matches);
                if (attached?.loading || attached?.error) throw new Error('请等待所选附件就绪或移除失败的附件。');
                return commitReplacement(attached, original);
            }).finally(finish);
            importQueue = operation;
            return operation;
        }
        const mention = createMention(existing);
        if (undoneImageMentions.has(mention.mentionToken)) return mention.mentionToken;
        if (sceneImport) void toggleSceneReference(sceneImport, { toggle: false, mention });
        else void toggleImportedReference(importCandidate, { toggle: false, mention, read });
        return mention.mentionToken;
    }

    function missingImageMention(text, attachments) {
        const bound = new Set(attachments.map(image => image.mentionToken).filter(Boolean));
        return (text?.match(IMAGE_MENTION) || []).find(token => !bound.has(token));
    }

    function unavailableImageMentionMessage(token) {
        return `${token} 对应的参考图已不可用，请重新选择或移除标记。`;
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
        if (!open) thinkingControls.forEach(control => control.close());
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
            setResizeControlsOpen(false);
        }
    }

    function updateScrollBottomButton() {
        const { messages, scrollBottomButton } = getElements();
        if (scrollBottomButton && messages) {
            scrollBottomButton.hidden = messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
        }
    }

    function scrollToLatest() {
        followLatestContent = true;
        const { messages } = getElements();
        scrollToLatestOnOpen = messages?.clientHeight === 0;
        if (messages) { messages.scrollTop = messages.scrollHeight; lastScrollTop = messages.scrollTop; }
        updateScrollBottomButton();
    }

    function open() {
        panelManager?.beforeOpen?.('agent');
        // Model settings can finish loading after the controller is initialized.
        // Refresh here so the first request always sees the current chat models.
        renderModelOptions();
        setOpen(true);
        renderPreparedNodeContext();
        surfaces?.bringToFront(getElements().panel);
        if (documentRef.activeElement === getElements().button) getElements().input?.focus?.();
        panelWidthController?.apply();
        if (scrollToLatestOnOpen) scrollToLatest();
        updateScrollBottomButton();
        if (!resultObserver) resultLoaders.forEach((_load, element) => loadVisibleResult(element));
    }

    function preparedTarget() {
        if (!preparedNodeContext || preparedNodeContext.workflowId !== getWorkflowId()) return null;
        return canvasAdapter?.context([preparedNodeContext.nodeId]).nodes.find(node => node.id === preparedNodeContext.nodeId) || null;
    }

    function preparedPromptSource(node) {
        const source = nodeAdapter?.getContext?.(node.id)?.promptSource;
        if (!source) return null;
        const sourceNode = source.active && source.editable
            ? canvasAdapter?.context([source.nodeId]).nodes.find(item => item.id === source.nodeId) : null;
        return { ...source, editable: Boolean(sourceNode), node: sourceNode };
    }

    function promptSourceGuidance(source) {
        if (!source) return '修改对象为当前节点的本地提示词。';
        const name = source.name || source.nodeId;
        const reason = { missing: '来源已不存在', disabled: '来源已停用', unavailable: '输出当前不可用', empty: '尚无文本输出',
            running: '来源正在运行', readonly: '来源参数只读', derived: '内容由视角参数派生', unsupported: '暂不支持在助手中修改该类型' }[source.reason];
        if (!source.active) return `上游「${name}」${reason || '当前无有效文本'}，当前使用本地提示词。`;
        if (source.editable) return `提示词来自「${name}」，应用优化时修改对象为该文本来源。`;
        const editor = source.type === 'CameraControl' ? '视角编辑器' : '原编辑器';
        return `提示词来自「${name}」，该来源只读${reason ? `（${reason}）` : ''}；请到该来源的${editor}调整，助手仅提供建议。`;
    }

    function renderPreparedNodeContext() {
        const host = documentRef.getElementById('prompt-agent-node-context');
        if (!host) return;
        if (!getElements().panel?.classList.contains('active')) { host.hidden = true; return; }
        const mentions = canvasMentions?.read() || [];
        const canvas = canvasAdapter?.context(mentions.map(item => item.id));
        const selected = canvas?.nodes.filter(node => canvas.summary.selectedIds.includes(node.id)) || [];
        const mentioned = mentions.map(mention => canvas?.nodes.find(node => node.id === mention.id)).filter(Boolean);
        const node = selected.length === 1 ? selected[0] : null;
        host.hidden = !selected.length && !mentioned.length;
        if (host.hidden) return;
        const copy = host.querySelector('.prompt-agent-node-context-copy');
        const selection = selected.length ? `当前选中：${selected.map(item => item.name).join('、')}。` : '';
        const citation = mentioned.length ? `本轮引用：${mentioned.map(item => item.name).join('、')}。` : '';
        const promptTarget = mentioned.find(item => item.type === 'ImageGenerate')
            || (!mentions.length && node?.type === 'ImageGenerate' ? node : null);
        const label = `${selection}${citation}${promptTarget ? promptSourceGuidance(preparedPromptSource(promptTarget)) : ''}`;
        if (copy && copy.textContent !== label) copy.textContent = label;
        const { input, modelSelect } = getElements();
        const message = input?.value?.trim() || '';
        const sendsToModel = !message.startsWith('/') && !isSelectedReferenceClearRequest(message) && !localAppRequest(message);
        const sources = sendsToModel ? getPromptAgentCanvasImagePreview({ canvasContext: canvas, message,
            contextNodeId: promptTarget?.id, referenceImages: pendingReferenceImages }) : [];
        const model = getUsableChatModels().find(item => item.id === modelSelect?.value);
        const textOnly = Boolean(model && (model.capabilities?.imageInput === false
            || getOpenAIChatCapabilities({ model, provider: selectedProvider(model, 'chat') })?.imageInput === false));
        renderCanvasImagePreview(host, sources, textOnly);
    }

    function renderCanvasImagePreview(host, sources, textOnly) {
        let details = host.querySelector('.prompt-agent-input-image-context');
        if (!sources.length) {
            if (details) { details.hidden = true; details.open = false; }
            return;
        }
        if (!details) {
            details = documentRef.createElement('details');
            details.className = 'prompt-agent-input-image-context';
            for (const tag of ['summary', 'ul', 'p']) details.appendChild(documentRef.createElement(tag));
            host.appendChild(details);
        }
        details.hidden = false;
        const key = JSON.stringify([sources, textOnly]);
        if (details.dataset.sources === key) return;
        details.dataset.sources = key;
        const [summary, list, help] = details.children;
        const count = sources.reduce((total, source) => total + (source.unavailable ? 0 : source.count), 0);
        summary.textContent = textOnly ? '画布图片 · 当前对话模型仅支持文字'
            : count ? `对话可读取的画布原图 · ${count} 张` : '画布图片 · 原图暂不可读';
        list.replaceChildren();
        for (const source of sources) {
            const item = documentRef.createElement('li');
            item.textContent = `${source.name} · ${source.purposes.join('、')}（${source.unavailable || `${source.count} 张`}）`;
            list.appendChild(item);
        }
        help.textContent = '此处列出选区和 @ 节点的图片来源。手动添加的图片显示在附件中，实际生图参考以方案为准。';
    }

    function insertPreparedNodeContext() {
        const node = preparedTarget();
        if (!node || !canvasMentions) { preparedNodeContext = null; renderPreparedNodeContext(); return false; }
        let changed = canvasMentions.append(node);
        const source = preparedPromptSource(node);
        if (source?.editable) changed = canvasMentions.append(source.node) || changed;
        renderPreparedNodeContext();
        return changed;
    }

    function prepareNodeContext(reference) {
        const input = getElements().input;
        if (!input || !canvasMentions || reference?.workflowId !== getWorkflowId()
            || !canvasAdapter?.context([reference.nodeId]).nodes.some(node => node.id === reference.nodeId)) return false;
        preparedNodeContext = { workflowId: reference.workflowId, nodeId: reference.nodeId };
        open();
        const empty = composerIsEmpty();
        insertPreparedNodeContext();
        if (empty) {
            const node = preparedTarget(), source = preparedPromptSource(node);
            input.value += source?.active && source.editable
                ? `请优化「${source.name || source.nodeId}」为「${node.name}」提供的提示词，修改对象为该文本来源，保留主体和现有参考关系。先提供方案，由我确认后再应用。`
                : source?.active
                    ? `请根据「${source.name || source.nodeId}」提供的提示词提出优化建议。${promptSourceGuidance(source)}保留主体和现有参考关系，先提供方案，由我确认后再调整。`
                    : '请优化这个生图节点的提示词，保留主体和现有参考关系。先提供方案，由我确认后再应用。';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        renderPreparedNodeContext(); input.focus();
        return true;
    }

    function composerIsEmpty() {
        return !getElements().input?.value.trim() && pendingReferenceImages.length === 0;
    }

    function renderPreparedImageRequest() {
        const host = documentRef.getElementById('prompt-agent-image-context');
        if (!host) return;
        const request = preparedImageRequest;
        const current = request && request.workflowId === getWorkflowId() && request.revision === workflowRevision
            && pendingReferenceImages.some(image => image.selectionKey === request.referenceId);
        host.hidden = !current;
        if (!current) { preparedImageRequest = null; return; }
        host.querySelector('span').textContent = `原图已加入附件：${request.name}。现有草稿保持，可主动插入修改请求。`;
        const action = documentRef.getElementById('prompt-agent-insert-image-request');
        action.disabled = getElements().input.value.includes(request.text);
    }

    async function prepareImageContext(reference, { edit = false } = {}) {
        if (reference?.workflowId !== getWorkflowId() || !referenceSource || !/^data:image\//i.test(reference.image || '')) return false;
        const revision = workflowRevision, input = getElements().input;
        const textBefore = input?.value || '', emptyBefore = composerIsEmpty();
        open();
        const stableAsset = reference.assetKey?.startsWith('media:') ? reference.assetKey : '';
        let identity = stableAsset || (reference.historyId ? `history:${reference.historyId}` : '');
        if (!identity) {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reference.image));
            identity = `image-data:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
        }
        if (revision !== workflowRevision || reference.workflowId !== getWorkflowId()) return false;
        const candidate = { ...createImageResultReferenceIdentity(reference, { fallbackIdentity: identity }),
            name: reference.name || '结果原图', resolvedImage: { name: reference.name || '结果原图', dataUrl: reference.image } };
        await toggleImportedReference(candidate, { toggle: false });
        if (revision !== workflowRevision || reference.workflowId !== getWorkflowId()) return false;
        const pending = pendingReferenceImages.find(image => image.selectionKey === candidate.referenceId);
        if (!pending || pending.loading || pending.error) return false;
        if (edit && input) {
            const text = `请以「${reference.name || '选中结果'}」这张原图为基础修改。先提供修改方案，由我确认后再应用或生成。`;
            if (emptyBefore && input.value === textBefore && pendingReferenceImages.length === 1) {
                input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                preparedImageRequest = { workflowId: reference.workflowId, revision, text, referenceId: candidate.referenceId, name: candidate.name };
            }
        }
        renderPreparedImageRequest(); input?.focus();
        return true;
    }
    function close() {
        const panel = getElements().panel;
        if (panel) surfaces?.closePopovers(panel);
        imageMentions?.close(); canvasViews.forEach(view => view.close()); setOpen(false);
    }
    function toggle() {
        const { panel } = getElements();
        if (panel?.classList.contains('active') && (!surfaces || surfaces.topModeless() === panel)) {
            if (surfaces) surfaces.closeModeless(panel);
            else close();
        }
        else open();
    }

    function choiceLabels(message) {
        if (isCreativeTaskConfirmation(message)) return ['是', '否'];
        return message?.role === 'agent' && message.intent === 'clarify' ? normalizePromptAgentChoices(message.choices) : null;
    }

    function refreshChoiceButtons(models) {
        if (!choiceView) return;
        const { message, buttons, localConfirmation } = choiceView;
        const pending = message.promptAgentMessageIndex === conversationStore.getLatestMessageIndex();
        models ??= getUsableChatModels();
        const selectedId = conversationStore.getChatModelId() || getSelectedModelId() || models[0]?.id;
        const available = models.some(model => model.id === selectedId);
        for (const button of buttons) {
            button.disabled = requestPending || !pending || (!available && !(localConfirmation && button.textContent === '否'));
        }
    }

    function appendChoices(message, turn) {
        const labels = choiceLabels(turn);
        if (!labels) return;
        const group = documentRef.createElement('div');
        group.className = 'prompt-agent-choices';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', '回答选项');
        const revision = workflowRevision;
        const buttons = labels.map(label => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'prompt-agent-choice';
            button.textContent = label;
            button.disabled = true;
            button.addEventListener('click', () => {
                if (button.disabled || revision !== workflowRevision || !message.isConnected) return;
                return submit({ choice: { questionIndex: message.promptAgentMessageIndex, label } });
            });
            group.appendChild(button);
            return button;
        });
        choiceView?.buttons.forEach(button => { button.disabled = true; });
        choiceView = { message, buttons, localConfirmation: isCreativeTaskConfirmation(turn) };
        message.appendChild(group);
    }

    function appendRequestFailure(message, failure) {
        const actions = documentRef.createElement('div');
        actions.className = 'prompt-agent-error-actions';
        let feedback;
        if (failure.retry) {
            const revision = workflowRevision, workflowId = getWorkflowId();
            const retryButton = documentRef.createElement('button');
            retryButton.className = 'btn btn-secondary';
            retryButton.type = 'button';
            retryButton.textContent = '重试';
            retryButton.dataset.agentRequestRetry = '';
            retryButton.disabled = requestPending || getUsableChatModels().length === 0;
            feedback = documentRef.createElement('p');
            feedback.className = 'prompt-agent-retry-status';
            feedback.setAttribute('role', 'status');
            feedback.hidden = true;
            retryButton.addEventListener('click', () => {
                if (revision !== workflowRevision || workflowId !== getWorkflowId() || !message.isConnected || requestPending) return;
                const current = conversationStore.getMessage(message.promptAgentMessageIndex)?.requestFailure?.retry;
                const original = current && conversationStore.getMessage(current.messageIndex);
                if (original?.role !== 'user' || current.messageIndex >= message.promptAgentMessageIndex) return;
                const showBlocked = reason => { feedback.textContent = reason; feedback.hidden = false; };
                if (message.promptAgentMessageIndex !== conversationStore.getLatestMessageIndex()) {
                    showBlocked('对话已有后续消息，请在输入框核对上下文后重新发送。');
                    return;
                }
                feedback.hidden = true;
                void submit({ resendMessage: original, resendMessageIndex: current.messageIndex, retry: current,
                    onRetryBlocked: showBlocked });
            });
            actions.appendChild(retryButton);
        }
        if (failure.status) {
            const details = documentRef.createElement('details');
            const summary = documentRef.createElement('summary');
            summary.textContent = '错误详情';
            const diagnostic = documentRef.createElement('p');
            diagnostic.textContent = `HTTP ${failure.status}`;
            details.appendChild(summary);
            details.appendChild(diagnostic);
            actions.appendChild(details);
        }
        message.appendChild(actions);
        if (feedback) message.appendChild(feedback);
    }

    function appendMessage(role, text, workSummary = [], { record = true, promptPlan = null, canvasPlan = null, nodeMentions = [], referenceImages = [], contextImages = [], intent, search, choices, requestFailure, batch = null } = {}) {
        const messages = batch?.target || getElements().messages;
        if (!messages) return null;
        const followLatest = !batch && messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32;
        if (!batch) messages.querySelector?.('.prompt-agent-empty')?.remove?.();
        const message = documentRef.createElement('article');
        message.className = `prompt-agent-message prompt-agent-message-${role}`;
        message.setAttribute('data-role', role);
        message.setAttribute('aria-label', role === 'user' ? '用户消息' : requestFailure ? 'Agent 请求失败' : 'Agent 回复');

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
        if (requestFailure) {
            message.classList.add('prompt-agent-message-error');
            const title = documentRef.createElement('strong');
            title.className = 'prompt-agent-error-title';
            title.textContent = '请求未完成';
            body.appendChild(title);
            const reason = documentRef.createElement('p');
            reason.textContent = agentRequestFailureText(requestFailure);
            body.appendChild(reason);
        } else if (role === 'agent') renderAgentBody({ documentRef, body, text, sources: search?.sources || [] });
        else body.textContent = text;
        message.appendChild(body);
        if (requestFailure) appendRequestFailure(message, requestFailure);
        appendChoices(message, { role, text, intent, choices });
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
            references.setAttribute('aria-label', '你发送的图片');
            const label = documentRef.createElement('span');
            label.className = 'prompt-agent-attachment-label';
            label.textContent = `你发送的图片 · ${referenceImages.length} 张`;
            label.style.flexBasis = '100%';
            references.appendChild(label);
            appendReferencePreviews(references, referenceImages);
            message.appendChild(references);
        }
        const attachmentSources = new Set(referenceImages.map(image => image.dataUrl).filter(Boolean));
        const visibleContextImages = contextImages.filter(image => !image.dataUrl || !attachmentSources.has(image.dataUrl));
        if (visibleContextImages.length) appendContextImagePreviews(message, visibleContextImages);
        if (role === 'user') {
            const revision = workflowRevision;
            message.appendChild(createUserMessageActions({ documentRef, text, onNativeClipboardWrite,
                disabled: batch?.resendDisabled ?? (requestPending || getUsableChatModels().length === 0),
                onResend: () => {
                    if (revision !== workflowRevision || !message.isConnected || requestPending) return;
                    const current = conversationStore.getMessage(message.promptAgentMessageIndex);
                    if (current?.role !== 'user') return;
                    void submit({ resendMessage: current, resendMessageIndex: message.promptAgentMessageIndex });
                }
            }));
        }
        messages.appendChild(message);
        if (!batch) {
            contentObserver?.observe?.(message);
            if (followLatest || followLatestContent) scrollToLatest();
            else updateScrollBottomButton();
        }
        if (record) {
            message.promptAgentMessageIndex = conversationStore.append({ role, text, workSummary, promptPlan, canvasPlan, nodeMentions, referenceImages, ...(contextImages.length ? { contextImages } : {}), intent, search, choices, requestFailure });
            refreshChoiceButtons();
            conversationRevision += 1;
            onStateChange();
            if (commandMenuOpen) renderCommandMenu();
        }
        return message;
    }

    function appendContextImagePreviews(message, images) {
        const strip = documentRef.createElement('div');
        strip.className = 'prompt-agent-message-references prompt-agent-message-context-images';
        strip.setAttribute('aria-label', 'Agent 自动读取的上下文');
        const details = documentRef.createElement('details');
        const summary = documentRef.createElement('summary');
        summary.textContent = `Agent 自动读取的上下文 · ${images.length} 张`;
        details.appendChild(summary);
        const explanation = documentRef.createElement('p');
        explanation.textContent = '这些图片由 Agent 自动读取，用于理解对话；本次生图使用的参考图以方案为准。';
        details.appendChild(explanation);
        const previews = documentRef.createElement('div');
        previews.className = 'prompt-agent-message-references';
        appendReferencePreviews(previews, images, { snapshot: true });
        details.appendChild(previews);
        strip.appendChild(details);
        message.insertBefore(strip, message.querySelector('.prompt-agent-message-actions'));
    }

    function formatPlan(plan) {
        const parts = [`Prompt\n${plan.prompt || '—'}`];
        if (typeof plan.negativePrompt === 'string') parts.push(`Negative Prompt\n${plan.negativePrompt || '清空'}`);
        const parameters = Object.entries(plan.parameters || {})
            .filter(([, value]) => value !== '' && value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
        if (parameters.length) parts.push(`参数\n${parameters.join(' · ')}`);
        if (plan.parameterSources) parts.push(Object.entries(plan.parameterSources).map(([key, source]) => `${key}：${source}`).join(' · '));
        if (plan.referenceImages?.length) {
            const roleNames = { 'edit-target': '编辑目标', reference: '参考', supporting: '合成素材' };
            const roles = plan.referenceImages.filter((image) => roleNames[image.role])
                .map((image, index) => `图 ${index + 1} · ${image.name || `图片 ${index + 1}`}：${roleNames[image.role]}${image.purpose ? `（${image.purpose}）` : ''}`);
            parts.push([`本次生图参考图\n${plan.referenceImages.length} 张`, ...roles].join('\n'));
        }
        return parts.join('\n\n');
    }

    function appendPromptPlan(message, plan, runs = []) {
        if (!message || !plan) return;
        if (canvasAdapter && !runs.some(run => run.status === 'running')) {
            try {
                const graph = promptPlanToCanvas(plan, canvasAdapter.context());
                canvasAdapter.prepare(graph);
                if (conversationStore.upgradePromptPlan(message.promptAgentMessageIndex, graph)) {
                    onStateChange(); appendCanvasPlan(message, graph);
                    return { isCurrent: () => false, running: false, retryButtons: new Set(), sync() {} };
                }
            } catch { /* Missing legacy inputs remain visible and are validated by the existing action. */ }
        }
        const revision = workflowRevision;
        const resolvePlanSize = (model) => {
            const context = nodeAdapter?.getContext?.(plan.targetNodeId);
            const sameModel = !context?.model || context.model.modelId === model.modelId && context.model.protocol === model.protocol;
            return resolveDraftImageSize({ protocol: getEffectiveProtocol(model, selectedProvider(model, 'image')), modelId: model.modelId,
                current: sameModel ? context?.parameters : {}, defaults: conversationStore.getSize(model.id), parameters: plan.parameters,
                sizeIntent: plan.sizeIntent, answer: plan.sizeAnswer, sources: plan.parameterSources });
        };
        const resolvePlanParameters = model => resolveAgentParameterPatch(plan.parameters, plan.parameterSources,
            imageParameterCapabilities(model, selectedProvider(model, 'image')).parameters, plan.parameterAnswers,
            nodeAdapter?.getContext?.(plan.targetNodeId)?.parameters);
        // Target creation is an explicit action, never a side effect of rendering
        // or canvas selection. Persist the binding before a potentially failed run.
        const preparePlan = () => {
            if (revision !== workflowRevision) throw new Error('工作流或上下文已变化，请使用当前方案。');
            const model = getSelectedImageModel();
            if (!model) throw new Error('请先选择一个可用的生图模型。');
            const size = resolvePlanSize(model);
            const sizedPlan = { ...plan, parameters: replaceAgentSizeFields(resolvePlanParameters(model), size.patch) };
            const creatingTarget = !plan.targetNodeId;
            const prepared = nodeAdapter?.ensureTarget ? nodeAdapter.ensureTarget(sizedPlan, { modelId: model.id, providerId: conversationStore.getProvider('image', model.id) }) : sizedPlan;
            if (!prepared?.targetNodeId) throw new Error('无法创建生图节点，请检查生图模型配置。');
            if (!conversationStore.bindPromptPlanTarget(message.promptAgentMessageIndex, prepared.targetNodeId)) {
                throw new Error('方案已变化，请重新整理方案。');
            }
            plan.targetNodeId = prepared.targetNodeId;
            conversationRevision += 1;
            onStateChange();
            if (creatingTarget) {
                try { executionAdapter?.focus?.(prepared.targetNodeId); } catch (error) { console.warn('无法定位新建节点', error); }
            }
            return plan;
        };
        const planElement = documentRef.createElement('section');
        planElement.className = 'prompt-agent-plan';
        planElement.textContent = formatPlan(plan);
        message.appendChild(planElement);

        const sizeStatus = documentRef.createElement('div'); sizeStatus.className = 'prompt-agent-size-clarification';
        const actions = documentRef.createElement('div');
        actions.className = 'prompt-agent-actions';
        const selectionKey = () => { const model = getSelectedImageModel();
            return model ? JSON.stringify([model.id, conversationStore.getProvider('image', model.id), selectedProvider(model, 'image').id, conversationStore.getSize(model.id)]) : ''; };
        const actionState = {
            appliedSelection: '',
            sizeIssue: null,
            answerSize(answer) {
                if (!this.isCurrent() || this.running || !this.sizeIssue) return false;
                const patch = typeof answer === 'string' ? parseSizeAnswer(answer) : answer; if (!patch) return false;
                plan.sizeAnswer = mergeAgentSizeAnswer(plan.sizeAnswer, patch);
                if (!plan.sizeIntent) plan.parameters = { ...plan.parameters, ...plan.sizeAnswer };
                conversationStore.setCreativeTask(confirmTaskParameters(conversationStore.getCreativeTask(), plan, patch));
                conversationStore.updatePromptPlan(message.promptAgentMessageIndex, plan);
                this.appliedSelection = ''; planElement.textContent = formatPlan(plan); planElement.appendChild(sizeStatus); this.sync(); onStateChange(); return true;
            },
            running: runs.some((run) => run.status === 'running'),
            retryButtons: new Set(),
            isCurrent: () => revision === workflowRevision,
            preparePlan,
            removeNodeReferences(removed) {
                if (!Array.isArray(plan.referenceImages)) return;
                const next = plan.referenceImages.filter((image) => !removed.has(image.sourceNodeId));
                if (next.length === plan.referenceImages.length) return;
                plan.referenceImages = next;
                planElement.textContent = formatPlan(plan); planElement.appendChild(sizeStatus);
                this.appliedSelection = '';
                this.sync();
            },
            sync() {
                const model = getSelectedImageModel();
                const available = this.isCurrent() && Boolean(nodeAdapter) && Boolean(model);
                let sizeError = null;
                this.sizeIssue = null; clearElement(sizeStatus);
                if (model) try {
                    const size = resolvePlanSize(model);
                    resolvePlanParameters(model);
                    sizeStatus.textContent = size.summary;
                } catch (error) {
                    sizeError = error; this.sizeIssue = error.sizeClarification ? error : null;
                    const text = documentRef.createElement('p'); text.textContent = error.message; sizeStatus.appendChild(text);
                    for (const choice of error.sizeClarification?.choices || []) {
                        const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary'; button.textContent = choice.label; button.disabled = this.running;
                        const field = error.sizeClarification.kind === 'aspect' ? 'aspectRatio' : 'resolution';
                        button.addEventListener('click', () => this.answerSize({ [field]: choice.value })); sizeStatus.appendChild(button);
                    }
                    for (const choice of error.parameterClarification?.choices || []) {
                        const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = choice.label; button.disabled = this.running;
                        button.addEventListener('click', () => {
                            if (!this.isCurrent() || this.running) return;
                            plan.parameterAnswers = { ...plan.parameterAnswers, [error.parameterClarification.field]: choice.value };
                            conversationStore.setCreativeTask(confirmTaskParameters(conversationStore.getCreativeTask(), plan,
                                { [error.parameterClarification.field]: choice.value }));
                            conversationStore.updatePromptPlan(message.promptAgentMessageIndex, plan); this.sync(); onStateChange();
                        });
                        sizeStatus.appendChild(button);
                    }
                }
                const applied = Boolean(model && this.appliedSelection === selectionKey());
                applyButton.disabled = applied || this.running || !available || Boolean(sizeError);
                generateButton.disabled = this.running || !available || !executionAdapter || Boolean(sizeError);
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
                || (actionState.appliedSelection && actionState.appliedSelection === selectionKey())) return;
            try {
                if (!nodeAdapter?.applyPromptPlan?.(preparePlan())) {
                    throw new Error('目标节点或可用参数已变化，请基于当前节点重新整理方案。');
                }
                actionState.appliedSelection = selectionKey();
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
        planElement.appendChild(sizeStatus);
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
        if (removed.has(preparedNodeContext?.nodeId)) { preparedNodeContext = null; renderPreparedNodeContext(); }
        if (activeOperation) {
            activeOperation.removedReferenceNodeIds ||= new Set();
            nodeIds.forEach((id) => activeOperation.removedReferenceNodeIds.add(id));
        }
        pendingReferenceImages.filter(image => removed.has(image.sourceNodeId)).forEach(removePendingReference);
        for (const [token, { image }] of undoneImageMentions) {
            if (removed.has(image.sourceNodeId)) undoneImageMentions.delete(token);
        }
        referencePickerError = '';
        const changed = conversationStore.removeNodeReferences(nodeIds);
        for (const actionState of promptPlanActionStates) actionState.removeNodeReferences(removed);
        // Update only reference strips, retaining running result views and scroll position.
        const { messages } = getElements();
        messages?.querySelectorAll('.prompt-agent-message-references').forEach((strip) => {
            strip.querySelectorAll('.prompt-agent-reference').forEach((item) => {
                if (removed.has(item.dataset.sourceNodeId)) item.remove();
            });
            const count = strip.querySelectorAll('.prompt-agent-reference').length;
            if (!count) { strip.remove(); return; }
            const label = strip.querySelector('.prompt-agent-attachment-label');
            if (label) label.textContent = `你发送的图片 · ${count} 张`;
            const summary = strip.querySelector('summary');
            if (summary) summary.textContent = `Agent 自动读取的上下文 · ${count} 张`;
            strip.querySelectorAll('.prompt-agent-reference-number').forEach((number, index) => {
                if (!number.dataset.mentionToken) number.textContent = String(index + 1);
            });
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
        refreshRunViews(runId);
        return true;
    }

    function readRun(workflowId, runId, revision) {
        let found = null;
        mutateRun(workflowId, runId, (run) => { found = { ...run }; return false; }, revision);
        return found;
    }

    function completionText(result) {
        return result.persistenceStatus === 'failed'
            ? `生成完成，但保存失败：${result.persistenceError || '请重试保存'}` : '生成完成';
    }

    function renderCompletedRun(runState, result, images = result?.images || []) {
        clearElement(runState);
        runState.textContent = completionText(result);
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
                    dataUrl: source, name: `生成结果 ${index + 1}`, image,
                    isCurrent: () => revision === workflowRevision && image.isConnected
                });
                if (!dragToken) { event.preventDefault(); return; }
                dragged = true;
                event.stopPropagation?.();
            });
            image.addEventListener('dragend', () => endAgentResultDrag(dragToken));
            const preview = () => openResultPreview(images.filter(Boolean), images.slice(0, index).filter(Boolean).length, {
                onClose: () => {
                    if (revision === workflowRevision && image.isConnected && !image.closest('[inert]')) image.focus({ preventScroll: true });
                }
            });
            image.addEventListener('click', () => { if (!dragged) preview(); });
            image.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                preview();
            });
            if (createImageResultActions) {
                const wrapper = documentRef.createElement('div');
                wrapper.className = 'prompt-agent-image-result';
                const actions = createImageResultActions({
                    name: `生成结果 ${index + 1}`, assetKey: result.mediaAssetKeys?.[index],
                    runId: result.runId, sourceImageIndex: index,
                    readOriginal: async () => source,
                    isCurrent: () => revision === workflowRevision && wrapper.isConnected
                }, { compact: true });
                wrapper.append(image, actions.element);
                runState.appendChild(wrapper);
            } else runState.appendChild(image);
        });
    }

    function loadVisibleResult(element) {
        if (!getElements().panel?.classList.contains('active')) return;
        const load = resultLoaders.get(element);
        if (!load) return;
        resultLoaders.delete(element);
        resultObserver?.unobserve(element);
        load();
    }

    function observeResult(view, media) {
        const { element } = view;
        resultLoaders.set(element, () => {
            media.loading = true;
            element.textContent = '正在读取生成结果…';
            void Promise.resolve().then(() => loadResultImages(media.keys)).catch(() => []).then(sources => {
                media.images = media.keys.map((_, index) => sources?.[index] || null);
                if (runViews.get(view.run.runId) === view && view.media === media) renderRunView(view, view.run);
            });
        });
        if (resultObserver === undefined) {
            const Observer = documentRef.defaultView?.IntersectionObserver;
            resultObserver = Observer ? new Observer(entries => {
                for (const entry of entries) if (entry.isIntersecting) loadVisibleResult(entry.target);
            }, { root: getElements().messages, rootMargin: '64px 0px' }) : null;
        }
        if (resultObserver) resultObserver.observe(element);
        else queueMicrotask(() => loadVisibleResult(element));
    }

    const sameItems = (previous, next) => previous === next
        || (Boolean(previous) && Boolean(next) && previous.length === next.length && previous.every((source, index) => source === next[index]));

    function renderRunView(view, run) {
        const { element, workflowId } = view;
        const transient = results.read(workflowId, run.runId);
        const canRetrySave = run.persistenceStatus === 'failed' || run.persistenceStatus === 'retained';
        const keys = run.mediaAssetKeys || [];
        view.run = run;
        if (run.status === 'completed' && !transient.images && keys.length) {
            if (!sameItems(view.media?.keys, keys)) view.media = { keys };
        } else {
            view.media = null;
            if (resultLoaders.delete(element)) resultObserver?.unobserve(element);
        }
        const images = transient.images || view.media?.images;
        const state = JSON.stringify([run.status, run.targetNodeId, run.error, run.persistenceStatus,
            run.persistenceError, keys, canRetrySave && transient.saving]);
        if (view.state === state && sameItems(view.images, images)) return;
        view.state = state;
        view.images = images;
        if (run.status === 'completed') {
            if (view.media && !images) {
                clearElement(element);
                element.textContent = view.media.loading ? '正在读取生成结果…' : completionText(run);
                if (!view.media.loading) observeResult(view, view.media);
                return;
            }
            renderCompletedRun(element, run, images || []);
            if (canRetrySave) {
                const retry = documentRef.createElement('button');
                retry.type = 'button';
                retry.className = 'btn btn-secondary';
                retry.textContent = '重试保存';
                retry.disabled = transient.saving;
                retry.addEventListener('click', () => results.retry(workflowId, run.runId));
                element.appendChild(retry);
            }
        } else if (run.status === 'failed' && view.canvasPlan) {
            clearElement(element);
            const details = documentRef.createElement('details'); details.className = 'prompt-agent-run-error';
            const summary = documentRef.createElement('summary');
            const step = view.canvasPlan.steps.find(item => (view.canvasPlan.bindings?.[item.id] || item.nodeId) === run.targetNodeId);
            summary.textContent = `${step?.title || '生成步骤'} · 失败记录`;
            const reason = documentRef.createElement('p'); reason.textContent = run.error || '请使用方案中的重试按钮';
            details.append(summary, reason); element.append(details);
        } else if (run.status === 'failed') {
            renderFailedRun(element, view.plan, run.error || '未知错误', view.actionState);
        } else {
            clearElement(element);
            element.textContent = run.status === 'running' ? '正在生成…' : run.status === 'stopped' ? '已停止' : '上次生成已中断';
            if (run.status === 'running') {
                const stop = documentRef.createElement('button');
                stop.type = 'button';
                stop.className = 'prompt-agent-run-stop';
                stop.textContent = '停止';
                stop.addEventListener('click', () => {
                    if (getWorkflowId() === workflowId) executionAdapter?.stop?.(run.targetNodeId);
                });
                element.appendChild(stop);
            }
        }
    }

    function refreshRunViews(runId) {
        if (runId) {
            const view = runViews.get(runId);
            if (!view) return;
            const run = conversationStore.getRun(runId);
            if (run) renderRunView(view, run);
            return;
        }
        if (runViews.size === 0) return;
        for (const run of conversationStore.getRuns()) {
            const view = runViews.get(run.runId);
            if (view) renderRunView(view, run);
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
        stopButton.className = 'prompt-agent-run-stop';
        stopButton.textContent = '停止';
        stopButton.addEventListener('click', () => {
            if (actionState.isCurrent() && plan.targetNodeId) executionAdapter.stop?.(plan.targetNodeId);
        });
        runState.appendChild(stopButton);
        if (actionState) {
            // A generation may switch this target to another model even if
            // execution later fails. An earlier apply badge is no longer valid.
            actionState.appliedSelection = '';
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
                        await results.save(workflowId, runId, entry);
                    }
                    return completion;
                }
            });
            if (result?.status === 'stopped') {
                mutateRun(workflowId, runId, (run) => { run.status = 'stopped'; }, revision);
            } else if (!retainedByRuntime) await results.save(workflowId, runId, result);
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
                refreshRunViews(runId);
            }
        }
    }

    function appendCanvasPlan(message, plan, runs = [], { local = false } = {}) {
        if (!canvasAdapter || !message) return;
        const revision = workflowRevision, workflowId = getWorkflowId();
        const isCurrent = () => revision === workflowRevision && getWorkflowId() === workflowId && message.isConnected !== false
            && (local || conversationStore.hasCanvasPlan(plan.id));
        const changed = (value = plan) => {
            if (local) return;
            const update = snapshot => {
                const message = [...(snapshot.archivedMessages || []), ...(snapshot.messages || [])].find(item => item.canvasPlan?.id === plan.id);
                if (!message) return false;
                if (value.templateId === plan.id) {
                    const instances = message.canvasPlan.instances ||= [];
                    const index = instances.findIndex(item => item.id === value.id);
                    const copy = JSON.parse(JSON.stringify(value));
                    if (value.discarded) { if (index >= 0) instances.splice(index, 1); }
                    else if (index < 0) instances.push(copy); else instances[index] = copy;
                } else message.canvasPlan = { ...JSON.parse(JSON.stringify(value)), instances: message.canvasPlan.instances || [] };
                return snapshot;
            };
            if (getWorkflowId() === workflowId && conversationStore.hasCanvasPlan(plan.id)) {
                const snapshot = update(conversationStore.snapshot());
                if (snapshot) {
                    const next = [...(snapshot.archivedMessages || []), ...snapshot.messages].find(item => item.canvasPlan?.id === plan.id).canvasPlan;
                    if (conversationStore.updateCanvasPlan(plan.id, next)) {
                        onStateChange();
                        for (const view of canvasViews) if (view.planId === plan.id) view.setInstances?.(next.instances || []);
                    }
                }
            } else mutateWorkflowConversation?.(workflowId, update);
        };
        const addRunView = (run, instance = plan.instances?.find(item => Object.values(item.bindings || {}).includes(run.targetNodeId)) || plan) => {
            const element = documentRef.createElement('section'); element.className = 'prompt-agent-run-state'; message.appendChild(element);
            const view = { element, workflowId, revision, canvasPlan: instance, plan: { targetNodeId: run.targetNodeId } };
            runViews.set(run.runId, view); renderRunView(view, run);
        };
        const view = renderCanvasPlan({ confirmedParameters: (plan,values,id) => { conversationStore.setCreativeTask(confirmTaskParameters(conversationStore.getCreativeTask(),plan,values,id)); onStateChange(); }, documentRef, parent: message, plan, adapter: canvasAdapter, getModels: getImageModels, getProviders, getProviderId: modelId => conversationStore.getProvider('image', modelId), getSize: modelId => conversationStore.getSize(modelId), preview: openResultPreview,
            getModelId: () => conversationStore.getImageModelId(), changed, isCurrent, configure: openModelSettings,
            run: async (plan, retry) => {
                if (!retry) plan.completedSteps = [];
                const attempt = { id: createRunId(), status: 'running', steps: [] };
                const resultRuns = new Map();
                for (const step of plan.steps.filter(step => step.execute !== false && (!retry || !plan.completedSteps?.includes(step.id)))) {
                    attempt.steps.push({ id: step.id, status: 'pending', ...canvasAdapter.executionRecord(plan, step.id) });
                    if (!['ImageGenerate', 'ImageResize', 'ImageMerge', 'ImageCompare'].includes(step.type)) continue;
                    const record = { runId: createRunId(), targetNodeId: plan.bindings[step.id], status: 'running', mediaAssetKeys: [] };
                    if (!conversationStore.beginRun(message.promptAgentMessageIndex, record)) throw new Error('会话已变化');
                    resultRuns.set(record.targetNodeId, record); activeRuns.set(runKey(workflowId, record.runId), true); addRunView(record, plan);
                }
                plan.runs.push(attempt); changed(plan);
                try {
                    const completion = await canvasAdapter.execute(plan, { retry, retainResults: async result => {
                        for (const entry of result.nodeResults || []) {
                            const record = resultRuns.get(entry.nodeId);
                            if (record && !entry.error && (entry.images?.length || entry.mediaAssetKeys?.length)) await results.save(workflowId, record.runId, entry);
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
                    changed(plan);
                    if (isCurrent()) for (const record of resultRuns.values()) refreshRunViews(record.runId);
                }
            }
        });
        canvasViews.add(view); runs.forEach(run => addRunView(run));
        return view;
    }

    function localAppRequest(text) {
        if (canvasAdapter && isSelectedReferenceClearRequest(text)) return { method: 'clear_selected_references' };
        return appActions && parseAgentAppRequest(text);
    }

    async function runLocalAppAction(action, input) {
        if (requestPending) return;
        const context = (action.method === 'clear_selected_references' || appActions?.usesCanvas(action.method))
            ? canvasAdapter?.context() : undefined;
        const operation = beginOperation('app');
        if (input) input.value = '';
        captureDraft(true);
        setOperationStatus(operation, '正在执行 CainFlow 操作…');
        try {
            const result = action.method === 'clear_selected_references' ? createSelectedReferenceClearReply(context)
                : await runAgentAppRequest(action, appActions, { context, isCurrent: () => isCurrentOperation(operation) });
            const message = typeof result === 'string' ? result : result.message;
            // App operations are local. Their inputs and results stay out of the
            // conversation passed to a Provider, including on later chat turns.
            if (isCurrentOperation(operation)) {
                const element = appendMessage('agent', message, [], { record: false });
                if (result.canvasPlan) appendCanvasPlan(element, result.canvasPlan, [], { local: true });
            }
            else if (action.method === 'create_workflow') notifyAppAction(message);
        } catch (error) {
            if (isCurrentOperation(operation)) appendMessage('agent', error?.message || 'CainFlow 操作失败。', [], { record: false });
        } finally {
            setOperationStatus(operation, '');
            finishOperation(operation);
        }
    }

    async function submit({ resendMessage = null, resendMessageIndex, choice = null, retry = null, onRetryBlocked = () => {} } = {}) {
        const { input } = getElements();
        const text = retry?.imageOnly ? '' : choice?.label ?? (resendMessage ? String(resendMessage.text || '') : input?.value?.trim());
        if (!choice && !resendMessage && text?.startsWith('/')) {
            await executeCommand(text.toLowerCase());
            return;
        }
        if (!choice && !resendMessage && mentionReplacementOperations.size) return;
        const localAction = !choice && !resendMessage && localAppRequest(text);
        if (localAction) return runLocalAppAction(localAction, input);
        const attachments = choice ? [] : resendMessage ? resendMessage.referenceImages || [] : pendingReferenceImages;
        const latestIndex = conversationStore.getLatestMessageIndex();
        const questionIndex = resendMessage ? (resendMessageIndex ?? 0) - 1 : latestIndex;
        const question = (choice || (!attachments.length && text === '否')) ? conversationStore.getMessage(questionIndex) : null;
        if (choice && (requestPending || choice.questionIndex !== latestIndex || !choiceLabels(question)?.includes(text))) return;
        if (!requestPending && text === '否' && isCreativeTaskConfirmation(question)) {
            if (!choice && !resendMessage && input) input.value = '';
            appendMessage('user', text);
            appendMessage('agent', '已保留当前创作任务。');
            return;
        }
        const choiceAnswer = choice ? { question: question.text, choice: text } : resendMessage?.choiceAnswer ?? null;
        const confirmedRequest = !attachments.length && (!resendMessage || Number.isInteger(resendMessageIndex))
            ? conversationStore.getConfirmedCreativeRequest(text, resendMessageIndex) : null;
        const requestText = confirmedRequest?.text ?? text;
        const confirmedNewTask = Boolean(confirmedRequest);
        // Do this immediately before reading the select value. This covers late
        // settings hydration and prevents an otherwise valid request from being
        // sent without a modelId.
        if (!choice && !confirmedRequest && !resendMessage && !requestPending && !pendingReferenceImages.length && text) {
            const latest = [...canvasViews].at(-1) || [...promptPlanActionStates].at(-1);
            if (latest?.answerSize?.(text)) {
                scrollToLatest();
                appendMessage('user', text);
                appendMessage('agent', '已更新待确认方案的尺寸，请检查方案后点击应用或生成。');
                input.value = ''; return;
            }
        }
        const models = renderModelOptions();
        if (requestPending || models.length === 0 || attachments.some((image) => image.loading || image.error)) return;
        if (!text && attachments.length === 0) return;
        const replyModelId = getElements().modelSelect?.value || getSelectedModelId() || models[0].id;
        if (choiceAnswer && !models.some(model => model.id === replyModelId)) return;
        const replyModel = models.find(model => model.id === replyModelId);
        const replyConfig = captureThinkingConfig(replyModelId);
        const explicitReferences = confirmedRequest?.referenceImages || attachments;
        if (retry && (explicitReferences.length !== retry.referenceCount
            || (resendMessage.contextImages?.length || 0) !== retry.contextImageCount)) {
            onRetryBlocked('原请求的部分图片已不可用，请核对后重新发送。');
            return;
        }
        if (retry) {
            const current = conversationStore.getCompactionContext();
            if (retry.messageIndex < (current.messageOffset || 0) + current.archivedMessages.length) {
                onRetryBlocked('原请求所在的上下文已压缩或清理，请重新发送。');
                return;
            }
        }
        const unboundMention = !choice && missingImageMention(requestText, explicitReferences);
        const mentionsImage = !choiceAnswer && Boolean(requestText?.match(IMAGE_MENTION)?.length);
        if (unboundMention) {
            if (retry) { onRetryBlocked(unavailableImageMentionMessage(unboundMention)); return; }
            referencePickerError = unavailableImageMentionMessage(unboundMention);
            renderPendingReferences();
            return;
        }
        const configuredModel = replyConfig?.model || replyModel;
        if (mentionsImage && configuredModel && (configuredModel.capabilities?.imageInput === false
            || getOpenAIChatCapabilities({ model: configuredModel, provider: selectedProvider(configuredModel, 'chat') })?.imageInput === false)) {
            if (retry) { onRetryBlocked('当前对话模型不支持图片输入，请切换到支持图片的模型。'); return; }
            referencePickerError = '当前对话模型不支持图片输入，请切换到支持图片的模型或移除图片提及。';
            renderPendingReferences();
            return;
        }
        const stagedReferences = attachments.slice();
        // Capture selection and explicit mentions at Send, before compression
        // or media reads can yield to a later canvas selection.
        const nodeMentions = confirmedRequest ? confirmedRequest.nodeMentions || []
            : resendMessage ? resendMessage.nodeMentions || [] : choice ? [] : canvasMentions?.read() || [];
        const includeSelection = !retry && !confirmedNewTask && !choiceAnswer;
        const canvasContext = canvasAdapter?.context(nodeMentions.map(item => item.id), { includeSelection }) || null;
        if (retry && canvasContext) {
            const required = [...retry.selectedIds, ...nodeMentions.map(item => item.id), retry.contextNodeId].filter(Boolean);
            if (required.some(id => !canvasContext.nodes.some(node => node.id === id))) {
                onRetryBlocked('原请求的画布节点已不可用，请核对后重新发送。');
                return;
            }
            canvasContext.summary = { ...canvasContext.summary, selectedIds: retry.selectedIds };
        }
        const selectedIds = canvasContext?.summary.selectedIds || [];
        const selectedContext = retry?.contextNodeId ? nodeAdapter?.getContext?.(retry.contextNodeId) : canvasContext
            ? (selectedIds.length === 1 ? nodeAdapter?.getContext?.(selectedIds[0]) : null)
            : includeSelection ? nodeAdapter?.getSelectedContext?.() : null;
        scrollToLatest();
        const operation = beginOperation('reply');
        const imageChoice = () => {
            const id = conversationStore.getImageModelId();
            return JSON.stringify([id, conversationStore.getProvider('image', id), conversationStore.getSize(id)]);
        };
        const imageChoiceAtSend = imageChoice();
        operation.model = JSON.parse(JSON.stringify(replyModel || {}));
        operation.config = replyConfig;
        operation.searchSettings = conversationStore.getSearchSettings();
        operation.sizeSettings = conversationStore.getSize(conversationStore.getImageModelId());
        operation.imageSizeCapabilities = imageSizeCapabilities();
        operation.imageParameterCapabilities = selectedImageParameterCapabilities();
        operation.canvasContext = canvasContext;
        operation.selectedContext = selectedContext;
        operation.autoCompactTokenLimit = getAutoCompactTokenLimit();
        operation.discardOverLimitContext = getDiscardOverLimitContext();
        operation.observation = tokenObservation;
        operation.text = text;
        operation.confirmedNewTask = confirmedNewTask;
        operation.choiceAnswer = choiceAnswer;
        operation.consumeDraft = !resendMessage && !choice;
        operation.referenceImages = (confirmedRequest?.referenceImages || stagedReferences).map(image => ({ ...image }));
        operation.stagedReferenceKeys = new Set(stagedReferences.map(getPromptAgentReferenceKey));
        const initialConversation = operation.store.getCompactionContext(retry?.messageIndex);
        const initialPlan = initialConversation.messages.findLast(message => message.promptPlan)?.promptPlan || initialConversation.previousPromptPlan;
        const initialCanvas = [...(initialConversation.archivedMessages || []), ...initialConversation.messages].findLast(message => message.canvasPlan)?.canvasPlan;
        const contextIds = new Set([...nodeMentions.map(item => item.id), ...selectedIds, initialPlan?.targetNodeId,
            ...(initialCanvas?.steps || []).map(step => step.nodeId || initialCanvas.bindings?.[step.id])].filter(Boolean));
        operation.nodeContexts = new Map([...contextIds].map(id => [id, nodeAdapter?.getContext?.(id)]));
        if (selectedContext?.nodeId) operation.nodeContexts.set(selectedContext.nodeId, selectedContext);
        operation.sceneDescriptions = new Map((nodeAdapter?.getSceneReferenceImages?.() || []).map(image => [image.sourceNodeId, image.description || '']));
        operation.contextReferences = referenceSource?.getContextReferences?.(initialConversation) || [];
        if (!operation.discardOverLimitContext) {
            try { operation.compaction = compactionSelection(replyModelId); }
            catch (error) { operation.compactionError = error; }
        }
        const resolveContext = conversation => {
            if (retry) return retry.contextNodeId ? selectedContext || null : null;
            const previousPlan = conversation.messages.findLast(message => message.promptPlan)?.promptPlan || conversation.previousPromptPlan;
            const previousCanvas = [...(conversation.archivedMessages || []), ...conversation.messages].findLast(message => message.canvasPlan)?.canvasPlan;
            const previousTargets = [...new Set((previousCanvas?.steps || []).filter(step => step.type === 'ImageGenerate')
                .map(step => step.nodeId || previousCanvas.bindings?.[step.id]).filter(Boolean))];
            const previousCanvasContext = previousTargets.length === 1 ? operation.nodeContexts.get(previousTargets[0]) : null;
            return (nodeMentions.length ? nodeMentions.map(item => operation.nodeContexts.get(item.id)).find(Boolean)
                : selectedContext || (!confirmedNewTask && !selectedIds.length ? previousCanvasContext : null))
                || (!confirmedNewTask && !nodeMentions.length && !selectedIds.length && previousPlan?.targetNodeId ? operation.nodeContexts.get(previousPlan.targetNodeId) : null)
                || null;
        };
        const fitContext = ({ conversation, message, referenceImages, workflowReferenceImages, confirmedNewTask, choiceAnswer }) =>
            fitPromptAgentContext({ model: operation.model, message, confirmedNewTask, choiceAnswer, context: resolveContext(conversation),
                autoCompactTokenLimit: operation.autoCompactTokenLimit, conversation, canvasContext, sizeSettings: operation.sizeSettings,
                imageSizeCapabilities: operation.imageSizeCapabilities, imageParameterCapabilities: operation.imageParameterCapabilities,
                searchAllowed: operation.searchSettings.mode !== 'off',
                referenceImages, workflowReferenceImages }, resolveContext, operation.observation);
        let completedSearch = null, pendingReply = null;
        try {
            if (!retry && !operation.discardOverLimitContext && compressionProgress(requestText, operation.model, operation).reached
                && !await autoCompact(operation, replyModelId, requestText)) return;
            if (!isLiveOperation(operation)) return;
            const remainingKeys = new Set(operation.store.getDraft().referenceImages.map(getPromptAgentReferenceKey));
            let referenceImages = operation.referenceImages.filter(image => (resendMessage || confirmedRequest || remainingKeys.has(getPromptAgentReferenceKey(image)))
                && !operation.removedReferenceNodeIds?.has(image.sourceNodeId))
                .map(image => image.sourceNodeId && operation.sceneDescriptions.has(image.sourceNodeId)
                    ? { ...image, description: operation.sceneDescriptions.get(image.sourceNodeId) } : image);
            if (!text && !referenceImages.length) return;
            const sizeDefaults = operation.sizeSettings;
            let workflowMemory = operation.store.getContext(retry?.messageIndex);
            // Snapshot before appending the current turn: preserve assistant drafts
            // and role boundaries without duplicating the new user request.
            let conversation = operation.store.getCompactionContext(retry?.messageIndex);
            let workflowReferenceImages = uniqueReferenceImages([
                ...operation.store.getReferenceImages(retry?.messageIndex),
                ...referenceImages,
                ...operation.contextReferences
            ]);
            if (referenceSource?.hydrateLatestResults) {
                const readRevision = conversationRevision;
                workflowReferenceImages = await referenceSource.hydrateLatestResults(workflowReferenceImages, {
                    isCurrent: () => isLiveOperation(operation) && (operation.workflowId || conversationRevision === readRevision)
                });
                if (!isLiveOperation(operation)) return;
                if (!workflowReferenceImages) throw new Error('读取图片期间对话已更新，请重试。');
            }
            if (mentionsImage && !resendMessage && !confirmedRequest) {
                const latestDraft = isCurrentOperation(operation) ? pendingReferenceImages : operation.store.getDraft().referenceImages;
                const latestMentions = new Map(latestDraft.filter(image => image.mentionToken)
                    .map(image => [image.mentionToken, getPromptAgentReferenceKey(image)]));
                referenceImages = referenceImages.filter(image => !image.mentionToken || latestMentions.get(image.mentionToken) === getPromptAgentReferenceKey(image));
            }
            referenceImages = referenceImages.filter(image => !operation.removedReferenceNodeIds?.has(image.sourceNodeId));
            workflowReferenceImages = workflowReferenceImages.filter(image => !operation.removedReferenceNodeIds?.has(image.sourceNodeId));
            const removedMention = mentionsImage && missingImageMention(requestText, referenceImages);
            if (removedMention) {
                setOperationStatus(operation, unavailableImageMentionMessage(removedMention));
                return;
            }
            let context;
            if (operation.discardOverLimitContext) {
                const fitted = fitContext({ conversation, message: requestText, confirmedNewTask, choiceAnswer, referenceImages, workflowReferenceImages });
                operation.discardedMessageCount = fitted.discardedMessageCount;
                ({ conversation, context, workflowReferenceImages } = fitted.request);
                workflowMemory = conversation.memory;
            } else context = resolveContext(conversation);
            operation.referenceImages = referenceImages;
            const userTurn = appendOperationMessage(operation, 'user', text || `添加了 ${referenceImages.length} 张参考图`, [],
                { choiceAnswer, ...(confirmedRequest ? {} : { referenceImages, nodeMentions }) });
            if (userTurn.index < 0) return;
            if (isCurrentOperation(operation)) {
                scrollToLatest();
                if (operation.processingElement) getElements().messages?.appendChild(operation.processingElement);
                scrollToLatest();
            }
            if (operation.consumeDraft && isCurrentOperation(operation)) {
                if (input.value.trim() === text) {
                    input.value = '';
                    undoneImageMentions.clear();
                    nextImageMentionNumber = 1;
                }
                renderPreparedNodeContext();
                pendingReferenceImages = pendingReferenceImages.filter(image => !stagedReferences.includes(image));
                referencePickerError = '';
                setReferencePickerOpen(false);
                closeCommandMenu();
                setCommandStatus();
                renderPendingReferences();
            }
            pendingReply = { messageIndex: userTurn.index, referenceCount: referenceImages.length, selectedIds,
                contextNodeId: context?.nodeId || '', imageOnly: !text };
            const reply = await createReply({
                canvasContext,
                message: requestText,
                confirmedNewTask,
                choiceAnswer,
                context,
                onContextImages: images => {
                    if (!isLiveOperation(operation)) return;
                    const slotKey = image => image.sourceNodeId ? `${image.sourceNodeId}:${image.sourceImageIndex || 0}` : image.dataUrl;
                    const shown = new Set(referenceImages.map(slotKey));
                    // Handing a result to Agent imports a new source node. Its
                    // original canvas slot can still enter automatic context;
                    // don't show that same image again beside its attachment.
                    // Keep distinct automatic batch slots, even with equal pixels.
                    const attachmentSources = new Set(referenceImages.map(image => image.dataUrl).filter(Boolean));
                    const snapshots = images.filter(image => {
                        if (operation.removedReferenceNodeIds?.has(image.sourceNodeId) || shown.has(slotKey(image))
                            || (image.dataUrl && attachmentSources.has(image.dataUrl))) return false;
                        shown.add(slotKey(image)); return true;
                    });
                    if (retry && (snapshots.length !== retry.contextImageCount || snapshots.some((image, index) => {
                        const original = resendMessage.contextImages[index];
                        return getPromptAgentReferenceKey(image) !== getPromptAgentReferenceKey(original) || image.dataUrl !== original.dataUrl;
                    }))) throw new Error('原请求的上下文图片已变化，请核对后重新发送。');
                    if (mutateOperationConversation(operation, store => store.updateContextImages(userTurn.index, snapshots)) === false) return;
                    if (!isCurrentOperation(operation)) return;
                    const visibleMessage = [...(getElements().messages?.children || [])]
                        .find(element => element.promptAgentMessageIndex === userTurn.index);
                    if (!visibleMessage) return;
                    visibleMessage.querySelector('.prompt-agent-message-context-images')?.remove();
                    if (snapshots.length) appendContextImagePreviews(visibleMessage, snapshots);
                    if (followLatestContent) scrollToLatest();
                },
                workflowMemory,
                autoCompactTokenLimit: operation.autoCompactTokenLimit,
                sizeSettings: sizeDefaults,
                imageSizeCapabilities: operation.imageSizeCapabilities,
                imageParameterCapabilities: operation.imageParameterCapabilities,
                conversation,
                referenceImages,
                workflowReferenceImages,
                modelId: replyModelId,
                config: operation.config,
                searchSettings: operation.searchSettings,
                onSearchStatus: status => { setOperationStatus(operation, status); if (isCurrentOperation(operation) && operation.processingLabel) operation.processingLabel.textContent = status || '正在处理…'; },
                signal: operation.controller.signal
            });
            pendingReply = null;
            if (!isLiveOperation(operation)) return;
            completedSearch = reply?.search || null;
            if (reply?.confirmNewTask) {
                if (confirmedNewTask) throw new Error('已确认开始新任务，但模型尚未给出方案。请重新发送刚才的回复。');
                throw new CreativeTaskConfirmationRequired();
            }
            if (reply?.promptPlan?.referenceImages?.some(image => operation.removedReferenceNodeIds?.has(image.sourceNodeId))
                || reply?.canvasPlan?.dependencies?.some(id => operation.removedReferenceNodeIds?.has(id))) {
                throw new Error('所选参考图已删除，请重新提出方案。');
            }
            if (canvasAdapter && reply?.promptPlan && !reply.canvasPlan) {
                const target = canvasContext.nodes.find(node => node.id === reply.promptPlan.targetNodeId);
                const explicitlyNamed = target && (nodeMentions.some(item => item.id === target.id)
                    || (reply.intent !== 'generate' && !reply.editsCurrentAttachment && selectedIds.includes(target.id))
                    || (requestText.includes(target.name) && canvasContext.nodes.filter(node => node.name === target.name).length === 1));
                reply.canvasPlan = promptPlanToCanvas({ ...reply.promptPlan, targetNodeId: explicitlyNamed ? reply.promptPlan.targetNodeId : null }, canvasContext, { message: requestText });
                setAgentCanvasApplicationMode(reply.canvasPlan, requestText);
                reply.promptPlan = null;
            }
            const nextTask = bindTaskToReply(reply, operation.creativeTask, requestText, {
                confirmedNewTask, canSetImageParameters: Boolean(operation.imageParameterCapabilities)
            });
            operation.processingElement?.remove();
            setOperationStatus(operation, '');
            mutateOperationConversation(operation, store => { store.setCreativeTask(nextTask); return true; });
            operation.observation = reply?.tokenObservation || null;
            if (isCurrentOperation(operation)) tokenObservation = reply?.tokenObservation || null;
            if (reply?.canvasPlan) canvasAdapter.prepare(reply.canvasPlan);
            const agentMessage = appendOperationMessage(operation, 'agent', reply?.message || '已整理本轮回复。', reply?.workSummary || [], {
                promptPlan: reply?.promptPlan || null, canvasPlan: reply?.canvasPlan, intent: reply?.intent, search: reply?.search, choices: reply?.choices
            }).element;
            if (agentMessage) {
                if (reply?.canvasPlan) {
                    const view = appendCanvasPlan(agentMessage, reply.canvasPlan);
                    if (reply.canvasExecution && !resendMessage && !choiceAnswer) {
                        await view?.start(reply.canvasExecution, () => isCurrentOperation(operation) && imageChoice() === imageChoiceAtSend);
                    }
                }
                appendPromptPlan(agentMessage, reply?.promptPlan);
                setCommandStatus();
            }
            if (operation.discardOverLimitContext && isLiveOperation(operation)) {
                const fitted = fitContext({ conversation: operation.store.getCompactionContext(),
                    workflowReferenceImages: uniqueReferenceImages([...workflowReferenceImages, ...operation.store.getReferenceImages()]) });
                if (fitted.discardedMessageCount !== undefined) {
                    mutateOperationConversation(operation, store => { store.discardContextBefore(fitted.discardedMessageCount); return true; });
                }
            } else await autoCompact(operation, replyModelId);

        } catch (error) {
            if (!isLiveOperation(operation)) return;
            operation.processingElement?.remove();
            setOperationStatus(operation, '');
            const requestFailure = pendingReply && getAgentRequestFailure(error);
            if (requestFailure) {
                requestFailure.retry = { ...pendingReply,
                    contextImageCount: operation.store.getMessage(pendingReply.messageIndex)?.contextImages?.length || 0 };
                appendOperationMessage(operation, 'agent', agentRequestFailureText(requestFailure), [], { requestFailure });
                return;
            }
            appendOperationMessage(operation, 'agent', error?.message || 'Agent 暂时无法回复，请稍后重试。', [], {
                search: completedSearch,
                intent: error instanceof CreativeTaskConfirmationRequired ? CreativeTaskConfirmationRequired.intent : undefined
            });
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

    function setResizeControlsOpen(open) {
        const trigger = documentRef.getElementById('prompt-agent-resize-toggle');
        const controls = documentRef.getElementById('prompt-agent-resize-controls');
        if (!trigger || !controls || controls.hidden === !open) return;
        trigger.setAttribute('aria-expanded', String(open));
        controls.hidden = !open;
        if (open) surfaces?.openPopover('agent-resize', { element: controls, trigger, close: () => setResizeControlsOpen(false) });
        else surfaces?.forgetPopover('agent-resize');
    }

    function init() {
        if (initialized) return;
        panelManager?.register?.('agent', { close });
        const surfacePanel = getElements().panel;
        if (surfacePanel) surfaces?.registerModeless(surfacePanel, { close,
            isOpen: () => surfacePanel.classList.contains('active'), opener: () => getElements().button });
        const { messages, scrollBottomButton } = getElements();
        messages?.addEventListener('scroll', () => {
            if (messages.scrollTop < lastScrollTop - 1) followLatestContent = false;
            else if (messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 32) followLatestContent = true;
            lastScrollTop = messages.scrollTop; updateScrollBottomButton();
        }, { passive: true });
        messages?.addEventListener('wheel', event => { if(event.deltaY < 0) followLatestContent = false; }, {passive:true});
        messages?.addEventListener('keydown', event => { if(['ArrowUp','PageUp','Home'].includes(event.key)) followLatestContent = false; });
        messages?.addEventListener('click', event => {
            if (event.target.closest?.('.prompt-agent-canvas-plan details > summary')) followLatestContent = false;
        });
        contentObserver = resizeObserverFactory?.(() => {
            if (followLatestContent && messages?.clientHeight > 0) scrollToLatest();
            else updateScrollBottomButton();
        });
        messages?.addEventListener('load', updateScrollBottomButton, true);
        scrollBottomButton?.addEventListener('click', scrollToLatest);
        const MutationObserverClass = documentRef.defaultView?.MutationObserver;
        if (messages && MutationObserverClass) {
            new MutationObserverClass(updateScrollBottomButton).observe(messages, { childList: true, subtree: true, characterData: true });
        }
        if (documentRef.documentElement && MutationObserverClass) {
            new MutationObserverClass(() => {
                if (mentionReplacementOperations.size && documentRef.documentElement.dataset.canvasLoadState === 'loading') imageMentions?.close();
            }).observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-canvas-load-state'] });
        }
        const { button, closeButton, form, input, modelSelect, addModelButton, cancelButton, addReferenceButton, referencePickerClose } = getElements();
        const resizeHandle = documentRef.getElementById('prompt-agent-input-resize');
        const resizeToggle = documentRef.getElementById('prompt-agent-resize-toggle');
        const resizeControls = documentRef.getElementById('prompt-agent-resize-controls');
        let adjustInputHeight;
        let syncInputHeight;
        if (input && resizeHandle) {
            const transcript = surfacePanel?.querySelector?.('.prompt-agent-transcript');
            const view = documentRef.defaultView;
            const inputBounds = () => {
                const style = view?.getComputedStyle?.(input);
                const minHeight = parseFloat(style?.minHeight) || 42;
                if (!surfacePanel || !transcript || !form) return { minHeight, maxHeight: view?.innerHeight || 150 };
                const surroundingHeight = form.offsetTop - transcript.offsetHeight + form.offsetHeight - input.offsetHeight;
                const compactReserve = parseFloat(style?.getPropertyValue('--agent-input-reserved-height')) || 0;
                const maxHeight = Math.max(minHeight, surfacePanel.clientHeight - Math.max(surroundingHeight + minHeight, compactReserve));
                return { minHeight, maxHeight };
            };
            syncInputHeight = () => {
                if (!input.style?.height || !surfacePanel?.clientHeight) return;
                input.style.setProperty('--textarea-manual-max', `${inputBounds().maxHeight}px`);
            };
            const setHeight = height => {
                const { minHeight, maxHeight } = inputBounds();
                input.style.height = `${Math.max(minHeight, Math.min(maxHeight, height))}px`;
                syncInputHeight();
            };
            adjustInputHeight = direction => setHeight(input.getBoundingClientRect().height + direction * 12);
            let resizeStart = null;
            resizeHandle.addEventListener('pointerdown', event => {
                if (event.button !== 0 || resizeStart) return;
                event.preventDefault();
                resizeStart = { id: event.pointerId, y: event.clientY, height: input.getBoundingClientRect().height };
                resizeHandle.setPointerCapture?.(event.pointerId);
            });
            resizeHandle.addEventListener('pointermove', event => {
                if (resizeStart && resizeStart.id === event.pointerId) {
                    setHeight(resizeStart.height + resizeStart.y - event.clientY);
                }
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                resizeHandle.addEventListener(type, event => {
                    if (resizeStart?.id === event.pointerId) resizeStart = null;
                });
            }
            resizeHandle.addEventListener('keydown', event => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                adjustInputHeight(event.key === 'ArrowUp' ? 1 : -1);
            });
        }
        resizeToggle?.addEventListener('click', () => setResizeControlsOpen(resizeControls?.hidden));
        resizeControls?.addEventListener('click', event => {
            const action = event.target.closest('button');
            if (action?.dataset.resizeWidth) ensurePanelWidth().adjust(Number(action.dataset.resizeWidth));
            if (action?.dataset.resizeHeight) adjustInputHeight?.(Number(action.dataset.resizeHeight));
        });
        input?.addEventListener('input', renderPreparedNodeContext);
        input?.addEventListener('input', renderPreparedImageRequest);
        documentRef.getElementById('prompt-agent-insert-image-request')?.addEventListener('click', () => {
            renderPreparedImageRequest();
            if (!preparedImageRequest || !input || input.value.includes(preparedImageRequest.text)) return;
            input.value += `${input.value && !/\s$/.test(input.value) ? '\n' : ''}${preparedImageRequest.text}`;
            input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
        });
        button?.addEventListener('click', toggle);
        closeButton?.addEventListener('click', () => {
            if (surfaces && surfacePanel) surfaces.closeModeless(surfacePanel);
            else { close(); button?.focus?.(); }
        });
        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submit();
        });
        modelSelect?.addEventListener('change', () => {
            conversationStore.setChatModelId(modelSelect.value);
            setSelectedModelId(modelSelect.value);
            onStateChange();
            renderModelOptions();
            renderPreparedNodeContext();
            thinkingControls.forEach(control => control.refresh());
            if (commandMenuOpen) renderCommandMenu();
        });
        modelSelect?.addEventListener('focus', renderModelOptions);
        addModelButton?.addEventListener('click', () => configureProvider('chat', getSearchModels().find(model => model.id === modelSelect?.value)));
        const { imageModelSelect, addImageModelButton } = getElements();
        imageModelSelect?.addEventListener('change', () => {
            const modelId = imageModelSelect.value;
            if (modelId && !getImageModels().some((model) => model.id === modelId)) return;
            conversationStore.setImageModelId(modelId);
            onStateChange();
            renderImageModelOptions();
        });
        imageModelSelect?.addEventListener('focus', renderImageModelOptions);
        addImageModelButton?.addEventListener('click', () => configureProvider('image', getSelectedImageModel()));
        input?.addEventListener('focus', renderModelOptions);
        input?.addEventListener('input', () => {
            reconcileImageMentions();
            renderCommandMenu({ resetSelection: true });
            updateSendButtonState();
            captureDraft(true);
        });
        if (input && documentRef.defaultView && (canvasAdapter || referenceImageCatalog)) {
            if (canvasAdapter) canvasMentions = createCanvasMentions({ input, adapter: canvasAdapter, close: () => imageMentions?.close() });
            imageMentions = bindImageMentionPicker({
                input, owner: getElements().panel, surfaces,
                getUpstream: getUpstreamMentionImages, getScene: getSceneMentionImages,
                readThumbnail: referenceImageCatalog?.readThumbnail,
                getMention: getImageMention,
                readMentionThumbnail: async ({ original, previewUrl }) => original ? await createMentionThumbnail(original) || original : previewUrl,
                getExtraChoices: canvasAdapter ? () => canvasAdapter.context().nodes.map(node => ({
                    id: node.id, name: node.name, kind: 'node', description: node.type, sourceNodeId: node.id,
                    searchText: node.id, node
                })) : undefined,
                onSelect: (candidate, context) => context.mode === 'extra'
                    ? canvasMentions.remember(candidate.node) : selectMentionImage(candidate, context)
            });
        }
        input?.addEventListener('keydown', async (event) => {
            if (event.isComposing || event.keyCode === 229 || (event.key === 'Enter' && event.shiftKey)) return;
            if (event.key === 'Enter' && event.repeat) { event.preventDefault(); return; }
            if (event.key === 'Tab' && commandMenuOpen) { closeCommandMenu(); return; }
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
        for (const tab of REFERENCE_TABS) {
            const button = documentRef.getElementById(`prompt-agent-tab-${tab}`);
            button?.addEventListener('click', () => {
                referenceTab = tab; referenceLimit = 60;
                if (tab === 'history') void loadHistoryReferences();
                else renderReferencePicker();
            });
            button?.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const nextTab = event.key === 'Home' ? 'scene' : event.key === 'End' ? 'history'
                    : tab === 'scene' ? 'history' : 'scene';
                const target = documentRef.getElementById(`prompt-agent-tab-${nextTab}`);
                if (target === button) return;
                target?.click();
                target?.focus({ preventScroll: true });
            });
        }
        documentRef.getElementById('prompt-agent-reference-more')?.addEventListener('click', () => { referenceLimit += 60; renderReferencePicker(); });
        documentRef.getElementById('prompt-agent-reference-clear')?.addEventListener('click', () => {
            pendingReferenceImages.slice().forEach(removePendingReference);
            undoneImageMentions.clear();
            referencePickerError = '';
            renderPendingReferences();
            input?.focus?.();
        });
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
        const searchSection = documentRef.getElementById('prompt-agent-search-menu');
        for (const [purpose, select, models] of [['chat', modelSelect, getChatModels], ['image', imageModelSelect, getImageModels]]) {
            if (!select?.parentElement?.appendChild) continue;
            const isImage = purpose === 'image';
            let sizeSettings = null;
            const control = createThinkingControl({ documentRef, parent: select.parentElement, compact: true, showThinking: !isImage,
                title: isImage ? '生图模型生成尺寸设置' : '对话模型高级设置',
                summaryLabel: purpose === 'chat' ? '对话模型高级设置' : '生图模型生成尺寸设置',
                getOptions: () => { const model = models().find(item => item.id === select.value) || {}; return { model, provider: selectedProvider(model, purpose), task: purpose, protocol: model.protocol }; },
                getValue: () => isImage ? undefined : conversationStore.getThinking(purpose, select.value),
                onChange: value => { if (!isImage) conversationStore.setThinking(purpose, select.value, value); canvasViews.forEach(view => view.sync()); onStateChange(); },
                ...(!isImage ? {
                    onClose: () => searchMenu?.close(),
                    getExtraSummary: () => conversationStore.getSearchSettings().mode === 'off' ? '联网已关闭' : '联网已开启',
                    renderExtra: (content, popoverId) => {
                        if (searchSection) content.appendChild(searchSection);
                    }
                } : {}),
                ...(isImage ? {
                    getExtraSummary: () => sizeSettings?.getSummary?.() || '尺寸：自动',
                    renderExtra: (content, popoverId) => {
                        sizeSettings?.destroy();
                        sizeSettings = createAgentSizeSettings({ documentRef, parent: content, popoverId,
                            getModel: () => getImageModels().find(model => model.id === conversationStore.getImageModelId()),
                            getProvider: model => model ? selectedProvider(model, 'image') : null,
                            getValue: id => conversationStore.getSize(id),
                            onChange: (id, value) => { conversationStore.setSize(id, value); thinkingControls.forEach(control => control.refresh()); canvasViews.forEach(view => view.sync()); onStateChange(); }
                        });
                    }
                } : {}) });
            thinkingControls.push(control);
            if (!isImage) chatSettingsControl = control;
        }
        setOpen(false);
        searchMenu = createAgentSearchMenu({ documentRef,
            getCurrentModel: () => getChatModels().find(model => model.id === getElements().modelSelect?.value),
            getSettings: conversationStore.getSearchSettings, setSettings: conversationStore.setSearchSettings,
            onChange: () => { tokenObservation = null; chatSettingsControl?.refresh(); onStateChange(); }
        });
        modelMenus = createPromptAgentModelMenus({ documentRef, selects: [{ select: modelSelect, route: providerRoute('chat', getChatModels) },
            { select: getElements().imageModelSelect, route: providerRoute('image', getImageModels) }
        ] });
        bindPromptAgentCanvasDismiss({ documentRef, close });
        const { panel } = getElements();
        ensurePanelWidth();
        resizeObserver = resizeObserverFactory?.(() => {
            syncInputHeight?.();
            syncComposerPopovers();
            updateScrollBottomButton();
        }) || null;
        if (panel) resizeObserver?.observe?.(panel);
        if (form) resizeObserver?.observe?.(form);
        if (messages) contentObserver?.observe?.(messages);
        initialized = true;
    }

    function renderConversation() {
        choiceView = null;
        canvasViews.forEach(view => view.destroy()); canvasViews.clear();
        searchViewRevision += 1;
        searchViewCleanups.forEach(cleanup => cleanup()); searchViewCleanups = [];
        const { messages } = getElements();
        if (!messages) return;
        promptPlanActionStates.clear();
        runViews.clear();
        resultObserver?.disconnect();
        resultLoaders.clear();
        contentObserver?.disconnect?.();
        contentObserver?.observe?.(messages);
        clearElement(messages);
        const snapshot = conversationStore.snapshot();
        const transcript = [...(snapshot.archivedMessages || []), ...snapshot.messages];
        if (transcript.length === 0) {
            const empty = documentRef.createElement('div');
            empty.className = 'prompt-agent-empty';
            const title = documentRef.createElement('h3'); title.textContent = '想创作什么画面？';
            const help = documentRef.createElement('p'); help.textContent = '描述主体、风格和用途。说「先预览方案」可先审阅。「直接新建并运行」可执行符合条件的新方案。修改、删除已有节点或断开已有连线仍需确认。';
            empty.appendChild(title); empty.appendChild(help);
            for (const [label, text] of [
                ['插入产品摄影示例', '帮我规划一张产品摄影图：主体是一只白色陶瓷杯，柔和自然光，简洁背景，用于商品展示。请先预览方案。'],
                ['插入人物肖像示例', '帮我规划一张人物肖像：自然表情，电影光线，暖色背景。请先预览方案。']
            ]) {
                const example = documentRef.createElement('button'); example.type = 'button'; example.textContent = label;
                example.addEventListener('click', () => {
                    const input = getElements().input;
                    if (!input) return;
                    input.focus();
                    const end = input.value.length;
                    input.setSelectionRange?.(end, end);
                    insertPastedText(`${end ? '\n\n' : ''}${text}`);
                });
                empty.appendChild(example);
            }
            messages.appendChild(empty);
            updateScrollBottomButton();
            return;
        }
        const batch = { target: documentRef.createDocumentFragment?.() || messages,
            resendDisabled: requestPending || getUsableChatModels().length === 0 };
        const renderedMessages = transcript.map(item => appendMessage(item.role, item.text, item.workSummary || [], {
            record: false,
            batch,
            intent: item.intent,
            choices: item.choices,
            search: item.search,
            requestFailure: item.requestFailure,
            referenceImages: item.referenceImages || [],
            contextImages: item.contextImages || []
        }));
        if (batch.target !== messages) messages.appendChild(batch.target);
        // Plan actions check that their message belongs to the live transcript.
        transcript.forEach((item, index) => {
            const message = renderedMessages[index];
            if (!message) return;
            message.promptAgentMessageIndex = index;
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
            contentObserver?.observe?.(message);
        });
        refreshChoiceButtons();
        scrollToLatest();
    }

    function restoreWorkflow(value) {
        const previous = pendingOperations.get(visibleWorkflowId);
        if (previous && isLiveOperation(previous)) previous.store.restore(snapshotWorkflow());
        thinkingControls.forEach(control => control.close());
        canvasMentions?.clear(); canvasViews.forEach(view => view.destroy()); canvasViews.clear();
        preparedNodeContext = null; renderPreparedNodeContext();
        preparedImageRequest = null; renderPreparedImageRequest();
        if (!getWorkflowId()) cancelRequest({ silent: true });
        visibleWorkflowId = getWorkflowId();
        activeOperation = pendingOperations.get(visibleWorkflowId) || null;
        requestPending = Boolean(activeOperation);
        workflowRevision += 1;
        importQueue = Promise.resolve();
        historyReferences = []; historyLoading = false; historyError = '';
        referenceTab = 'scene'; referenceLimit = 60;
        pendingReferenceImages = [];
        undoneImageMentions.clear();
        mentionReplacementOperations.clear();
        referencePickerError = '';
        setCommandStatus();
        conversationStore.restore(value);
        tokenObservation = activeOperation?.observation || null;
        const draft = conversationStore.getDraft();
        const input = getElements().input;
        if (input) input.value = draft.text;
        nextImageMentionNumber = (draft.text.match(IMAGE_MENTION) || []).reduce((next, token) => {
            const number = Number(token.slice('@图片'.length));
            return Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER ? Math.max(next, number + 1) : next;
        }, 1);
        pendingReferenceImages = draft.referenceImages.map(image => ({ ...image, selectionKey: image.referenceId }));
        for (const message of [...(value?.archivedMessages || []), ...(value?.messages || [])]) {
            if (message.canvasPlan) {
                const plan = JSON.parse(JSON.stringify(message.canvasPlan));
                const restore = value => {
                    delete value.historyId;
                    if (!canvasAdapter?.isRunning(value.id)) for (const attempt of value.runs || []) if (attempt.status === 'running') {
                        attempt.status = 'interrupted';
                        for (const step of attempt.steps || []) if (['pending', 'running'].includes(step.status)) step.status = 'interrupted';
                    }
                    (value.instances || []).forEach(restore);
                };
                restore(plan);
                conversationStore.updateCanvasPlan(plan.id, plan);
            }
            for (const run of message.runs || []) {
                if (['running', 'pending'].includes(run.status) && !activeRuns.has(runKey(getWorkflowId(), run.runId))) {
                    conversationStore.finishRun(run.runId, { status: 'interrupted' });
                }
            }
        }
        renderModelOptions();
        ensurePanelWidth().migrate(value?.panelWidth);
        renderConversation();
        renderPendingReferences();
        if (activeOperation) showProcessing(activeOperation);
        setCommandStatus(activeOperation?.status || workflowStatuses.get(visibleWorkflowId) || '');
        const cancel = getElements().cancelButton;
        if (cancel) cancel.hidden = !activeOperation;
        close();
    }

    function captureDraft(notify = false) {
        const changed = conversationStore.setDraft({ text: getElements().input?.value || '', referenceImages: pendingReferenceImages });
        if (changed && notify) onDraftChange();
    }

    function snapshotWorkflow() {
        captureDraft();
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
        init, open, close, toggle, submit, cancelRequest, cancelWorkflowRequest, cancelAllRequests, removeNodeReferences, prepareNodeContext, prepareImageContext, refreshPreparedNodeContext: renderPreparedNodeContext,
        hasRunningTasks: () => pendingOperations.size > 0 || activeRuns.size > 0,
        restoreWorkflow, snapshotWorkflow, syncWorkflowState, refreshActionStates, refreshResults: refreshRunViews, refreshModels: renderModelOptions
    };
}
