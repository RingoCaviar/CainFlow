/**
 * 管理从单个锚点节点出发的批量连线模式。
 */
import { isMultiConnectionInput } from '../nodes/reference-image-ports.js';
import { isUniversalInputNode, resolveUniversalInput } from '../nodes/universal-input-policy.js';
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
    connectPorts = null,
    validateConnection = null,
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
            portEl.hidden !== true &&
            !portEl.classList.contains('hidden') &&
            !portEl.classList.contains('image-first-canonical-input');
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
                multiple: isMultiConnectionInput(node.type, portEl.dataset.port),
                direction
            }))
            .filter((port) => port.port && port.type);
    }

    function isPortFree(port) {
        if (!port?.nodeId || !port.port || !port.direction) return false;
        if (port.direction === 'input') {
            if (port.multiple) return true;
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
        let error = '';
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
                for (const input of attempt.inputs) {
                    if (isUniversalInputNode(getNode(input.nodeId))) {
                        if (input.port !== 'auto') continue;
                        const policy = resolveUniversalInput({ state, sourceNode: getNode(output.nodeId),
                            sourcePort: output.port, sourceType: output.type, targetNode: getNode(input.nodeId) });
                        if (policy.error) { error = policy.error; continue; }
                        const source = { nodeId: output.nodeId, portName: output.port, dataType: output.type, isOutput: true };
                        const target = { nodeId: input.nodeId, port: 'auto', type: 'any', dir: 'input' };
                        const invalid = validateConnection?.(source, target);
                        if (invalid) { error = invalid; continue; }
                        return { output, input, source, target };
                    }
                    if (input.type === output.type && isPortFree(input) && !connectionExists(output, input)) return { output, input };
                }
            }
        }

        return error ? { error } : null;
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
        if (state.canvasPlanApplying || state.historyTransitionInProgress) {
            showToast?.('画布正在修改，请稍后再连接', 'warning');
            return false;
        }
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
        if (state.canvasPlanApplying || state.historyTransitionInProgress) {
            showToast?.('画布正在修改，请稍后再连接', 'warning');
            return true;
        }
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
        if (!pair?.output) {
            showToast?.(pair?.error || '没有可用的同类型空闲接口，无法创建连接', 'warning');
            return true;
        }

        if (pair.source) {
            if (!connectPorts) {
                showToast?.('通用输入连接服务尚不可用，请重新进入画布', 'warning');
                return true;
            }
            const error = validateConnection?.(pair.source, pair.target);
            if (error) { showToast?.(error, 'warning'); return true; }
            try {
                if (connectPorts(pair.source, pair.target)) {
                    enforceEndpointNodeMinimum(pair);
                    refreshNodeVisuals();
                }
            } catch (failure) { showToast?.(failure.message || '连接未完成，请重试', 'warning'); }
            return true;
        }
        try { pushHistory(); }
        catch (error) { showToast?.(error.message || '连接未完成，请重试', 'warning'); return true; }
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
