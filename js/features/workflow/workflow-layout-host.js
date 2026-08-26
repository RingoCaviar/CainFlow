export function createWorkflowLayoutHost(documentRef, { width = 1600, height = 1200 } = {}) {
    const frame = documentRef?.createElement?.('iframe');
    if (!frame || !documentRef?.body?.appendChild) {
        throw new Error('Workflow layout host is unavailable');
    }
    frame.setAttribute?.('aria-hidden', 'true');
    frame.setAttribute?.('tabindex', '-1');
    Object.assign(frame.style || {}, {
        position: 'fixed',
        left: '-100000px',
        top: '-100000px',
        width: `${Math.max(1, Number(width) || 1600)}px`,
        height: `${Math.max(1, Number(height) || 1200)}px`,
        border: '0',
        opacity: '0',
        pointerEvents: 'none'
    });
    documentRef.body.appendChild(frame);
    const layoutDocument = frame.contentDocument;
    if (!layoutDocument?.body) {
        frame.remove?.();
        throw new Error('Workflow layout document is unavailable');
    }
    if (layoutDocument.head?.appendChild && layoutDocument.createElement) {
        const cssText = Array.from(documentRef.styleSheets || []).flatMap((styleSheet) => {
            try {
                return Array.from(styleSheet.cssRules || []).map((rule) => rule.cssText || '');
            } catch {
                return [];
            }
        }).filter(Boolean).join('\n');
        if (cssText) {
            const style = layoutDocument.createElement('style');
            style.textContent = cssText;
            layoutDocument.head.appendChild(style);
        }
    }
    let disposed = false;
    return {
        document: layoutDocument,
        dispose() {
            if (disposed) return;
            disposed = true;
            frame.remove?.();
        }
    };
}

export function createWorkflowLayoutElements(documentRef, { width = 1000, height = 800 } = {}) {
    const normalizedWidth = Math.max(1, Number(width) || 1000);
    const normalizedHeight = Math.max(1, Number(height) || 800);
    const wrapper = documentRef.createElement('div');
    wrapper.className = 'workflow-runtime-detached';
    Object.assign(wrapper.style || {}, {
        position: 'relative',
        width: `${normalizedWidth}px`,
        height: `${normalizedHeight}px`,
        overflow: 'hidden',
        pointerEvents: 'none'
    });

    const canvasContainer = documentRef.createElement('div');
    canvasContainer.id = 'canvas-container';
    const connectionsSvg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    connectionsSvg.id = 'connections-svg';
    const originAxes = documentRef.createElementNS('http://www.w3.org/2000/svg', 'g');
    originAxes.id = 'origin-axes';
    const connectionsGroup = documentRef.createElementNS('http://www.w3.org/2000/svg', 'g');
    connectionsGroup.id = 'connections-group';
    const tempConnection = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempConnection.id = 'temp-connection';
    tempConnection.setAttribute('class', 'temp-connection');
    const nodesLayer = documentRef.createElement('div');
    nodesLayer.id = 'nodes-layer';

    connectionsSvg.appendChild(originAxes);
    connectionsSvg.appendChild(connectionsGroup);
    connectionsSvg.appendChild(tempConnection);
    canvasContainer.appendChild(connectionsSvg);
    canvasContainer.appendChild(nodesLayer);
    wrapper.appendChild(canvasContainer);
    documentRef.body.appendChild(wrapper);

    return { wrapper, canvasContainer, connectionsSvg, nodesLayer, connectionsGroup, tempConnection, originAxes };
}
