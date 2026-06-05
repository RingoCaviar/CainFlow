/**
 * 管理从单个锚点节点出发的批量连线模式。
 */
export function createBatchConnectionModeApi({
    state,
    canvasContainer,
    pushHistory,
    updateAllConnections,
    updatePortStyles,
    enforceNodeContentMinimum = null,
    scheduleSave,
    showToast,
    floatingNoticesApi = null,
    onConnectionsChanged = () => {},
    documentRef = document
}) {
    const modeNoticeId = 'batch-connection-mode';

    function getNode(nodeId) {
        return state.nodes.get(nodeId) || null;
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || getNode(nodeId)?.el?.classList.contains('running');
    }

    function isPortVisible(portEl) {
        return portEl &&
            !portEl.classList.contains('hidden');
    }

    function getPorts(nodeId, direction) {
        const node = getNode(nodeId);
        if (!node?.el) return [];
        return Array.from(node.el.querySelectorAll(`.node-port[data-direction="${direction}"]`))
            .filter(isPortVisible)
            .map((portEl) => ({
                nodeId,
                port: portEl.dataset.port || '',
                type: portEl.dataset.type || '',
                direction
            }))
            .filter((port) => port.port && port.type);
    }

    function isPortFree(port) {
        if (!port?.nodeId || !port.port || !port.direction) return false;
        if (port.direction === 'input') {
            return !state.connections.some((connection) => (
                connection.to.nodeId === port.nodeId &&
                connection.to.port === port.port
            ));
        }
        if (port.direction === 'output') {
            return true;
        }
        return false;
    }

    function connectionExists(fromPort, toPort) {
        return state.connections.some((connection) => (
            connection.from.nodeId === fromPort.nodeId &&
            connection.from.port === fromPort.port &&
            connection.to.nodeId === toPort.nodeId &&
            connection.to.port === toPort.port
        ));
    }

    function createConnectionId() {
        return `c_${Math.random().toString(36).substr(2, 9)}`;
    }

    function enforceEndpointNodeMinimum(pair) {
        if (typeof enforceNodeContentMinimum !== 'function') return;
        const nodeIds = new Set([
            pair?.output?.nodeId,
            pair?.input?.nodeId
        ].filter(Boolean));
        nodeIds.forEach((nodeId) => {
            enforceNodeContentMinimum(nodeId, {
                save: false,
                updateConnections: false
            });
        });
    }

    function findPortPair(fromNodeId, toNodeId) {
        const attempts = [
            {
                outputs: getPorts(fromNodeId, 'output'),
                inputs: getPorts(toNodeId, 'input')
            },
            {
                outputs: getPorts(toNodeId, 'output'),
                inputs: getPorts(fromNodeId, 'input')
            }
        ];

        for (const attempt of attempts) {
            for (const output of attempt.outputs) {
                if (!isPortFree(output)) continue;
                const input = attempt.inputs.find((candidate) => (
                    candidate.type === output.type &&
                    isPortFree(candidate) &&
                    !connectionExists(output, candidate)
                ));
                if (input) return { output, input };
            }
        }

        return null;
    }

    function setModeVisual(active) {
        canvasContainer?.classList.toggle('batch-connection-mode-active', active);
        documentRef.body?.classList.toggle('batch-connection-mode-active', active);
        if (canvasContainer) {
            canvasContainer.dataset.batchConnectionMode = active ? 'active' : '';
        }
        if (active) {
            documentRef.body?.classList.remove('toolbar-peek-active', 'sidebar-peek-active');
            state.isSpacePressed = false;
            canvasContainer?.classList.remove('space-pan-active');
        }
    }

    function showModeNotice() {
        floatingNoticesApi?.upsertNotice?.({
            id: modeNoticeId,
            className: 'batch-connection-mode-notice',
            priority: 5,
            icon: '↔',
            content: '你正在处于批量连接模式',
            actions: [
                {
                    label: '退出',
                    onClick: () => exit({ showToast: true })
                }
            ],
            visible: true
        });
    }

    function hideModeNotice() {
        floatingNoticesApi?.removeNotice?.(modeNoticeId);
    }

    function collectSourceRelatedNodeIds(sourceNodeId) {
        const relatedNodeIds = new Set([sourceNodeId]);
        state.connections.forEach((connection) => {
            if (connection.from?.nodeId === sourceNodeId) {
                relatedNodeIds.add(connection.to?.nodeId);
            }
            if (connection.to?.nodeId === sourceNodeId) {
                relatedNodeIds.add(connection.from?.nodeId);
            }
        });
        return relatedNodeIds;
    }

    function refreshNodeVisuals() {
        const sourceNodeId = state.batchConnectionMode?.sourceNodeId;
        if (!sourceNodeId) return;
        const relatedNodeIds = collectSourceRelatedNodeIds(sourceNodeId);
        state.nodes.forEach((node, nodeId) => {
            node.el?.classList.toggle('batch-connection-source', nodeId === sourceNodeId);
            node.el?.classList.toggle('batch-connection-dimmed', !relatedNodeIds.has(nodeId));
        });
    }

    function clearNodeVisuals() {
        state.nodes.forEach((node) => {
            node.el?.classList.remove('batch-connection-source', 'batch-connection-dimmed');
        });
    }

    function enter(sourceNodeId) {
        const sourceNode = getNode(sourceNodeId);
        if (!sourceNode) {
            showToast?.('批量连线模式启动失败：节点不存在', 'warning');
            return false;
        }
        if (isNodeRunning(sourceNodeId)) {
            showToast?.('节点正在运行，暂不能进入批量连线模式', 'warning');
            return false;
        }

        if (state.batchConnectionMode?.sourceNodeId && state.batchConnectionMode.sourceNodeId !== sourceNodeId) {
            getNode(state.batchConnectionMode.sourceNodeId)?.el?.classList.remove('batch-connection-source');
        }
        state.batchConnectionMode = { sourceNodeId };
        setModeVisual(true);
        refreshNodeVisuals();
        showModeNotice();
        showToast?.('已进入批量连线模式，点击其他节点自动连接；按 Esc 退出', 'info', 4500);
        return true;
    }

    function exit(options = {}) {
        clearNodeVisuals();
        state.batchConnectionMode = null;
        setModeVisual(false);
        hideModeNotice();
        if (options.showToast) {
            showToast?.('已退出批量连线模式', 'info');
        }
    }

    function isActive() {
        return Boolean(state.batchConnectionMode?.sourceNodeId);
    }

    function connectTo(targetNodeId) {
        const sourceNodeId = state.batchConnectionMode?.sourceNodeId;
        if (!sourceNodeId) return false;
        if (!targetNodeId || !getNode(targetNodeId)) {
            showToast?.('目标节点不存在', 'warning');
            return true;
        }
        if (sourceNodeId === targetNodeId) {
            showToast?.('不能连接同一节点', 'warning');
            return true;
        }
        if (!getNode(sourceNodeId)) {
            exit();
            showToast?.('批量连线源节点已不存在，已退出模式', 'warning');
            return true;
        }
        if (isNodeRunning(sourceNodeId) || isNodeRunning(targetNodeId)) {
            showToast?.('节点正在运行，暂不能修改连线', 'warning');
            return true;
        }

        const pair = findPortPair(sourceNodeId, targetNodeId);
        if (!pair) {
            showToast?.('没有可用的同类型空闲接口，无法创建连接', 'warning');
            return true;
        }

        pushHistory();
        state.connections.push({
            id: createConnectionId(),
            from: { nodeId: pair.output.nodeId, port: pair.output.port },
            to: { nodeId: pair.input.nodeId, port: pair.input.port },
            type: pair.output.type
        });
        updatePortStyles();
        enforceEndpointNodeMinimum(pair);
        updateAllConnections();
        refreshNodeVisuals();
        scheduleSave();
        onConnectionsChanged();
        showToast?.('连接已创建', 'success');
        return true;
    }

    function handleNodeMouseDown(event, nodeId) {
        if (!isActive()) return false;
        const isPanAction = event.button === 1 || (event.button === 0 && event.altKey);
        if (isPanAction || event.button !== 0) return false;
        event.preventDefault();
        event.stopPropagation();
        connectTo(nodeId);
        return true;
    }

    function initBatchConnectionMode() {
        documentRef.addEventListener('keydown', (event) => {
            if (!isActive()) return;
            if (event.key === 'Escape') {
                exit({ showToast: true });
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);

        documentRef.addEventListener('keyup', (event) => {
            if (!isActive()) return;
            if (event.key === 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);

        documentRef.addEventListener('contextmenu', (event) => {
            if (!isActive()) return;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
    }

    return {
        initBatchConnectionMode,
        enter,
        exit,
        isActive,
        connectTo,
        handleNodeMouseDown
    };
}
