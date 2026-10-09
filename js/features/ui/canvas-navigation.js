import { getNodeDefinition } from '../../nodes/registry.js';

export function initCanvasNavigation({ state, canvasContainer, viewportApi, zoomToFit, focusNode, scheduleSave, documentRef = document }) {
    const root = documentRef.getElementById('canvas-navigation');
    if (!root) return;
    const search = root.querySelector('input');
    const results = root.querySelector('.canvas-node-results');
    const toggle = root.querySelector('[data-nav="search"]');
    let activeIndex = 0;
    let observer = null;

    function closeSearch() {
        results.replaceChildren();
        search.value = '';
        root.classList.remove('search-open');
        toggle.setAttribute('aria-expanded', 'false');
        observer?.disconnect();
        observer = null;
    }

    function renderResults() {
        const oldButtons = [...results.querySelectorAll('button')];
        const activeId = oldButtons[activeIndex]?.dataset.nodeId;
        const focusedId = results.contains(documentRef.activeElement) ? documentRef.activeElement.dataset.nodeId : null;
        const query = search.value.trim().toLocaleLowerCase();
        results.replaceChildren();
        for (const node of state.nodes.values()) {
            const title = node.customTitle || node.el?.querySelector('.node-title')?.textContent || getNodeDefinition(node.type)?.title || node.type;
            const typeTitle = getNodeDefinition(node.type)?.title || node.type;
            if (!`${title} ${typeTitle} ${node.type}`.toLocaleLowerCase().includes(query)) continue;
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.dataset.nodeId = node.id;
            const running = state.runningNodeIds?.has(node.id) || node.el?.classList.contains('running');
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
    root.querySelector('[data-nav="reset"]').addEventListener('click', () => setZoom(1));
    root.querySelector('[data-nav="fit"]').addEventListener('click', () => { zoomToFit([...state.nodes.values()]); scheduleSave(); });
    toggle.addEventListener('click', () => {
        if (root.classList.contains('search-open')) { closeSearch(); return; }
        root.classList.add('search-open');
        toggle.setAttribute('aria-expanded', 'true');
        renderResults();
        search.focus();
        const layer = documentRef.getElementById('nodes-layer');
        if (layer) {
            observer = new MutationObserver((mutations) => {
                if (mutations.some((mutation) => mutation.type !== 'attributes' || mutation.target.classList.contains('node'))) renderResults();
            });
            observer.observe(layer, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-node-title'] });
        }
    });
    search.addEventListener('input', renderResults);
    documentRef.addEventListener('pointerdown', (event) => { if (!root.contains(event.target)) closeSearch(); });
}
