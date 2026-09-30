/** The image action menu shown inside the history preview modal. */
export function createHistoryImageContextMenu({ documentRef = document, windowRef = window } = {}) {
    let menu = null;
    let closeHandler = null;

    function close() {
        if (closeHandler) documentRef.removeEventListener('pointerdown', closeHandler, true);
        closeHandler = null;
        menu?.remove();
        menu = null;
    }

    function open(event, copy) {
        close();
        if (!documentRef.body || typeof copy !== 'function') return;
        menu = documentRef.createElement('div');
        menu.className = 'context-menu history-image-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '历史图片操作');
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;

        const action = documentRef.createElement('button');
        action.type = 'button';
        action.className = 'context-menu-item';
        action.textContent = '复制图片';
        action.setAttribute('role', 'menuitem');
        let handledByPointer = false;
        const runCopy = (copyEvent) => {
            copyEvent.preventDefault();
            copyEvent.stopPropagation();
            void copy();
            close();
        };
        action.addEventListener('pointerdown', (copyEvent) => {
            handledByPointer = true;
            runCopy(copyEvent);
        });
        action.addEventListener('click', (copyEvent) => {
            if (handledByPointer) {
                handledByPointer = false;
                copyEvent.preventDefault();
                return;
            }
            runCopy(copyEvent);
        });
        menu.appendChild(action);
        documentRef.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(event.clientX, windowRef.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(event.clientY, windowRef.innerHeight - rect.height - 8))}px`;
        closeHandler = (pointerEvent) => {
            if (!menu?.contains(pointerEvent.target)) close();
        };
        windowRef.setTimeout(() => documentRef.addEventListener('pointerdown', closeHandler, true), 0);
    }

    return { open, close };
}
