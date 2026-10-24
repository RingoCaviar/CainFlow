/**
 * 负责轻提示消息的创建、展示与自动消失，是全局 toast 的统一出口。
 */
export function createToastControllerApi({
    container,
    documentRef = document,
    setTimeoutRef = setTimeout
}) {
    const navigation = documentRef.getElementById?.('canvas-navigation');
    const windowRef = documentRef.defaultView;
    if (container && navigation && windowRef && documentRef.body?.style) {
        const search = navigation.querySelector('.canvas-node-search');
        const syncNavigationClearance = () => {
            const navigationTop = navigation.getBoundingClientRect().top;
            const searchTop = navigation.classList.contains('search-open')
                ? search?.getBoundingClientRect().top ?? navigationTop
                : navigationTop;
            const clearance = Math.max(0, Math.ceil(windowRef.innerHeight - Math.min(navigationTop, searchTop) + 12));
            documentRef.body.style.setProperty('--toast-canvas-bottom-offset', `${clearance}px`);
        };
        syncNavigationClearance();
        windowRef.addEventListener('resize', syncNavigationClearance);
        if (windowRef.ResizeObserver) {
            const observer = new windowRef.ResizeObserver(syncNavigationClearance);
            observer.observe(navigation);
            if (search) observer.observe(search);
        }
        if (windowRef.MutationObserver) {
            const observer = new windowRef.MutationObserver(syncNavigationClearance);
            observer.observe(navigation, { attributes: true, attributeFilter: ['class'] });
        }
    }

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
