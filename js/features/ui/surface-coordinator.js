// Coordinates existing window lifecycles; closing always uses the owning feature.
const coordinators = new WeakMap();
const MODALS = '.modal-overlay, .modal.active, .fullscreen-overlay, .history-fullscreen-overlay, .painter-overlay, .image-compare-advanced-overlay, .camera-control-editor-overlay, .dialog-style-1, .reference-image-count-dialog, .provider-models-dialog, .api-settings-help-dialog, #protocol-developer-panel';

export function getSurfaceCoordinator(documentRef) {
    if (!documentRef?.defaultView?.MutationObserver || !documentRef.body) return null;
    if (coordinators.has(documentRef)) return coordinators.get(documentRef);
    const view = documentRef.defaultView;
    const windows = new Map(), modeless = new Map(), popovers = new Map(), escapeHandlers = new WeakMap(), masked = new Map();
    let serial = 0, top = null, previousFocus = null, updating = false, suppressClick = false;
    const visible = element => element.isConnected && !element.hidden && !element.classList.contains('hidden') && element.getClientRects().length > 0
        && view.getComputedStyle(element).display !== 'none' && view.getComputedStyle(element).visibility !== 'hidden';
    const modelessOpen = (element, entry) => visible(element) && (!entry.isOpen || entry.isOpen());
    const modelessStack = () => [...modeless].filter(([element, entry]) => modelessOpen(element, entry))
        .sort((a, b) => a[1].order - b[1].order);
    const restoreMasks = () => { for (const [element, wasInert] of masked) element.inert = wasInert; masked.clear(); };
    const closePopover = id => {
        const entry = popovers.get(id);
        if (!entry) return;
        popovers.delete(id);
        for (const [childId, child] of [...popovers]) if (child.parent === id) closePopover(childId);
        entry.element.style.zIndex = entry.zIndex;
        entry.close();
    };
    const closePopovers = (owner = null) => {
        for (const [id, entry] of [...popovers]) if (!owner || entry.owner === owner) closePopover(id);
    };
    const fallbackEscape = element => {
        if (element.id === 'settings-modal') return view.__cainflowSettingsModalApi?.handleEscape?.();
        const button = element.querySelector('[data-action="close"], [data-role="close"], .fullscreen-close, .history-fullscreen-close, .camera-control-editor-close, .painter-close, .dialog-close, .dialog-style-1-close, .modal-close, .reference-image-count-close, .api-settings-help-close, .provider-models-close, [id*="close"], [aria-label^="关闭"]');
        button?.click();
    };
    function refresh() {
        if (updating) return;
        updating = true;
        try {
            const oldTop = top;
            for (const [element, entry] of windows) if (!visible(element)) {
                closePopovers(element);
                for (const [child, childEntry] of windows) if (childEntry.parent === element && visible(child)) {
                    (escapeHandlers.get(child) || (() => fallbackEscape(child)))({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
                }
                element.style.zIndex = entry.zIndex;
                windows.delete(element);
            }
            for (const [id, entry] of [...popovers]) if (!visible(entry.element) || (entry.trigger && !entry.trigger.isConnected)) closePopover(id);
            for (const element of documentRef.querySelectorAll(MODALS)) {
                if (!visible(element) || windows.has(element)) continue;
                closePopovers();
                const active = documentRef.activeElement;
                const parent = [...windows].sort((a, b) => a[1].order - b[1].order).at(-1)?.[0] || null;
                windows.set(element, { order: ++serial, parent, zIndex: element.style.zIndex,
                    focus: element.contains(active) ? previousFocus : active });
            }
            const sorted = [...windows].sort((a, b) => a[1].order - b[1].order);
            const base = parseInt(view.getComputedStyle(documentRef.documentElement).getPropertyValue('--layer-modal'), 10) || 10000;
            sorted.forEach(([element], index) => {
                const layer = String(base + index * 20);
                if (element.style.zIndex !== layer) element.style.zIndex = layer;
            });
            top = sorted.at(-1)?.[0] || null;
            for (const [element, entry] of modeless) {
                const open = modelessOpen(element, entry);
                if (open && !entry.wasOpen) {
                    entry.order = ++serial;
                    entry.focus = typeof entry.opener === 'function' ? entry.opener() : entry.opener || documentRef.activeElement;
                } else if (!open && entry.wasOpen) {
                    closePopovers(element);
                    element.style.zIndex = entry.zIndex;
                }
                entry.wasOpen = open;
            }
            const drawerBase = parseInt(view.getComputedStyle(documentRef.documentElement).getPropertyValue('--layer-drawer'), 10) || 7000;
            const menuBase = parseInt(view.getComputedStyle(documentRef.documentElement).getPropertyValue('--layer-menu'), 10) || 7900;
            modelessStack().forEach(([element], index) => {
                const layer = String(Math.min(drawerBase + index * 20, menuBase - 20));
                if (element.style.zIndex !== layer) element.style.zIndex = layer;
            });
            for (const entry of popovers.values()) if (modeless.has(entry.owner)) {
                let depth = 0, parent = entry.parent;
                while (parent && depth < popovers.size) { depth++; parent = popovers.get(parent)?.parent; }
                const layer = String(menuBase + depth);
                if (entry.element.style.zIndex !== layer) entry.element.style.zIndex = layer;
            }
            restoreMasks();
            if (top) {
                // Portal children remain interactive only inside their own window.
                const allowed = [top, ...[...popovers.values()].filter(entry => entry.owner === top).map(entry => entry.element)];
                const visit = parent => {
                    for (const child of parent.children) {
                        if (['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName) || child.id === 'toast-container') continue;
                        if (allowed.some(element => element === child || element.contains(child))) continue;
                        if (allowed.some(element => child.contains(element))) { visit(child); continue; }
                        masked.set(child, child.inert); child.inert = true;
                    }
                };
                visit(documentRef.body);
                for (const entry of popovers.values()) if (entry.owner === top) {
                    const layer = String(Number(top.style.zIndex) + 10);
                    if (entry.element.style.zIndex !== layer) entry.element.style.zIndex = layer;
                }
                if (oldTop !== top && !allowed.some(element => element.contains(documentRef.activeElement))) {
                    const focus = top.querySelector('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
                    if (focus) focus.focus({ preventScroll: true });
                }
            }
            if (oldTop && oldTop !== top && !windows.has(oldTop)) {
                const focus = oldTop.__surfaceReturnFocus;
                if (focus?.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true });
            }
            for (const [element, entry] of windows) element.__surfaceReturnFocus = entry.focus;
        } finally { updating = false; }
    }
    // Canvas transforms and preview panning update styles every frame. Only
    // window visibility/structure changes should rescan the window stack.
    const observer = new view.MutationObserver(records => {
        if (records.some(record => record.type === 'childList'
            ? [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
                && (node.matches(MODALS) || node.querySelector(MODALS) || windows.has(node) || modeless.has(node)))
            : record.target.matches(MODALS) || windows.has(record.target)
                || (modeless.has(record.target) && record.attributeName !== 'style'))) refresh();
    });
    observer.observe(documentRef.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'style'] });
    documentRef.addEventListener('focusin', event => { previousFocus = event.relatedTarget || previousFocus; });
    documentRef.addEventListener('keydown', event => {
        refresh();
        if (event.isComposing) return;
        if (event.key === 'Tab' && top) {
            const roots = [top, ...[...popovers.values()].filter(entry => entry.owner === top).map(entry => entry.element)];
            const controls = roots.flatMap(root => [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')])
                .filter(element => !element.disabled && element.tabIndex >= 0 && visible(element) && !element.closest('[inert]'));
            const first = controls[0], last = controls.at(-1);
            if (first && event.shiftKey && (event.target === first || !controls.includes(documentRef.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (last && !event.shiftKey && (event.target === last || !controls.includes(documentRef.activeElement))) {
                event.preventDefault(); first.focus();
            }
        }
        if (event.key !== 'Escape') return;
        const popover = [...popovers].at(-1);
        if (popover) {
            event.preventDefault(); event.stopImmediatePropagation();
            const trigger = popover[1].trigger;
            closePopover(popover[0]);
            trigger?.isConnected && trigger.focus({ preventScroll: true });
        } else if (top) {
            event.preventDefault(); event.stopImmediatePropagation();
            (escapeHandlers.get(top) || (() => fallbackEscape(top)))(event);
        } else {
            const element = modelessStack().at(-1)?.[0];
            if (!element) return;
            event.preventDefault(); event.stopImmediatePropagation();
            api.closeModeless(element);
        }
    }, true);
    // Close menus before a background click reaches a canvas or a different window.
    documentRef.addEventListener('pointerdown', event => {
        suppressClick = false;
        refresh();
        if (top && !top.contains(event.target) && ![...popovers.values()].some(entry => entry.owner === top && entry.element.contains(event.target))) {
            event.preventDefault(); event.stopImmediatePropagation();
            suppressClick = true;
        } else if (popovers.size && ![...popovers.values()].some(entry => entry.element.contains(event.target)
            || (entry.trigger?.matches('button, [aria-expanded], [data-submenu-target]') && entry.trigger.contains(event.target)))) {
            closePopovers();
            event.preventDefault(); event.stopImmediatePropagation(); suppressClick = true;
        } else if (!top) {
            const owner = modelessStack().findLast(([element]) => element.contains(event.target))?.[0]
                || [...popovers.values()].find(entry => entry.element.contains(event.target))?.owner;
            if (owner) api.bringToFront(owner);
        }
    }, true);
    documentRef.addEventListener('click', event => {
        // Keyboard/programmatic activation is independent of the dismissed
        // pointer gesture (which may not produce a click at all).
        if (!suppressClick || event.detail === 0) return;
        suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    const api = {
        refresh,
        closePopovers,
        topModal: () => { refresh(); return top; },
        topModeless: () => { refresh(); return modelessStack().at(-1)?.[0] || null; },
        registerModeless(element, options) {
            const existing = modeless.get(element);
            modeless.set(element, { ...existing, ...options, order: existing?.order || ++serial,
                zIndex: existing?.zIndex ?? element.style.zIndex, wasOpen: existing?.wasOpen || false });
            refresh();
            return () => {
                closePopovers(element);
                const entry = modeless.get(element);
                if (entry) element.style.zIndex = entry.zIndex;
                modeless.delete(element);
                refresh();
            };
        },
        bringToFront(element) {
            refresh();
            const entry = modeless.get(element);
            if (!entry || !modelessOpen(element, entry)) return;
            entry.order = ++serial;
            refresh();
        },
        closeModeless(element) {
            const entry = modeless.get(element);
            if (!entry || !modelessOpen(element, entry)) return;
            closePopovers(element);
            entry.close();
            refresh();
            if (modelessOpen(element, entry)) return;
            const opener = typeof entry.opener === 'function' ? entry.opener() : entry.opener || entry.focus;
            if (opener && visible(opener) && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
        },
        registerEscape(element, handler) { escapeHandlers.set(element, handler); return () => escapeHandlers.delete(element); },
        openPopover(id, { element, trigger, owner = null, parent = null, close }) {
            refresh();
            owner ||= popovers.get(parent)?.owner || trigger?.closest(MODALS)
                || modelessStack().findLast(([element]) => trigger && element.contains(trigger))?.[0] || null;
            if (top && owner !== top) { close(); return; }
            if (modeless.has(owner)) api.bringToFront(owner);
            // Parent/child menus are one interaction tree, unrelated menus are exclusive.
            for (const [otherId, other] of [...popovers]) {
                if (otherId !== parent && other.parent !== id && otherId !== id) closePopover(otherId);
            }
            popovers.set(id, { element, trigger, owner, parent, close, zIndex: popovers.get(id)?.zIndex ?? element.style.zIndex });
            refresh();
        },
        forgetPopover(id) {
            const entry = popovers.get(id);
            if (entry) entry.element.style.zIndex = entry.zIndex;
            popovers.delete(id);
            for (const [childId, child] of [...popovers]) if (child.parent === id) closePopover(childId);
            refresh();
        }
    };
    coordinators.set(documentRef, api);
    refresh();
    return api;
}
