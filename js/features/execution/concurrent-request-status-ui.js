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

    const state = {
        activePanel: null,
        activeDot: null
    };

    const positionErrorPopover = (panel, dot) => {
        if (!panel || !dot) return;
        const dotCenterX = dot.offsetLeft + dot.offsetWidth / 2;
        const bottom = Math.max(0, panel.offsetHeight - dot.offsetTop + 4);
        errorPopover.style.left = `${dotCenterX}px`;
        errorPopover.style.top = '';
        errorPopover.style.right = '';
        errorPopover.style.bottom = `${bottom}px`;
        errorPopover.style.width = '';
        errorPopover.style.maxWidth = '';
        errorPopover.style.maxHeight = '';
        errorPopover.style.transform = '';
        errorPopover.style.transformOrigin = '';
    };

    const hideErrorPopover = () => {
        errorPopover.classList.add('hidden');
        errorPopover.textContent = '';
        errorPopover.style.left = '';
        errorPopover.style.top = '';
        errorPopover.style.right = '';
        errorPopover.style.bottom = '';
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
        if (panel && errorPopover.parentNode !== panel) {
            panel.appendChild(errorPopover);
        }
        errorPopover.textContent = message;
        errorPopover.classList.remove('hidden');
        positionErrorPopover(panel, dot);
    };

    const repositionActivePopover = () => {
        if (errorPopover.classList.contains('hidden')) return;
        if (!state.activeDot?.isConnected) {
            hideErrorPopover();
            return;
        }
        positionErrorPopover(state.activePanel, state.activeDot);
    };

    const handleDocumentClick = (event) => {
        if (errorPopover.contains(event.target)) return;
        if (state.activePanel?.contains?.(event.target)) return;
        hideErrorPopover();
    };

    let transformFrame = null;
    const handleCanvasTransformNow = () => {
        transformFrame = null;
        repositionActivePopover();
    };
    const handleCanvasTransform = () => {
        if (transformFrame) return;
        transformFrame = windowRef.requestAnimationFrame
            ? windowRef.requestAnimationFrame(handleCanvasTransformNow)
            : windowRef.setTimeout(handleCanvasTransformNow, 16);
    };

    documentRef.addEventListener('click', handleDocumentClick);
    errorPopover.addEventListener('mousedown', (event) => event.stopPropagation());
    errorPopover.addEventListener('click', (event) => event.stopPropagation());
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

export function bindConcurrentRequestStatusPanelInteractions(panel, grid, {
    documentRef = document,
    getErrorMessage = (dot) => dot?.dataset?.error || '请求失败，但没有返回具体错误信息。'
} = {}) {
    if (!panel || !grid) return null;
    const { showErrorPopover } = getConcurrentStatusPopoverController({ documentRef });

    const stopCanvasInteraction = (event) => {
        event.stopPropagation();
    };

    const openErrorPopoverFromEvent = (event) => {
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot || !grid.contains(dot)) return;
        event.preventDefault();
        event.stopPropagation();
        showErrorPopover(panel, dot, getErrorMessage(dot));
    };

    panel.addEventListener('pointerdown', stopCanvasInteraction);
    panel.addEventListener('mousedown', stopCanvasInteraction);
    grid.addEventListener('click', openErrorPopoverFromEvent);

    grid.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot) return;
        event.preventDefault();
        event.stopPropagation();
        showErrorPopover(panel, dot, getErrorMessage(dot));
    });

    return { showErrorPopover };
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

    bindConcurrentRequestStatusPanelInteractions(panel, grid, {
        documentRef,
        getErrorMessage: (dot) => dot.dataset.error || ''
    });

    node.el.appendChild(panel);
    node.el.classList.add('has-concurrent-status');
    return panel;
}
