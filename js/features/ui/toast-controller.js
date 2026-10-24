/**
 * 负责轻提示消息的创建、展示与自动消失，是全局 toast 的统一出口。
 */
export function createToastControllerApi({
    container,
    documentRef = document,
    setTimeoutRef = setTimeout,
    clearTimeoutRef = clearTimeout
}) {
    let currentStatus = null;
    const navigation = documentRef.getElementById?.('canvas-navigation');
    const windowRef = documentRef.defaultView;
    if (container && navigation && windowRef && documentRef.body?.style) {
        const search = navigation.querySelector('.canvas-node-search');
        const zoomMenu = navigation.querySelector('.canvas-zoom-menu');
        const zoomOptions = navigation.querySelector('.canvas-zoom-options');
        const syncNavigationClearance = () => {
            const navigationTop = navigation.getBoundingClientRect().top;
            const searchTop = navigation.classList.contains('search-open')
                ? search?.getBoundingClientRect().top ?? navigationTop
                : navigationTop;
            const zoomTop = zoomMenu?.open ? zoomOptions?.getBoundingClientRect().top ?? navigationTop : navigationTop;
            const clearance = Math.max(0, Math.ceil(windowRef.innerHeight - Math.min(navigationTop, searchTop, zoomTop) + 12));
            documentRef.body.style.setProperty('--toast-canvas-bottom-offset', `${clearance}px`);
        };
        syncNavigationClearance();
        windowRef.addEventListener('resize', syncNavigationClearance);
        if (windowRef.ResizeObserver) {
            const observer = new windowRef.ResizeObserver(syncNavigationClearance);
            observer.observe(navigation);
            if (search) observer.observe(search);
            if (zoomOptions) observer.observe(zoomOptions);
        }
        if (windowRef.MutationObserver) {
            const observer = new windowRef.MutationObserver(syncNavigationClearance);
            observer.observe(navigation, { attributes: true, attributeFilter: ['class', 'open'], subtree: true });
        }
    }

    function showToast(message, type = 'info', duration = 3000) {
        if (!container) return;
        // Short, one-off status messages share a slot. Persistent and long-lived
        // progress handles remain independent, as do warnings and errors.
        const isStatus = (type === 'info' || type === 'success')
            && Number.isFinite(duration) && duration > 0 && duration <= 5000;
        if (isStatus) currentStatus?.replace();
        const toast = documentRef.createElement('div');
        toast.className = `toast ${type}${isStatus ? ' toast-status' : ''}`;
        toast.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
        toast.setAttribute('aria-atomic', 'true');
        const icons = { success: '[OK]', error: '[ERR]', info: '[i]', warning: '[!]' };
        const icon = documentRef.createElement('span');
        icon.textContent = icons[type] || '';
        icon.setAttribute('aria-hidden', 'true');
        toast.appendChild(icon);
        const content = documentRef.createElement('span');
        content.className = 'toast-message';
        content.textContent = String(message || '');
        toast.appendChild(content);
        container.appendChild(toast);
        let dismissed = false;
        let timeoutId = null;
        const clearTimer = () => {
            if (timeoutId !== null) {
                clearTimeoutRef(timeoutId);
                timeoutId = null;
            }
        };
        const releaseStatus = () => {
            if (currentStatus?.element === toast) currentStatus = null;
        };
        const record = {
            element: toast,
            replace() {
                dismissed = true;
                clearTimer();
                toast.remove();
                releaseStatus();
            }
        };
        if (isStatus) currentStatus = record;
        const dismiss = (delay = 0) => {
            if (dismissed || !toast.parentNode) return;
            dismissed = true;
            clearTimer();
            releaseStatus();
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
                if (dismissed) return;
                // A caller updating a handle owns its presentation from now on.
                releaseStatus();
                toast.className = `toast ${nextType}`;
                toast.setAttribute('role', nextType === 'error' || nextType === 'warning' ? 'alert' : 'status');
                icon.textContent = icons[nextType] || '';
                content.textContent = String(nextMessage || '');
            },
            clearTimer() {
                releaseStatus();
                clearTimer();
            }
        };
    }

    return {
        showToast
    };
}
