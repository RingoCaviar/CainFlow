/**
 * Renders the video-only history-card action menu.
 */
export function createHistoryVideoContextMenu({ documentRef = document, windowRef = window }) {
    let menu = null;
    let closeHandler = null;

    function close() {
        if (closeHandler) documentRef.removeEventListener('pointerdown', closeHandler, true);
        closeHandler = null;
        menu?.remove();
        menu = null;
    }

    function open(event, regenerate) {
        close();
        if (!documentRef.body || typeof regenerate !== 'function') return;

        menu = documentRef.createElement('div');
        menu.className = 'context-menu history-video-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '视频历史记录操作');
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;

        const action = documentRef.createElement('div');
        action.className = 'context-menu-item';
        action.textContent = '重新生成缩略图';
        action.setAttribute('role', 'menuitem');
        action.tabIndex = 0;
        const runRegeneration = async () => {
            if (action.dataset.running === 'true') return;
            action.dataset.running = 'true';
            action.classList.add('is-disabled');
            action.setAttribute('aria-disabled', 'true');
            action.textContent = '正在生成缩略图…';
            await regenerate();
            close();
        };
        action.addEventListener('click', async () => {
            await runRegeneration();
        });
        action.addEventListener('keydown', async (keyEvent) => {
            if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return;
            keyEvent.preventDefault();
            await runRegeneration();
        });
        menu.appendChild(action);
        documentRef.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(event.clientX, windowRef.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(event.clientY, windowRef.innerHeight - rect.height - 8));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        closeHandler = (pointerEvent) => {
            if (!menu?.contains(pointerEvent.target)) close();
        };
        windowRef.setTimeout(() => documentRef.addEventListener('pointerdown', closeHandler, true), 0);
    }

    return { close, open };
}
