const ICONS = {
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    resend: '<path d="M20 7v5h-5"/><path d="M4 17a8 8 0 0 0 14-1M20 12A8 8 0 0 0 6 6L4 8"/>'
};

export function createUserMessageActions({ documentRef, text, onResend, disabled, onNativeClipboardWrite }) {
    const actions = documentRef.createElement('div');
    actions.className = 'prompt-agent-message-actions';
    for (const [action, label] of [['copy', '复制文本'], ['resend', '重新发送']]) {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'prompt-agent-message-action';
        button.dataset.messageAction = action;
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.7');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = ICONS[action];
        button.appendChild(icon);
        if (action === 'resend') {
            button.disabled = disabled;
            button.addEventListener('click', onResend);
        } else {
            button.addEventListener('click', async () => {
                try {
                    await documentRef.defaultView.navigator.clipboard.writeText(text);
                    onNativeClipboardWrite();
                    button.title = '已复制';
                    icon.innerHTML = '<path d="m5 12 4 4L19 6"/>';
                    button.dataset.copyState = 'success';
                } catch {
                    button.title = '复制失败，请重试';
                    icon.innerHTML = ICONS.copy;
                    button.dataset.copyState = 'error';
                }
                button.setAttribute('aria-label', button.title);
            });
        }
        actions.appendChild(button);
    }
    return actions;
}
