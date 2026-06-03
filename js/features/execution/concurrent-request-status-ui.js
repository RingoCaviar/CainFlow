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

export function removeConcurrentRequestStatusPanel(node) {
    const panel = Array.from(node?.el?.children || [])
        .find((child) => child.classList?.contains('node-concurrent-status-panel'));
    if (panel) panel.remove();
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

    const errorPopover = documentRef.createElement('div');
    errorPopover.className = 'node-concurrent-status-error-popover hidden';
    panel.appendChild(errorPopover);

    normalized.requests.forEach((request) => {
        const dot = documentRef.createElement('span');
        dot.className = 'node-concurrent-status-dot';
        dot.dataset.status = request.status;
        dot.title = `Request ${request.index + 1}: ${request.status}`;
        if (request.status === 'failed') {
            const errorMessage = request.error || '请求失败，但没有返回具体错误信息。';
            dot.dataset.error = errorMessage;
            dot.title = `Request ${request.index + 1}: failed\n${errorMessage}`;
            dot.setAttribute('role', 'button');
            dot.tabIndex = 0;
        }
        grid.appendChild(dot);
    });

    const showErrorPopover = (dot) => {
        if (!dot?.dataset?.error) return;
        errorPopover.textContent = dot.dataset.error;
        errorPopover.classList.remove('hidden');
    };
    const hideErrorPopover = () => {
        errorPopover.classList.add('hidden');
        errorPopover.textContent = '';
    };
    grid.addEventListener('click', (event) => {
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot || !grid.contains(dot)) return;
        event.stopPropagation();
        showErrorPopover(dot);
    });
    grid.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
        if (!dot) return;
        event.preventDefault();
        showErrorPopover(dot);
    });
    panel.addEventListener('mouseleave', hideErrorPopover);

    node.el.appendChild(panel);
    node.el.classList.add('has-concurrent-status');
    return panel;
}
