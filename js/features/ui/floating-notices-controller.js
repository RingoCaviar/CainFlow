/**
 * 管理画布左上角的悬浮通知条。
 * 新增、修改或移除通知时，优先通过这里的 upsertNotice / hideNotice / removeNotice 统一处理。
 */
export function createFloatingNoticesController({
    container,
    documentRef = document,
    localStorageRef = localStorage
}) {
    const notices = new Map();

    function escapeNoticeId(id) {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
            return CSS.escape(id);
        }
        return String(id).replace(/["\\]/g, '\\$&');
    }

    function getNotice(id) {
        if (!id) return null;
        if (notices.has(id)) return notices.get(id);
        const existing = container?.querySelector(`[data-notice-id="${escapeNoticeId(id)}"]`);
        if (existing) notices.set(id, existing);
        return existing || null;
    }

    function appendTextParts(target, parts) {
        target.textContent = '';
        const normalizedParts = Array.isArray(parts) ? parts : [{ text: parts }];

        normalizedParts.forEach((part) => {
            if (part === null || part === undefined) return;
            if (typeof part === 'string') {
                target.appendChild(documentRef.createTextNode(part));
                return;
            }

            const tagName = part.tag || (part.code ? 'code' : part.highlight ? 'span' : null);
            if (!tagName) {
                target.appendChild(documentRef.createTextNode(String(part.text ?? '')));
                return;
            }

            const el = documentRef.createElement(tagName);
            el.textContent = String(part.text ?? '');
            if (part.className) el.className = part.className;
            target.appendChild(el);
        });
    }

    function createNoticeElement(config) {
        const notice = documentRef.createElement('div');
        notice.dataset.noticeId = config.id;
        if (config.elementId) notice.id = config.elementId;
        return notice;
    }

    function renderActions(notice, actions = []) {
        if (!actions.length) return;

        const actionsWrap = documentRef.createElement('div');
        actionsWrap.className = 'floating-notice-actions';

        actions.forEach((action) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.textContent = action.label || '操作';
            if (action.id) button.id = action.id;
            if (action.className) button.className = action.className;
            if (typeof action.onClick === 'function') {
                button.addEventListener('click', action.onClick);
            }
            actionsWrap.appendChild(button);
        });

        notice.appendChild(actionsWrap);
    }

    function upsertNotice(config) {
        if (!container || !config?.id) return null;

        const dismissed = config.dismissStorageKey
            && localStorageRef.getItem(config.dismissStorageKey) === 'true'
            && !config.forceVisible;
        const visible = config.visible !== false && !dismissed;
        const notice = getNotice(config.id) || createNoticeElement(config);
        const classNames = ['floating-notice'];
        if (config.className) classNames.push(config.className);
        if (!visible) classNames.push('hidden');
        notice.className = classNames.join(' ');
        notice.dataset.noticeId = config.id;
        if (config.elementId) notice.id = config.elementId;
        if (config.role) notice.setAttribute('role', config.role);
        else notice.removeAttribute('role');
        if (config.clickable) {
            notice.classList.add('clickable');
            notice.tabIndex = 0;
            notice.setAttribute('role', config.role || 'button');
        } else {
            notice.classList.remove('clickable');
            notice.removeAttribute('tabindex');
        }
        notice.onclick = null;
        notice.onkeydown = null;
        notice.style.order = Number.isFinite(config.priority) ? String(config.priority) : '100';
        notice.textContent = '';

        if (config.clickable && typeof config.onClick === 'function') {
            notice.onclick = (event) => {
                if (event.target.closest('button, a, input, textarea, select, label')) return;
                config.onClick(event);
            };
            notice.onkeydown = (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                if (event.target.closest('button, a, input, textarea, select, label')) return;
                event.preventDefault();
                config.onClick(event);
            };
        }

        if (config.icon) {
            const icon = documentRef.createElement('div');
            icon.className = 'notice-icon';
            icon.textContent = config.icon;
            notice.appendChild(icon);
        }

        if (config.title || config.meta) {
            const content = documentRef.createElement('div');
            content.className = 'update-canvas-notice-content';

            if (config.title) {
                const title = documentRef.createElement('div');
                title.className = 'update-canvas-notice-title';
                appendTextParts(title, config.title);
                content.appendChild(title);
            }

            if (config.meta) {
                const meta = documentRef.createElement('div');
                meta.className = 'update-canvas-notice-meta';
                appendTextParts(meta, config.meta);
                content.appendChild(meta);
            }

            notice.appendChild(content);
        } else if (config.content) {
            const content = documentRef.createElement('div');
            content.className = 'notice-content';
            appendTextParts(content, config.content);
            notice.appendChild(content);
        }

        renderActions(notice, config.actions);

        if (config.dismissible) {
            const closeBtn = documentRef.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'notice-close';
            closeBtn.setAttribute('aria-label', config.closeLabel || '关闭通知');
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                if (config.dismissStorageKey) {
                    localStorageRef.setItem(config.dismissStorageKey, 'true');
                }
                hideNotice(config.id);
                config.onDismiss?.();
            });
            notice.appendChild(closeBtn);
        }

        if (!notice.parentElement) container.appendChild(notice);
        notices.set(config.id, notice);
        return notice;
    }

    function showNotice(id) {
        getNotice(id)?.classList.remove('hidden');
    }

    function hideNotice(id) {
        getNotice(id)?.classList.add('hidden');
    }

    function removeNotice(id) {
        const notice = getNotice(id);
        notice?.remove();
        notices.delete(id);
    }

    return {
        upsertNotice,
        showNotice,
        hideNotice,
        removeNotice
    };
}
