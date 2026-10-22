import { getModelOptionLabel } from '../execution/provider-request-utils.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
export function getAgentModelLabel(model, providers = []) {
    return getModelOptionLabel({ ...model, name: model.name || model.modelId || model.id }, providers);
}

// Adapt the node select contract (native value + input/change) without node bindings.
export function createPromptAgentModelMenus({ documentRef, selects, parent = null, placeholder = '请选择模型' }) {
    const windowRef = documentRef.defaultView;
    const surfaces = getSurfaceCoordinator(documentRef);
    let current = null;
    const cleanups = [];
    const refreshers = [];
    const close = (restoreFocus = false) => {
        if (!current) return;
        const { trigger, menu } = current;
        current = null;
        surfaces?.forgetPopover(menu.id);
        menu.remove();
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
    };
    const position = () => {
        if (!current) return;
        const { trigger, menu } = current;
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(280, rect.width), windowRef.innerWidth - 16);
        const above = Math.max(0, rect.top - 12);
        const below = Math.max(0, windowRef.innerHeight - rect.bottom - 12);
        const up = above >= Math.min(300, menu.scrollHeight) || above >= below;
        menu.style.width = `${width}px`;
        menu.style.maxHeight = `${Math.min(300, up ? above : below)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, windowRef.innerWidth - width - 8))}px`;
        menu.style.top = `${up ? Math.max(8, rect.top - menu.getBoundingClientRect().height - 4) : rect.bottom + 4}px`;
    };
    for (const entry of selects.filter(Boolean)) {
        const { select, parent: parentId = parent, placeholder: emptyText = placeholder } = 'select' in entry ? entry : { select: entry };
        if (!select?.insertAdjacentElement) continue;
        const originalTabIndex = select.getAttribute('tabindex');
        const originalHidden = select.getAttribute('aria-hidden');
        const trigger = documentRef.createElement('button');
        trigger.type = 'button';
        trigger.className = 'prompt-agent-model-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', `${select.id}-menu`);
        trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
        select.classList.add('prompt-agent-model-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.insertAdjacentElement('afterend', trigger);
        const sync = () => {
            trigger.disabled = select.disabled;
            trigger.textContent = select.selectedOptions[0]?.textContent || emptyText;
            trigger.title = trigger.textContent;
            if (current?.select === select) close();
        };
        const open = () => {
            if (select.disabled) return;
            if (current?.select === select) { close(); return; }
            close();
            // Refresh dynamic model configuration through the existing focus contract.
            select.dispatchEvent(new Event('focus'));
            sync();
            observer.takeRecords();
            if (select.disabled) return;
            const menu = documentRef.createElement('div');
            menu.id = `${select.id}-menu`;
            menu.className = 'prompt-agent-model-menu';
            if (parentId) menu.dataset.agentPopoverParent = parentId;
            menu.setAttribute('role', 'listbox');
            menu.setAttribute('aria-label', select.getAttribute('aria-label'));
            for (const option of select.options) {
                const item = documentRef.createElement('button');
                item.type = 'button';
                item.className = 'prompt-agent-model-option';
                item.textContent = option.textContent;
                item.disabled = option.disabled;
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.selected));
                item.tabIndex = -1;
                item.addEventListener('click', event => {
                    event.stopPropagation();
                    if (item.disabled || select.disabled) return;
                    close(true);
                    if (select.value !== option.value) {
                        select.value = option.value;
                        select.dispatchEvent(new Event('input', { bubbles: true }));
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    sync();
                });
                menu.appendChild(item);
            }
            documentRef.body.appendChild(menu);
            current = { select, trigger, menu };
            surfaces?.openPopover(menu.id, { element: menu, trigger, close,
                parent: parentId });
            if (!current) return;
            trigger.setAttribute('aria-expanded', 'true');
            position();
            (menu.querySelector('[aria-selected="true"]:not(:disabled)') || menu.querySelector('button:not(:disabled)'))?.focus();
            menu.addEventListener('keydown', event => {
                const items = [...menu.querySelectorAll('button:not(:disabled)')];
                const index = items.indexOf(documentRef.activeElement);
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
                else if (event.key === 'Tab') { close(true); }
                else if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault(); event.stopPropagation(); items[index]?.click();
                }
                else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault();
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                    items[next]?.focus();
                }
            });
            menu.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        };
        trigger.addEventListener('click', open);
        trigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); }
        });
        select.addEventListener('change', sync);
        refreshers.push(sync);
        const observer = new windowRef.MutationObserver(sync);
        observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'value', 'label'] });
        cleanups.push(() => {
            observer.disconnect(); select.removeEventListener('change', sync); trigger.remove();
            select.classList.remove('prompt-agent-model-native');
            for (const [name, value] of [['tabindex', originalTabIndex], ['aria-hidden', originalHidden]]) {
                if (value === null) select.removeAttribute(name); else select.setAttribute(name, value);
            }
        });
        sync();
    }
    const outside = event => {
        if (current && !current.menu.contains(event.target) && !current.trigger.contains(event.target)) close();
    };
    documentRef.addEventListener?.('pointerdown', outside, true);
    windowRef?.addEventListener('resize', position);
    windowRef?.addEventListener('scroll', position, true);
    return { close, refresh: () => refreshers.forEach(sync => sync()), destroy: () => { close(); cleanups.forEach(cleanup => cleanup()); documentRef.removeEventListener?.('pointerdown', outside, true);
        windowRef?.removeEventListener('resize', position); windowRef?.removeEventListener('scroll', position, true); } };
}
