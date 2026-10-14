function buildDefaultReply({ message, context }) {
    const instruction = String(message || '').trim();
    const currentPrompt = String(context?.prompt || '').trim();
    const prompt = currentPrompt
        ? `${currentPrompt}\n\n调整要求：${instruction}`
        : instruction;
    return {
        message: context ? '已根据当前生图节点整理 Prompt Plan。' : '已整理 Prompt Plan；选择一个生图节点后即可应用。',
        workSummary: context ? ['读取当前生图节点', '整理提示词与生成参数'] : ['理解创作需求', '整理提示词方向'],
        promptPlan: {
            targetNodeId: context?.nodeId || null,
            prompt,
            negativePrompt: context?.negativePrompt || '',
            parameters: { ...(context?.parameters || {}) }
        }
    };
}

export function createPromptAgentController({
    documentRef = document,
    createReply = async (request) => buildDefaultReply(request),
    nodeAdapter = null,
    executionAdapter = null
} = {}) {
    let initialized = false;

    function getElements() {
        return {
            button: documentRef.getElementById('btn-prompt-agent'),
            panel: documentRef.getElementById('prompt-agent-panel'),
            closeButton: documentRef.getElementById('btn-close-prompt-agent'),
            form: documentRef.getElementById('prompt-agent-form'),
            input: documentRef.getElementById('prompt-agent-input'),
            sendButton: documentRef.getElementById('prompt-agent-send'),
            messages: documentRef.getElementById('prompt-agent-messages')
        };
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

    function appendMessage(role, text, workSummary = []) {
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
        messages.appendChild(message);
        messages.scrollTop = messages.scrollHeight;
        return message;
    }

    function formatPlan(plan) {
        const parts = [`Prompt\n${plan.prompt || '—'}`];
        if (plan.negativePrompt) parts.push(`Negative Prompt\n${plan.negativePrompt}`);
        const parameters = Object.entries(plan.parameters || {})
            .filter(([, value]) => value !== '' && value !== undefined && value !== null)
            .map(([key, value]) => `${key}: ${value}`);
        if (parameters.length) parts.push(`参数\n${parameters.join(' · ')}`);
        return parts.join('\n\n');
    }

    function appendPromptPlan(message, plan) {
        if (!message || !plan) return;
        const planElement = documentRef.createElement('section');
        planElement.className = 'prompt-agent-plan';
        planElement.textContent = formatPlan(plan);
        message.appendChild(planElement);

        const actions = documentRef.createElement('div');
        actions.className = 'prompt-agent-actions';
        const applyButton = documentRef.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'btn btn-primary';
        applyButton.textContent = '应用到节点';
        applyButton.disabled = !plan.targetNodeId;
        applyButton.addEventListener('click', () => {
            if (!nodeAdapter?.applyPromptPlan?.(plan)) return;
            applyButton.textContent = '已应用';
            applyButton.disabled = true;
        });
        actions.appendChild(applyButton);

        const generateButton = documentRef.createElement('button');
        generateButton.type = 'button';
        generateButton.className = 'btn btn-secondary';
        generateButton.textContent = '应用并生成';
        generateButton.disabled = !plan.targetNodeId || !executionAdapter;
        generateButton.addEventListener('click', async () => {
            await runPromptPlan(message, plan, actions);
        });
        actions.appendChild(generateButton);
        message.appendChild(actions);
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

    function renderFailedRun(runState, plan, message) {
        clearElement(runState);
        runState.textContent = `生成失败：${message}`;
        const retryButton = documentRef.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'btn btn-secondary';
        retryButton.textContent = '重试';
        retryButton.addEventListener('click', async () => runPromptPlan(runState.parentElement || null, plan, null, runState));
        const focusButton = documentRef.createElement('button');
        focusButton.type = 'button';
        focusButton.className = 'btn btn-ghost';
        focusButton.textContent = '返回节点';
        focusButton.addEventListener('click', () => executionAdapter?.focus?.(plan.targetNodeId));
        runState.appendChild(retryButton);
        runState.appendChild(focusButton);
    }

    async function runPromptPlan(message, plan, actions = null, existingRunState = null) {
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
            renderFailedRun(runState, plan, error?.message || '未知错误');
        } finally {
            Array.from(actions?.children || []).forEach((button) => { button.disabled = false; });
        }
    }

    async function submit() {
        const { input, sendButton } = getElements();
        const text = input?.value?.trim();
        if (!text) return;
        appendMessage('user', text);
        input.value = '';
        if (sendButton) sendButton.disabled = true;
        try {
            const context = nodeAdapter?.getSelectedContext?.() || null;
            const reply = await createReply({ message: text, context });
            const agentMessage = appendMessage('agent', reply?.message || 'Prompt Plan 已就绪。', reply?.workSummary || []);
            appendPromptPlan(agentMessage, reply?.promptPlan);
        } catch (error) {
            appendMessage('agent', error?.message || 'Agent 暂时无法回复，请稍后重试。');
        } finally {
            if (sendButton) sendButton.disabled = false;
        }
    }

    function init() {
        if (initialized) return;
        const { button, closeButton, form } = getElements();
        button?.addEventListener('click', toggle);
        closeButton?.addEventListener('click', close);
        form?.addEventListener('submit', async (event) => {
            event.preventDefault();
            await submit();
        });
        setOpen(false);
        initialized = true;
    }

    return { init, open, close, toggle, submit };
}
