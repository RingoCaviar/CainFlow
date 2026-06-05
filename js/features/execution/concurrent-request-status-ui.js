export function normalizeConcurrentRequestStatusPayload(statusPayload = {}) {
    const requests = Array.isArray(statusPayload.requests) ? statusPayload.requests : [];
    const total = Math.max(0, parseInt(statusPayload.total ?? requests.length, 10) || 0);
    const normalizedRequests = Array.from({ length: total }, (_, index) => {
        const source = requests.find((request, requestIndex) => (
            Math.max(0, parseInt(request?.index ?? requestIndex, 10) || 0) === index
        )) || {};
        const status = source.status === 'success' || source.status === 'failed'
            ? source.status
            : 'running';
        return {
            index,
            status,
            error: typeof source.error === 'string' ? source.error : ''
        };
    });
    return {
        total,
        requests: normalizedRequests
    };
}

export function getConcurrentStatusPopoverController({
    documentRef = document,
    windowRef = documentRef.defaultView || window
} = {}) {
    if (documentRef._concurrentStatusPopoverController) {
        return documentRef._concurrentStatusPopoverController;
    }

    const errorPopover = documentRef.createElement('div');
    errorPopover.className = 'node-concurrent-status-error-popover hidden';
    documentRef.body.appendChild(errorPopover);

    const state = {
        activePanel: null,
        activeDot: null,
        canvasZoom: 1
    };

    const resolveCanvasZoom = () => {
        const canvasContainer = documentRef.getElementById('canvas-container')
            || documentRef.querySelector('.canvas-container');
        if (!canvasContainer || typeof windowRef.getComputedStyle !== 'function') return 1;
        const rawZoom = windowRef.getComputedStyle(canvasContainer)
            .getPropertyValue('--canvas-zoom')
            .trim();
        const parsedZoom = Number.parseFloat(rawZoom);
        return Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
    };

    const positionErrorPopover = (dot) => {
        const dotRect = dot.getBoundingClientRect();
        const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 0;
        const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 0;
        const zoomScale = Math.max(0.72, Math.min(state.canvasZoom || 1, 1));
        const popoverWidth = Math.min(480, Math.max(280, viewportWidth - 32));
        const visibleWidth = popoverWidth * zoomScale;
        const preferredTop = dotRect.bottom + 8;
        const left = Math.max(16, Math.min(dotRect.right - visibleWidth, viewportWidth - visibleWidth - 16));
        errorPopover.style.left = `${left}px`;
        errorPopover.style.top = `${Math.min(preferredTop, viewportHeight - 24)}px`;
        errorPopover.style.width = `${popoverWidth}px`;
        errorPopover.style.maxWidth = `${popoverWidth}px`;
        errorPopover.style.maxHeight = `${Math.max(160, (viewportHeight - preferredTop - 24) / zoomScale)}px`;
        errorPopover.style.transform = `scale(${zoomScale})`;
        errorPopover.style.transformOrigin = 'top left';
    };

    const hideErrorPopover = () => {
        errorPopover.classList.add('hidden');
        errorPopover.textContent = '';
        errorPopover.style.left = '';
        errorPopover.style.top = '';
        errorPopover.style.width = '';
        errorPopover.style.maxWidth = '';
        errorPopover.style.maxHeight = '';
        errorPopover.style.transform = '';
        errorPopover.style.transformOrigin = '';
        state.activePanel = null;
        state.activeDot = null;
    };

    const showErrorPopover = (panel, dot, message) => {
        if (!message || !dot) return;
        state.activePanel = panel || null;
        state.activeDot = dot;
        state.canvasZoom = resolveCanvasZoom();
        positionErrorPopover(dot);
        errorPopover.textContent = message;
        errorPopover.classList.remove('hidden');
    };

    const repositionActivePopover = () => {
        if (errorPopover.classList.contains('hidden')) return;
        if (!state.activeDot?.isConnected) {
            hideErrorPopover();
            return;
        }
        positionErrorPopover(state.activeDot);
    };

    const handleDocumentClick = (event) => {
        if (errorPopover.contains(event.target)) return;
        if (state.activePanel?.contains?.(event.target)) return;
        hideErrorPopover();
    };

    let transformFrame = null;
    const handleCanvasTransformNow = () => {
        transformFrame = null;
        state.canvasZoom = resolveCanvasZoom();
        repositionActivePopover();
    };
    const handleCanvasTransform = () => {
        if (transformFrame) return;
        transformFrame = windowRef.requestAnimationFrame
            ? windowRef.requestAnimationFrame(handleCanvasTransformNow)
            : windowRef.setTimeout(handleCanvasTransformNow, 16);
    };

    documentRef.addEventListener('click', handleDocumentClick);
    documentRef.addEventListener('cainflow:canvas-transform', handleCanvasTransform);
    windowRef.addEventListener('resize', handleCanvasTransform);
    windowRef.addEventListener('scroll', handleCanvasTransform, true);

    const controller = {
        errorPopover,
        hideErrorPopover,
        showErrorPopover,
        repositionActivePopover
    };
    documentRef._concurrentStatusPopoverController = controller;
    return controller;
}

export function removeConcurrentRequestStatusPanel(node) {
    const panel = Array.from(node?.el?.children || [])
        .find((child) => child.classList?.contains('node-concurrent-status-panel'));
    if (panel) {
        panel.remove();
    }
    node?.el?.classList?.remove('has-concurrent-status');
}

export function renderConcurrentRequestStatusPanel(node, statusPayload = {}, {
    documentRef = document
} = {}) {
    if (!node?.el) return null;
    const normalized = normalizeConcurrentRequestStatusPayload(statusPayload);
    if (normalized.total <= 0) {
        removeConcurrentRequestStatusPanel(node);
        return null;
    }

    removeConcurrentRequestStatusPanel(node);
    const panel = documentRef.createElement('div');
    panel.className = 'node-concurrent-status-panel';
    panel.dataset.total = String(normalized.total);
    panel.setAttribute('aria-label', 'Concurrent request status');

    const grid = documentRef.createElement('div');
    grid.className = 'node-concurrent-status-grid';
    panel.appendChild(grid);

    const { showErrorPopover } = getConcurrentStatusPopoverController({ documentRef });

    normalized.requests.forEach((request) => {
        const dot = documentRef.createElement('span');
        dot.className = 'node-concurrent-status-dot';
        dot.dataset.status = request.status;
        dot.title = `Request ${request.index + 1}: ${request.status}`;
        if (request.status === 'failed') {
            const errorMessage = request.error || 'Request failed, but no detailed error message was returned.';
            dot.dataset.error = errorMessage;
            dot.title = `Request ${request.index + 1}: failed (click to view details)`;
            dot.setAttribute('role', 'button');
            dot.tabIndex = 0;
        }
        grid.appendChild(dot);
    });

    grid.addEventListener('click', (event) => {
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot || !grid.contains(dot)) return;
        event.stopPropagation();
        showErrorPopover(panel, dot, dot.dataset.error || '');
    });

    grid.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot) return;
        event.preventDefault();
        showErrorPopover(panel, dot, dot.dataset.error || '');
    });

    node.el.appendChild(panel);
    node.el.classList.add('has-concurrent-status');
    return panel;
}
