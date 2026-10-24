import { getNodeDefinition } from '../../nodes/registry.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';

export function initCanvasNavigation({ state, canvasContainer, viewportApi, zoomToFit, focusNode, scheduleSave, documentRef = document }) {
    const root = documentRef.getElementById('canvas-navigation');
    if (!root) return;
    const surfaces = getSurfaceCoordinator(documentRef);
    const search = root.querySelector('input');
    const results = root.querySelector('.canvas-node-results');
    const toggle = root.querySelector('[data-nav="search"]');
    const zoomMenu = root.querySelector('.canvas-zoom-menu');
    let activeIndex = 0;
    let observer = null;
    let searchRevision = 0;
    let pendingResults = false;
    let resultsSignature = '';

    function closeZoom() {
        if (zoomMenu) zoomMenu.open = false;
        surfaces?.forgetPopover('canvas-zoom');
    }

    function syncZoomMenuSize() {
        if (!zoomMenu?.open) return;
        const availableHeight = Math.max(40, zoomMenu.getBoundingClientRect().top - 24);
        zoomMenu.style.setProperty('--canvas-zoom-max-height', `${availableHeight}px`);
    }

    documentRef.defaultView?.addEventListener('resize', syncZoomMenuSize);
    zoomMenu?.addEventListener('toggle', () => {
        if (zoomMenu.open) {
            closeSearch();
            syncZoomMenuSize();
            surfaces?.openPopover('canvas-zoom', { element: zoomMenu, trigger: zoomMenu.querySelector('summary'), close: closeZoom });
        } else surfaces?.forgetPopover('canvas-zoom');
    });
    zoomMenu?.querySelectorAll('[data-zoom]').forEach(button => {
        button.addEventListener('click', () => {
            setZoom(Number(button.dataset.zoom));
            closeZoom();
            zoomMenu.querySelector('summary').focus();
        });
    });

    function closeSearch() {
        surfaces?.forgetPopover('canvas-navigation');
        searchRevision += 1;
        pendingResults = false;
        resultsSignature = '';
        results.replaceChildren();
        search.value = '';
        root.classList.remove('search-open');
        toggle.setAttribute('aria-expanded', 'false');
        observer?.disconnect();
        observer = null;
    }

    function renderResults() {
        const query = search.value.trim().toLocaleLowerCase();
        const entries = [...state.nodes.values()].map((node) => {
            const title = node.customTitle || node.el?.querySelector('.node-title')?.textContent || getNodeDefinition(node.type)?.title || node.type;
            const typeTitle = getNodeDefinition(node.type)?.title || node.type;
            const running = state.runningNodeIds?.has(node.id) || node.el?.classList.contains('running');
            return { node, title, typeTitle, running: !!running };
        });
        const signature = JSON.stringify([query, entries.map(({ node, title, typeTitle, running }) => [node.id, node.type, title, typeTitle, running])]);
        if (signature === resultsSignature) return;
        resultsSignature = signature;
        const oldButtons = [...results.querySelectorAll('button')];
        const activeId = oldButtons[activeIndex]?.dataset.nodeId;
        const focusedId = results.contains(documentRef.activeElement) ? documentRef.activeElement.dataset.nodeId : null;
        results.replaceChildren();
        for (const { node, title, typeTitle, running } of entries) {
            if (!`${title} ${typeTitle} ${node.type}`.toLocaleLowerCase().includes(query)) continue;
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.dataset.nodeId = node.id;
            button.textContent = `${title} · ${typeTitle}${running ? ' · 运行中' : ''}`;
            button.addEventListener('click', () => {
                if (!state.nodes.has(node.id)) { renderResults(); return; }
                if (typeof focusNode === 'function') focusNode(node.id);
                else zoomToFit([state.nodes.get(node.id)]);
                scheduleSave();
                closeSearch();
                canvasContainer.focus?.();
            });
            results.append(button);
        }
        if (!results.children.length) {
            const empty = documentRef.createElement('p');
            empty.textContent = state.nodes.size ? '没有匹配的节点' : '当前工作流还没有节点';
            results.append(empty);
        }
        const buttons = [...results.querySelectorAll('button')];
        activeIndex = Math.max(0, buttons.findIndex((button) => button.dataset.nodeId === activeId));
        highlight();
        if (focusedId) buttons.find((button) => button.dataset.nodeId === focusedId)?.focus();
    }

    function scheduleResults() {
        if (pendingResults) return;
        pendingResults = true;
        const revision = searchRevision;
        queueMicrotask(() => {
            if (revision !== searchRevision) return;
            pendingResults = false;
            if (root.classList.contains('search-open')) renderResults();
        });
    }

    function highlight() {
        const buttons = [...results.querySelectorAll('button')];
        buttons.forEach((button, index) => button.classList.toggle('is-active', index === activeIndex));
        buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    function setZoom(value) {
        const zoom = Math.max(0.1, Math.min(5, value));
        const oldZoom = state.canvas.zoom;
        const cx = canvasContainer.clientWidth / 2, cy = canvasContainer.clientHeight / 2;
        state.canvas.x = cx - (cx - state.canvas.x) * zoom / oldZoom;
        state.canvas.y = cy - (cy - state.canvas.y) * zoom / oldZoom;
        state.canvas.zoom = zoom;
        viewportApi.updateCanvasTransform();
        viewportApi.refreshNodeTextRendering?.();
        scheduleSave();
    }

    root.addEventListener('mousedown', (event) => event.stopPropagation());
    root.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    root.addEventListener('click', (event) => event.stopPropagation());
    root.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
        if (zoomMenu?.contains(event.target)) {
            const options = [...zoomMenu.querySelectorAll('[data-zoom]')];
            if (event.key === 'Escape') { event.preventDefault(); closeZoom(); zoomMenu.querySelector('summary').focus(); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const current = options.indexOf(documentRef.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                    : current < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
                    : event.key === 'ArrowDown' ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
                zoomMenu.open = true;
                options[next]?.focus();
            }
            return;
        }
        if (event.key === 'Escape') { event.preventDefault(); closeSearch(); toggle.focus(); return; }
        const buttons = [...results.querySelectorAll('button')];
        const focused = buttons.indexOf(documentRef.activeElement);
        if (focused >= 0) activeIndex = focused;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            activeIndex = Math.max(0, Math.min(buttons.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
            highlight();
            if (focused >= 0) buttons[activeIndex]?.focus();
        } else if (event.key === 'Enter' && event.target === search) {
            event.preventDefault(); buttons[activeIndex]?.click();
        }
    });
    root.querySelector('[data-nav="minus"]').addEventListener('click', () => setZoom(state.canvas.zoom / 1.2));
    root.querySelector('[data-nav="plus"]').addEventListener('click', () => setZoom(state.canvas.zoom * 1.2));
    root.querySelector('[data-nav="reset"]')?.addEventListener('click', () => setZoom(1));
    root.querySelector('[data-nav="fit"]').addEventListener('click', () => { zoomToFit([...state.nodes.values()]); scheduleSave(); });
    toggle.addEventListener('click', () => {
        closeZoom();
        if (root.classList.contains('search-open')) { closeSearch(); return; }
        root.classList.add('search-open');
        surfaces?.openPopover('canvas-navigation', { element: root, trigger: toggle, close: closeSearch });
        toggle.setAttribute('aria-expanded', 'true');
        renderResults();
        search.focus();
        const layer = documentRef.getElementById('nodes-layer');
        if (layer) {
            observer = new MutationObserver((mutations) => {
                const relevant = mutations.some((mutation) => {
                    if (mutation.type === 'attributes') {
                        if (!mutation.target.classList.contains('node')) return false;
                        if (mutation.attributeName === 'data-node-title') return true;
                        const wasRunning = (mutation.oldValue || '').split(/\s+/).includes('running');
                        return wasRunning !== mutation.target.classList.contains('running');
                    }
                    return mutation.target === layer || !!mutation.target.parentElement?.closest('.node-title') || !!mutation.target.closest?.('.node-title');
                });
                if (relevant) scheduleResults();
            });
            observer.observe(layer, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'data-node-title'] });
        }
    });
    search.addEventListener('input', renderResults);
    documentRef.addEventListener('pointerdown', (event) => {
        if (!root.contains(event.target)) closeSearch();
        if (!zoomMenu?.contains(event.target)) closeZoom();
    });
}
