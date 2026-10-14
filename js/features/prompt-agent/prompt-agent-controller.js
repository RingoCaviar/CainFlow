import { createPromptAgentConversationStore } from './prompt-agent-conversation-store.js';

function uniqueReferenceImages(images = []) {
    const seen = new Set();
    return images.filter((image) => {
        const key = image?.dataUrl || `${image?.sourceNodeId || ''}:${image?.sourcePort || ''}:${image?.name || ''}`;
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
        message: context ? '已根据当前生图节点整理 Prompt Plan。' : '已整理 Prompt Plan；选择一个生图节点后即可应用。',
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
    nodeAdapter = null,
    executionAdapter = null,
    getChatModels = () => [],
    getSelectedModelId = () => '',
    setSelectedModelId = () => {},
    conversationStore = createPromptAgentConversationStore(),
    onStateChange = () => {},
    readReferenceFile = readImageFile,
    resizeObserverFactory = (callback) => typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null
} = {}) {
    let initialized = false;
    let resizeObserver = null;
    let workflowRevision = 0;
    let activeReplyController = null;
    let pendingReferenceImages = [];
    const promptPlanActionStates = new Set();

    function getElements() {
        return {
            button: documentRef.getElementById('btn-prompt-agent'),
            panel: documentRef.getElementById('prompt-agent-panel'),
            closeButton: documentRef.getElementById('btn-close-prompt-agent'),
            form: documentRef.getElementById('prompt-agent-form'),
            input: documentRef.getElementById('prompt-agent-input'),
            sendButton: documentRef.getElementById('prompt-agent-send'),
            cancelButton: documentRef.getElementById('prompt-agent-cancel'),
            modelSelect: documentRef.getElementById('prompt-agent-model'),
            messages: documentRef.getElementById('prompt-agent-messages'),
            references: documentRef.getElementById('prompt-agent-references')
        };
    }

    function renderModelOptions() {
        const { modelSelect } = getElements();
        if (!modelSelect) return;
        const models = getChatModels().filter((model) => model?.id && model?.modelId);
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
    }

    function appendReferencePreviews(container, referenceImages = [], { removable = false } = {}) {
        referenceImages.forEach((reference, index) => {
            const item = documentRef.createElement('span');
            item.className = 'prompt-agent-reference';
            const image = documentRef.createElement('img');
            image.src = reference.dataUrl;
            image.alt = reference.name || `参考图 ${index + 1}`;
            item.appendChild(image);
            if (removable) {
                const removeButton = documentRef.createElement('button');
                removeButton.type = 'button';
                removeButton.className = 'prompt-agent-reference-remove';
                removeButton.textContent = '×';
                removeButton.setAttribute('aria-label', `移除 ${image.alt}`);
                removeButton.addEventListener('click', () => {
                    pendingReferenceImages.splice(index, 1);
                    renderPendingReferences();
                });
                item.appendChild(removeButton);
            }
            container.appendChild(item);
        });
    }

    function renderPendingReferences() {
        const { references, form } = getElements();
        if (!references) return;
        clearElement(references);
        appendReferencePreviews(references, pendingReferenceImages, { removable: true });
        references.hidden = pendingReferenceImages.length === 0;
        form?.classList.toggle('has-reference-images', pendingReferenceImages.length > 0);
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
    }

    function open() { setOpen(true); }
    function close() { setOpen(false); }
    function toggle() {
        const { panel } = getElements();
        setOpen(!panel?.classList.contains('active'));
    }

    function appendMessage(role, text, workSummary = [], { record = true, promptPlan = null, referenceImages = [] } = {}) {
        const { messages } = getElements();
        if (!messages) return null;
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
        messages.scrollTop = messages.scrollHeight;
        if (record) {
            conversationStore.append({ role, text, workSummary, promptPlan, referenceImages });
            onStateChange();
        }
        return message;
    }

    function formatPlan(plan) {
        const parts = [`Prompt\n${plan.prompt || '—'}`];
        if (plan.negativePrompt) parts.push(`Negative Prompt\n${plan.negativePrompt}`);
        const parameters = Object.entries(plan.parameters || {})
            .filter(([, value]) => value !== '' && value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${value}`);
        if (parameters.length) parts.push(`参数\n${parameters.join(' · ')}`);
        if (plan.referenceImages?.length) parts.push(`参考图\n${plan.referenceImages.length} 张`);
        return parts.join('\n\n');
    }

    function appendPromptPlan(message, plan) {
        if (!message || !plan) return;
        const hasValidTarget = () => {
            const selected = nodeAdapter?.getSelectedContext?.();
            return Boolean(plan.targetNodeId && selected?.nodeId === plan.targetNodeId);
        };
        const planElement = documentRef.createElement('section');
        planElement.className = 'prompt-agent-plan';
        planElement.textContent = formatPlan(plan);
        message.appendChild(planElement);

        const actions = documentRef.createElement('div');
        actions.className = 'prompt-agent-actions';
        const actionState = {
            applied: false,
            running: false,
            sync() {
                const validTarget = hasValidTarget();
                applyButton.disabled = this.applied || !validTarget;
                generateButton.disabled = this.running || !validTarget || !executionAdapter;
            }
        };
        promptPlanActionStates.add(actionState);
        const applyButton = documentRef.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'btn btn-primary';
        applyButton.textContent = '应用到节点';
        applyButton.addEventListener('click', () => {
            if (!hasValidTarget()) {
                actionState.sync();
                return;
            }
            if (!nodeAdapter?.applyPromptPlan?.(plan)) return;
            applyButton.textContent = '已应用';
            actionState.applied = true;
            actionState.sync();
        });
        actions.appendChild(applyButton);

        const generateButton = documentRef.createElement('button');
        generateButton.type = 'button';
        generateButton.className = 'btn btn-secondary';
        generateButton.textContent = '应用并生成';
        generateButton.addEventListener('click', async () => {
            if (!hasValidTarget()) {
                actionState.sync();
                return;
            }
            await runPromptPlan(message, plan, actions, null, actionState);
        });
        actions.appendChild(generateButton);
        message.appendChild(actions);
        actionState.applyButton = applyButton;
        actionState.generateButton = generateButton;
        actionState.sync();
    }

    function refreshActionStates() {
        promptPlanActionStates.forEach((actionState) => actionState.sync());
    }

    function clearElement(element) {
        if (typeof element.replaceChildren === 'function') element.replaceChildren();
        else if (Array.isArray(element.children)) element.children.length = 0;
    }

    function renderCompletedRun(runState, result) {
        clearElement(runState);
        runState.textContent = '生成完成';
        (result?.images || []).forEach((source) => {
            const image = documentRef.createElement('img');
            image.className = 'prompt-agent-result-image';
            image.src = source;
            image.alt = '生成结果';
            runState.appendChild(image);
        });
    }

    function renderFailedRun(runState, plan, message, actionState = null) {
        clearElement(runState);
        runState.textContent = `生成失败：${message}`;
        const retryButton = documentRef.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'btn btn-secondary';
        retryButton.textContent = '重试';
        retryButton.addEventListener('click', async () => runPromptPlan(runState.parentElement || null, plan, null, runState, actionState));
        const focusButton = documentRef.createElement('button');
        focusButton.type = 'button';
        focusButton.className = 'btn btn-ghost';
        focusButton.textContent = '返回节点';
        focusButton.addEventListener('click', () => executionAdapter?.focus?.(plan.targetNodeId));
        runState.appendChild(retryButton);
        runState.appendChild(focusButton);
    }

    async function runPromptPlan(message, plan, actions = null, existingRunState = null, actionState = null) {
        if (!executionAdapter || !plan?.targetNodeId) return;
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
        stopButton.addEventListener('click', () => executionAdapter.stop?.(plan.targetNodeId));
        runState.appendChild(stopButton);
        if (actionState) {
            actionState.running = true;
            actionState.sync();
        }
        Array.from(actions?.children || []).forEach((button) => { button.disabled = true; });
        try {
            const result = await executionAdapter.applyAndGenerate(plan);
            if (result?.status === 'stopped') {
                clearElement(runState);
                runState.textContent = '已停止';
            } else {
                renderCompletedRun(runState, result);
            }
        } catch (error) {
            renderFailedRun(runState, plan, error?.message || '未知错误', actionState);
        } finally {
            Array.from(actions?.children || []).forEach((button) => { button.disabled = false; });
            if (actionState) {
                actionState.running = false;
                actionState.sync();
            }
        }
    }

    async function submit() {
        const { input, sendButton, cancelButton } = getElements();
        const text = input?.value?.trim();
        const referenceImages = pendingReferenceImages.slice();
        if (!text && referenceImages.length === 0) return;
        const workflowMemory = conversationStore.getContext();
        const workflowReferenceImages = uniqueReferenceImages([
            ...conversationStore.getReferenceImages(),
            ...referenceImages
        ]);
        appendMessage('user', text || `添加了 ${referenceImages.length} 张参考图`, [], { referenceImages });
        const requestWorkflowRevision = workflowRevision;
        input.value = '';
        pendingReferenceImages = [];
        renderPendingReferences();
        if (sendButton) sendButton.disabled = true;
        if (cancelButton) cancelButton.hidden = false;
        const replyController = typeof AbortController === 'function' ? new AbortController() : null;
        activeReplyController = replyController;
        try {
            const context = nodeAdapter?.getSelectedContext?.() || null;
            const reply = await createReply({
                message: text,
                context,
                workflowMemory,
                referenceImages,
                workflowReferenceImages,
                modelId: getElements().modelSelect?.value || getSelectedModelId(),
                signal: replyController?.signal
            });
            if (requestWorkflowRevision !== workflowRevision) return;
            const agentMessage = appendMessage('agent', reply?.message || 'Prompt Plan 已就绪。', reply?.workSummary || [], { promptPlan: reply?.promptPlan || null });
            appendPromptPlan(agentMessage, reply?.promptPlan);
        } catch (error) {
            if (requestWorkflowRevision !== workflowRevision) return;
            appendMessage('agent', replyController?.signal.aborted ? '已取消本次 Agent 请求。' : (error?.message || 'Agent 暂时无法回复，请稍后重试。'));
        } finally {
            if (activeReplyController === replyController) activeReplyController = null;
            if (sendButton) sendButton.disabled = false;
            if (cancelButton) cancelButton.hidden = true;
        }
    }

    function init() {
        if (initialized) return;
        const { button, closeButton, form, modelSelect, cancelButton } = getElements();
        button?.addEventListener('click', toggle);
        closeButton?.addEventListener('click', close);
        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submit();
        });
        modelSelect?.addEventListener('change', () => setSelectedModelId(modelSelect.value));
        cancelButton?.addEventListener('click', () => activeReplyController?.abort());
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
        const { panel } = getElements();
        resizeObserver = resizeObserverFactory?.((entries) => {
            const width = entries?.[0]?.contentRect?.width || panel?.getBoundingClientRect?.().width;
            if (conversationStore.setPanelWidth(width)) onStateChange();
        }) || null;
        if (panel) resizeObserver?.observe?.(panel);
        initialized = true;
    }

    function renderConversation() {
        const { messages } = getElements();
        if (!messages) return;
        promptPlanActionStates.clear();
        clearElement(messages);
        const snapshot = conversationStore.snapshot();
        if (snapshot.messages.length === 0) {
            const empty = documentRef.createElement('p');
            empty.className = 'prompt-agent-empty';
            empty.textContent = '描述你想生成的画面。选择生图节点后可以应用 Prompt Plan。';
            messages.appendChild(empty);
            return;
        }
        snapshot.messages.forEach((item) => {
            const message = appendMessage(item.role, item.text, item.workSummary || [], {
                record: false,
                referenceImages: item.referenceImages || []
            });
            if (item.role === 'agent' && item.promptPlan) appendPromptPlan(message, item.promptPlan);
        });
    }

    function restoreWorkflow(value) {
        activeReplyController?.abort();
        workflowRevision += 1;
        pendingReferenceImages = [];
        conversationStore.restore(value);
        const { panel } = getElements();
        const width = conversationStore.snapshot().panelWidth;
        if (panel?.style) panel.style.width = width ? `${width}px` : '';
        renderConversation();
        renderPendingReferences();
        close();
    }

    function snapshotWorkflow() {
        const { panel } = getElements();
        const width = panel?.getBoundingClientRect?.().width;
        conversationStore.setPanelWidth(width);
        return conversationStore.snapshot();
    }

    return {
        init, open, close, toggle, submit, cancelRequest: () => activeReplyController?.abort(),
        restoreWorkflow, snapshotWorkflow, refreshActionStates
    };
}
