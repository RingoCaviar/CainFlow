/**
 * 负责轻提示消息的创建、展示与自动消失，是全局 toast 的统一出口。
 */
export function createToastControllerApi({
    container,
    documentRef = document,
    setTimeoutRef = setTimeout
}) {
    function showToast(message, type = 'info', duration = 3000) {
        if (!container) return;
        const toast = documentRef.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '[OK]', error: '[ERR]', info: '[i]', warning: '[!]' };
        const icon = documentRef.createElement('span');
        icon.textContent = icons[type] || '';
        toast.appendChild(icon);
        const content = documentRef.createElement('span');
        content.className = 'toast-message';
        content.textContent = String(message || '');
        toast.appendChild(content);
        container.appendChild(toast);
        let dismissed = false;
        let timeoutId = null;
        const dismiss = (delay = 0) => {
            if (dismissed || !toast.parentNode) return;
            dismissed = true;
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            setTimeoutRef(() => toast.remove(), delay > 0 ? delay : 300);
        };
        if (Number.isFinite(duration) && duration > 0) {
            timeoutId = setTimeoutRef(() => dismiss(), duration);
        }
        return {
            element: toast,
            dismiss,
            update(nextMessage, nextType = type) {
                toast.className = `toast ${nextType}`;
                icon.textContent = icons[nextType] || '';
                content.textContent = String(nextMessage || '');
            },
            clearTimer() {
                if (timeoutId !== null && typeof clearTimeout === 'function') {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            }
        };
    }

    return {
        showToast
    };
}
