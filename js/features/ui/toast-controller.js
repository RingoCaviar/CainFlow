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
        toast.appendChild(documentRef.createTextNode(String(message || '')));
        container.appendChild(toast);
        setTimeoutRef(() => {
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            setTimeoutRef(() => toast.remove(), 300);
        }, duration);
    }

    return {
        showToast
    };
}
