const DEFAULT_REPLY = Object.freeze({
    message: '已收到。后续接入生图节点后，我会在这里生成可应用的提示词方案。',
    workSummary: ['理解创作需求', '整理提示词方向']
});

export function createPromptAgentController({
    documentRef = document,
    createReply = async () => DEFAULT_REPLY
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

    async function submit() {
        const { input, sendButton } = getElements();
        const text = input?.value?.trim();
        if (!text) return;
        appendMessage('user', text);
        input.value = '';
        if (sendButton) sendButton.disabled = true;
        try {
            const reply = await createReply({ message: text });
            appendMessage('agent', reply?.message || DEFAULT_REPLY.message, reply?.workSummary || []);
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
