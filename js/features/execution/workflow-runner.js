import { getResolvedProviderForModel } from './provider-request-utils.js';

/**
 * 负责整条工作流的运行编排，包括前置校验、逐节点执行、重试与状态收尾。
 */
export function createWorkflowRunnerApi({
    state,
    nodeConfigs,
    documentRef = document,
    confirmRef = confirm,
    notificationRef = typeof Notification !== 'undefined' ? Notification : null,
    audioFactory = () => new Audio(),
    resolveExecutionPlan,
    normalizeRunOptions,
    getCachedOutputValue,
    executeNode,
    addNode,
    generateId,
    showToast,
    addLog,
    scheduleSave,
    updateAllConnections,
    updatePortStyles,
    refreshDependentImageResizePreviews = () => {},
    getAbortMessage,
    playNotificationSound
}) {
    function isAbortLikeError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        if (typeof err.message === 'string' && err.message.toLowerCase().includes('aborted')) return true;
        return false;
    }

    function clearAbortedNodeFeedback(nodeId) {
        const errorEl = documentRef.getElementById(`${nodeId}-error`);
        if (errorEl) {
            errorEl.innerHTML = '';
            errorEl.style.display = 'none';
        }

        const responseArea = documentRef.getElementById(`${nodeId}-response`);
        if (responseArea) {
            responseArea.innerHTML = '<div class="chat-response-placeholder">\u5DF2\u505C\u6B62\u751F\u6210</div>';
        }
    }

    function getRunningNodeIds() {
        if (!(state.runningNodeIds instanceof Set)) {
            state.runningNodeIds = new Set();
        }
        return state.runningNodeIds;
    }

    function getRunAbortControllers() {
        if (!(state.runAbortControllers instanceof Set)) {
            state.runAbortControllers = new Set();
        }
        return state.runAbortControllers;
    }

    function getRunningNodeCancelHandlers() {
        if (!(state.runningNodeCancelHandlers instanceof Map)) {
            state.runningNodeCancelHandlers = new Map();
        }
        return state.runningNodeCancelHandlers;
    }

    function getNodeDisplayTitle(node) {
        if (!node) return '节点';
        return node.customTitle || nodeConfigs[node.type]?.title || node.type;
    }

    function syncRunToolbarState() {
        const runBtn = documentRef.getElementById('btn-run');
        const stopBtn = documentRef.getElementById('btn-stop');
        const hasActiveRuns = (state.activeRunCount || 0) > 0;

        if (runBtn) {
            runBtn.classList.toggle('running', hasActiveRuns);
            runBtn.disabled = hasActiveRuns;
        }
        if (stopBtn) {
            stopBtn.classList.toggle('running', hasActiveRuns);
            stopBtn.disabled = !hasActiveRuns;
        }
    }

    function setControlRunningLock(control, locked) {
        if (!control) return;
        if (locked) {
            if (control.dataset.runningLockApplied !== '1') {
                control.dataset.runningLockApplied = '1';
                control.dataset.runningLockPrevDisabled = control.disabled ? '1' : '0';
            }
            control.disabled = true;
            return;
        }

        if (control.dataset.runningLockApplied === '1') {
            control.disabled = control.dataset.runningLockPrevDisabled === '1';
            delete control.dataset.runningLockApplied;
            delete control.dataset.runningLockPrevDisabled;
        }
    }

    function setNodeRunningLock(node, locked) {
        if (!node?.el) return;
        node.el.classList.toggle('running-locked', locked);
        node.el.querySelectorAll('input, select, textarea, button:not(.node-run-cancel-btn)').forEach((control) => {
            setControlRunningLock(control, locked);
        });
    }

    function markNodeRunning(nodeId, node) {
        getRunningNodeIds().add(nodeId);
        if (node?.el) {
            node.el.classList.add('running');
            node.el.classList.remove('completed', 'error');
        }
        setNodeRunningLock(node, true);
    }

    function clearNodeRunning(nodeId, node) {
        getRunningNodeIds().delete(nodeId);
        if (node?.el) {
            node.el.classList.remove('running', 'running-locked');
            node.el.querySelector('.node-run-cancel-btn')?.classList.remove('is-holding', 'is-canceling');
        }
        setNodeRunningLock(node, false);
    }

    function hasRunningNodeInPlan(plan) {
        const runningNodeIds = getRunningNodeIds();
        return (plan.executionOrder || plan.nodeIds || []).filter((nodeId) => runningNodeIds.has(nodeId));
    }

    function shouldResetNodeData(plan, nodeId) {
        if (plan.mode === 'all') return true;
        return plan.scopeNodeSet.has(nodeId);
    }

    function getPreservedNodeDataForReset(node) {
        if (!node?.data || typeof node.data !== 'object') return {};

        if (node.type === 'CameraControl') {
            return {
                pitch: node.data.pitch,
                yaw: node.data.yaw,
                distance: node.data.distance,
                fov: node.data.fov,
                roll: node.data.roll,
                text: node.data.text,
                cameraPrompt: node.data.cameraPrompt,
                cameraViewMode: node.data.cameraViewMode,
                cameraPreviewImage: node.data.cameraPreviewImage
            };
        }

        return {};
    }

    function resetNodesForPlan(plan, { preserveFixedCache = true, forceResetNodeIds = null } = {}) {
        const runningNodeIds = getRunningNodeIds();
        for (const [nid, node] of state.nodes) {
            if (!shouldResetNodeData(plan, nid)) continue;
            if (runningNodeIds.has(nid)) continue;

            const fixedToggle = documentRef.getElementById(`${nid}-fixed`);
            const isFixed = fixedToggle ? fixedToggle.checked : false;
            const forceReset = forceResetNodeIds?.has(nid) === true;

            if (!forceReset && preserveFixedCache && isFixed && node.isSucceeded && node.data && Object.keys(node.data).length > 0) {
                node.el.classList.add('completed');
                node.el.classList.remove('error', 'running');
                continue;
            }

            node.el.classList.remove('completed', 'error', 'running');
            removeConcurrentRequestStatusPanel(node);
            node.data = getPreservedNodeDataForReset(node);
            node.isSucceeded = false;
            if (node.type === 'ImageGenerate') {
                node.imageData = null;
                node.imageDataList = [];
                node.generationCompletedCount = 0;
                node.generatedImages = [];
            }
            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                delete node.apiGenerationProgress;
            }
        }
    }

    function isPromptProducedDuringPlan(plan, nodeId, connection) {
        const fromNode = state.nodes.get(connection.from.nodeId);
        if (!fromNode || fromNode.enabled === false) return false;
        if (!plan.scopeNodeSet.has(connection.from.nodeId)) return false;

        const order = plan.executionOrder || [];
        const fromIndex = order.indexOf(connection.from.nodeId);
        const toIndex = order.indexOf(nodeId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex >= toIndex) return false;

        if (fromNode.el?.querySelector(`.node-port[data-direction="output"][data-port="${connection.from.port}"][data-type="text"]`)) {
            return true;
        }
        const outputs = nodeConfigs[fromNode.type]?.outputs || [];
        return outputs.some((output) => output.name === connection.from.port && output.type === 'text');
    }

    function normalizeImageList(value) {
        if (typeof value === 'string') {
            return value.trim() ? [value] : [];
        }
        if (Array.isArray(value)) {
            return value.flatMap((item) => normalizeImageList(item));
        }
        if (value && typeof value === 'object') {
            return normalizeImageList(
                value.images ??
                value.image ??
                value.dataUrl ??
                value.url ??
                []
            );
        }
        return [];
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getNodeImageOutputList(node) {
        const images = normalizeImageList(node?.data?.images || node?.imageDataList || node?.generatedImages);
        return images.length > 0 ? images : null;
    }

    function getEnabledNodeOutputValue(fromNode, toNode, portName) {
        if (!fromNode || fromNode.enabled === false) return undefined;
        if (portName === 'image') {
            const images = getNodeImageOutputList(fromNode);
            if (images?.length > 1) return images;
            if (images?.length === 1) return images[0];
        }
        return getCachedOutputValue(fromNode, portName);
    }

    function cloneInputValue(value) {
        if (Array.isArray(value)) {
            return value.slice();
        }
        return value;
    }

    function captureSelectedOnlyExternalInputs(plan) {
        if (plan?.mode !== 'selected-only') return Object.create(null);

        const externalInputsByNode = Object.create(null);

        for (const nodeId of plan.nodeIds || []) {
            for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
                if (plan.scopeNodeSet.has(connection.from.nodeId)) continue;

                const fromNode = state.nodes.get(connection.from.nodeId);
                const toNode = state.nodes.get(nodeId);
                const outputValue = getEnabledNodeOutputValue(fromNode, toNode, connection.from.port);
                if (outputValue === undefined) continue;

                if (!externalInputsByNode[nodeId]) {
                    externalInputsByNode[nodeId] = Object.create(null);
                }
                externalInputsByNode[nodeId][connection.to.port] = cloneInputValue(outputValue);
            }
        }

        return externalInputsByNode;
    }

    function getInputValueForConnection(plan, nodeId, connection) {
        const isSelectedOnlyExternalInput = plan?.mode === 'selected-only' &&
            !plan.scopeNodeSet.has(connection.from.nodeId);
        if (isSelectedOnlyExternalInput) {
            const capturedValue = plan.externalInputsByNode?.[nodeId]?.[connection.to.port];
            if (capturedValue !== undefined) {
                return cloneInputValue(capturedValue);
            }
        }

        const fromNode = state.nodes.get(connection.from.nodeId);
        const toNode = state.nodes.get(nodeId);
        return getEnabledNodeOutputValue(fromNode, toNode, connection.from.port);
    }

    function hasPromptInputValue(plan, nodeId) {
        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            if (connection.to.port !== 'prompt') continue;
            const promptValue = getInputValueForConnection(plan, nodeId, connection);
            if (typeof promptValue === 'string' && promptValue.trim()) return true;
            if (promptValue !== undefined && promptValue !== null && promptValue !== '') return true;
            if (isPromptProducedDuringPlan(plan, nodeId, connection)) return true;
        }
        return false;
    }

    function collectInputsForNode(plan, nodeId) {
        const inputs = {};

        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            const outputValue = getInputValueForConnection(plan, nodeId, connection);
            if (outputValue !== undefined) {
                inputs[connection.to.port] = outputValue;
            }
        }

        return inputs;
    }

    function isBatchInputValue(value) {
        return Array.isArray(value) && value.length > 0;
    }

    function normalizeTextList(value) {
        if (Array.isArray(value)) {
            return value.filter((item) => typeof item === 'string');
        }
        return typeof value === 'string' ? [value] : [];
    }

    function isFixedTextChatWithCachedResult(node) {
        if (node?.type !== 'TextChat') return false;
        const fixedToggle = documentRef.getElementById(`${node.id}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        return isFixed && node.isSucceeded === true && typeof node.data?.text === 'string' && node.data.text.length > 0;
    }

    function shouldRunNodeForEachInput(node, inputs) {
        if (!node) return false;
        if (isFixedTextChatWithCachedResult(node)) return false;
        if (node.type === 'ImageMerge' || node.type === 'TextMerge' || node.type === 'ImagePreview' || node.type === 'ImageSave' || node.type === 'Text') return false;
        return Object.values(inputs || {}).some(isBatchInputValue);
    }

    function buildInputBatches(inputs) {
        const entries = Object.entries(inputs || {});
        if (entries.length === 0) return [{}];

        return entries.reduce((batches, [key, value]) => {
            const values = isBatchInputValue(value) ? value : [value];
            const nextBatches = [];
            batches.forEach((batch) => {
                values.forEach((item) => {
                    nextBatches.push({ ...batch, [key]: item });
                });
            });
            return nextBatches;
        }, [{}]);
    }

    function isConcurrentRequestModeEnabled() {
        return state.concurrentRequestMode === true;
    }

    async function commitConcurrentBatchResults(node, results = []) {
        if (!node) return;
        if (node.type === 'ImageGenerate') {
            const images = results.flatMap((result) => normalizeImageList(result?.images || result?.image));
            node.data = node.data || {};
            if (images.length > 0) {
                node.data.images = images.slice();
                node.data.image = images[images.length - 1];
            } else {
                delete node.data.images;
                delete node.data.image;
            }
            node.imageDataList = images.slice();
            node.imageData = images[images.length - 1] || null;
            node.generatedImages = images.slice();
            node.generationCompletedCount = images.length;
            node.isSucceeded = true;
            await refreshDependentImageResizePreviews(node.id);
            updateAllConnections();
            return;
        }

        if (node.type === 'TextChat') {
            const texts = results
                .map((result) => result?.text)
                .filter((value) => typeof value === 'string');
            node.data = node.data || {};
            if (texts.length > 0) {
                node.data.texts = texts.slice();
                node.data.text = texts[texts.length - 1];
            } else {
                delete node.data.texts;
                delete node.data.text;
            }
            node.lastResponse = results
                .map((result, index) => {
                    const text = result?.lastResponse
                        ? result.lastResponse
                        : (typeof result?.text === 'string' ? escapeHtml(result.text).replace(/\n/g, '<br>') : '');
                    return text ? `<div><strong>第 ${index + 1} 次</strong></div><div>${text}</div>` : '';
                })
                .filter(Boolean)
                .join('<hr />');
            const responseArea = documentRef.getElementById(`${node.id}-response`);
            if (responseArea) responseArea.innerHTML = node.lastResponse;
            node.isSucceeded = true;
            updateAllConnections();
        }
    }

    function getConcurrentRequestRetryLimit() {
        if (state.autoRetry !== true) return 0;
        const retries = parseInt(state.maxRetries, 10);
        return Number.isFinite(retries) && retries > 0 ? retries : 0;
    }

    async function executeConcurrentBatchRequest(node, batch, index, batchCount, signal, requestStatusTracker = null) {
        const requestsPerBatch = node?.type === 'ImageGenerate'
            ? getConfiguredImageGenerationCount(node)
            : 1;
        const requestOffset = index * requestsPerBatch;
        const markRequestRange = (status, options = {}) => {
            requestStatusTracker?.markRange(requestOffset, requestsPerBatch, status, options);
        };
        const executionContext = {
            concurrentExecution: true,
            batchIndex: index,
            batchCount,
            concurrentRequestStatus: createConcurrentRequestStatusContext(
                requestStatusTracker,
                requestOffset,
                requestsPerBatch
            )
        };
        if (node?.type !== 'TextChat') {
            try {
                const result = await executeNode(node, batch, signal, executionContext);
                markRequestRange('success', { onlyRunning: true });
                return result;
            } catch (error) {
                markRequestRange('failed', { onlyRunning: true });
                throw error;
            }
        }

        const maxRetries = getConcurrentRequestRetryLimit();
        let attempt = 0;
        while (true) {
            try {
                const result = await executeNode(node, batch, signal, executionContext);
                markRequestRange('success', { onlyRunning: true });
                return result;
            } catch (error) {
                if (isAbortLikeError(error)) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                const isRetryableRequestError = !!error?.serverResponse ||
                    error?.name === 'TypeError' ||
                    /failed to fetch|networkerror/i.test(String(error?.message || ''));
                if (!isRetryableRequestError) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                if (attempt >= maxRetries) {
                    markRequestRange('failed', { onlyRunning: true, error });
                    throw error;
                }
                attempt += 1;
                addLog('warning', `并发请求重试: ${getNodeDisplayTitle(node)}`, `正在第 ${attempt} 次重试第 ${index + 1}/${batchCount} 个请求。`, {
                    nodeId: node.id,
                    batchIndex: index,
                    attempt,
                    error: error?.message || String(error)
                });
            }
        }
    }

    function getConfiguredImageGenerationCount(node) {
        const input = documentRef.getElementById(`${node.id}-generation-count`);
        return Math.max(1, parseInt(input?.value || node?.generationCount || node?.data?.generationCount || '1', 10) || 1);
    }

    function getApiNodeRunCount(node, batchCount) {
        if (!node) return 0;
        const safeBatchCount = Math.max(1, parseInt(batchCount, 10) || 1);
        if (node.type === 'ImageGenerate') return safeBatchCount * getConfiguredImageGenerationCount(node);
        if (node.type === 'TextChat') return safeBatchCount;
        return 0;
    }

    function removeConcurrentRequestStatusPanel(node) {
        const panel = Array.from(node?.el?.children || [])
            .find((child) => child.classList?.contains('node-concurrent-status-panel'));
        if (panel) panel.remove();
    }

    function createConcurrentRequestStatusTracker(node, total) {
        const safeTotal = Math.max(1, parseInt(total, 10) || 1);
        removeConcurrentRequestStatusPanel(node);

        if (!node?.el) {
            return {
                total: safeTotal,
                mark: () => {},
                markRange: () => {}
            };
        }

        const panel = documentRef.createElement('div');
        panel.className = 'node-concurrent-status-panel';
        panel.dataset.total = String(safeTotal);
        panel.setAttribute('aria-label', 'Concurrent request status');

        const grid = documentRef.createElement('div');
        grid.className = 'node-concurrent-status-grid';
        panel.appendChild(grid);

        const dots = Array.from({ length: safeTotal }, (_, index) => {
            const dot = documentRef.createElement('span');
            dot.className = 'node-concurrent-status-dot';
            dot.dataset.status = 'running';
            dot.title = `Request ${index + 1}: running`;
            grid.appendChild(dot);
            return dot;
        });

        node.el.appendChild(panel);

        const errorPopover = documentRef.createElement('div');
        errorPopover.className = 'node-concurrent-status-error-popover hidden';
        panel.appendChild(errorPopover);

        const formatErrorMessage = (error) => {
            if (!error) return '请求失败，但没有返回具体错误信息。';
            if (typeof error === 'string') return error;
            if (error?.serverResponse?.body) return String(error.serverResponse.body);
            if (error?.message) return String(error.message);
            return String(error);
        };

        const hideErrorPopover = () => {
            errorPopover.classList.add('hidden');
            errorPopover.textContent = '';
        };

        const setDotStatus = (index, status, error = null) => {
            const dot = dots[index];
            if (!dot) return;
            const normalizedStatus = status === 'success' || status === 'failed' ? status : 'running';
            dot.dataset.status = normalizedStatus;
            if (normalizedStatus === 'failed') {
                const errorMessage = formatErrorMessage(error);
                dot.dataset.error = errorMessage;
                dot.title = `Request ${index + 1}: failed\n${errorMessage}`;
                dot.setAttribute('role', 'button');
                dot.tabIndex = 0;
            } else {
                delete dot.dataset.error;
                dot.title = `Request ${index + 1}: ${normalizedStatus}`;
                dot.removeAttribute('role');
                dot.removeAttribute('tabindex');
            }
        };

        grid.addEventListener('click', (event) => {
            const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
            if (!dot || !grid.contains(dot)) return;
            event.stopPropagation();
            const message = dot.dataset.error || '请求失败，但没有返回具体错误信息。';
            errorPopover.textContent = message;
            errorPopover.classList.remove('hidden');
        });

        grid.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const dot = event.target.closest('.node-concurrent-status-dot[data-status="failed"]');
            if (!dot) return;
            event.preventDefault();
            dot.click();
        });

        panel.addEventListener('mouseleave', hideErrorPopover);

        return {
            total: safeTotal,
            mark(index, status, error = null) {
                setDotStatus(index, status, error);
            },
            markRange(start, count, status, { onlyRunning = false, error = null } = {}) {
                const safeStart = Math.max(0, parseInt(start, 10) || 0);
                const safeCount = Math.max(0, parseInt(count, 10) || 0);
                for (let offset = 0; offset < safeCount; offset += 1) {
                    const index = safeStart + offset;
                    if (onlyRunning && dots[index]?.dataset.status !== 'running') continue;
                    setDotStatus(index, status, error);
                }
            }
        };
    }

    function createConcurrentRequestStatusContext(requestStatusTracker, requestOffset = 0, requestsPerBatch = 1) {
        return {
            requestOffset,
            requestsPerBatch,
            markRequestStatus(relativeIndex, status, error = null) {
                const safeIndex = Math.max(0, parseInt(relativeIndex, 10) || 0);
                requestStatusTracker?.mark(requestOffset + safeIndex, status, error);
            }
        };
    }

    async function executeStandaloneConcurrentImageRequests(node, inputs, signal) {
        const requestCount = getConfiguredImageGenerationCount(node);
        const requestStatusTracker = createConcurrentRequestStatusTracker(node, requestCount);
        try {
            const result = await executeNode(node, inputs, signal, {
                concurrentRequestStatus: createConcurrentRequestStatusContext(requestStatusTracker, 0, requestCount)
            });
            requestStatusTracker.markRange(0, requestCount, 'success', { onlyRunning: true });
            return result;
        } catch (error) {
            requestStatusTracker.markRange(0, requestCount, 'failed', { onlyRunning: true, error });
            throw error;
        }
    }

    function shouldTrackStandaloneConcurrentImageRequests(node) {
        return isConcurrentRequestModeEnabled() &&
            node?.type === 'ImageGenerate' &&
            getConfiguredImageGenerationCount(node) > 1;
    }

    function renderApiNodeGenerationProgress(node, current, total) {
        if (!node?.id) return;
        const progressEl = documentRef.getElementById(`${node.id}-generation-progress`);
        if (!progressEl) return;
        const safeTotal = Math.max(1, parseInt(total, 10) || 1);
        const safeCurrent = Math.max(0, Math.min(safeTotal, parseInt(current, 10) || 0));
        progressEl.textContent = `${safeCurrent}/${safeTotal}`;
        progressEl.dataset.total = String(safeTotal);
        progressEl.classList.remove('hidden');
    }

    function prepareApiNodeGenerationProgress(node, batchCount) {
        const total = getApiNodeRunCount(node, batchCount);
        if (total <= 0) return;
        const existingProgress = node.apiGenerationProgress;
        const shouldPreserveCompleted = existingProgress &&
            Math.max(1, parseInt(existingProgress.total, 10) || 1) === total &&
            node.isSucceeded !== true;
        const completed = shouldPreserveCompleted
            ? Math.max(0, Math.min(total, parseInt(existingProgress.completed, 10) || 0))
            : 0;
        node.apiGenerationProgress = { total, completed };
        renderApiNodeGenerationProgress(node, completed, total);
    }

    function getNodeOutputPortNames(node, dataType) {
        const names = new Set();
        node?.el?.querySelectorAll(`.node-port[data-direction="output"][data-type="${dataType}"]`).forEach((portEl) => {
            if (portEl.dataset.port) names.add(portEl.dataset.port);
        });
        (nodeConfigs[node?.type]?.outputs || []).forEach((output) => {
            if (output.type === dataType && output.name) names.add(output.name);
        });
        return Array.from(names);
    }

    function resetNodeImageOutputsForBatch(node) {
        if (!node) return;
        node.data = node.data || {};
        delete node.data.images;
        delete node.data.image;
        node.imageData = null;
        node.imageDataList = [];
        if (node.type === 'ImageGenerate') {
            node.generatedImages = [];
            node.generationCompletedCount = 0;
        }
    }

    function resetNodeTextOutputsForBatch(node) {
        if (!node) return;
        node.data = node.data || {};
        delete node.data.texts;
        delete node.data.text;
        if (node.type === 'TextChat') {
            node.isSucceeded = false;
            node.lastResponse = '';
        }
    }

    async function executeNodeWithInputBatches(node, inputs, signal) {
        const shouldRunBatches = shouldRunNodeForEachInput(node, inputs);
        const batches = shouldRunBatches ? buildInputBatches(inputs) : [inputs || {}];
        prepareApiNodeGenerationProgress(node, batches.length);

        if (!shouldRunBatches) {
            if (shouldTrackStandaloneConcurrentImageRequests(node)) {
                await executeStandaloneConcurrentImageRequests(node, inputs, signal);
            } else {
                await executeNode(node, inputs, signal);
            }
            return inputs;
        }

        const shouldRunConcurrentBatches = isConcurrentRequestModeEnabled() &&
            (node?.type === 'ImageGenerate' || node?.type === 'TextChat') &&
            batches.length > 1;
        if (shouldRunConcurrentBatches) {
            if (node.type === 'ImageGenerate') resetNodeImageOutputsForBatch(node);
            if (node.type === 'TextChat') resetNodeTextOutputsForBatch(node);
            delete node.apiGenerationProgress;
            prepareApiNodeGenerationProgress(node, batches.length);
            const retryEnabled = state.autoRetry === true && getConcurrentRequestRetryLimit() > 0;
            addLog('info', `并发执行节点: ${getNodeDisplayTitle(node)}`, retryEnabled
                ? `检测到 ${batches.length} 组输入，将并发发起请求，并仅在自动重试开启时重试失败项。`
                : `检测到 ${batches.length} 组输入，将并发发起请求；失败项不会自动重试，成功结果会继续传递到下游。`, {
                nodeId: node.id,
                batchCount: batches.length
            });

            const requestStatusTracker = createConcurrentRequestStatusTracker(
                node,
                getApiNodeRunCount(node, batches.length)
            );
            const settled = await Promise.allSettled(batches.map((batch, index) => (
                executeConcurrentBatchRequest(node, batch, index, batches.length, signal, requestStatusTracker)
            )));
            const rejected = settled.filter((result) => result.status === 'rejected');
            const abortRejection = rejected.find((result) => isAbortLikeError(result.reason));
            if (abortRejection) {
                throw abortRejection.reason;
            }
            const batchResults = settled
                .filter((result) => result.status === 'fulfilled')
                .map((result) => result.value || {});
            if (rejected.length > 0) {
                addLog(batchResults.length > 0 ? 'warning' : 'error', `并发请求部分失败: ${getNodeDisplayTitle(node)}`, `${settled.length} 个请求中 ${rejected.length} 个失败，${batchResults.length} 个成功。${batchResults.length > 0 ? '将仅把成功结果传递到下游。' : '没有可传递的成功结果。'}`, {
                    nodeId: node.id,
                    batchCount: settled.length,
                    successCount: batchResults.length,
                    failedCount: rejected.length,
                    errors: rejected.map((result) => result.reason?.message || String(result.reason))
                });
            }
            if (batchResults.length === 0 && rejected.length > 0) {
                throw rejected[0].reason;
            }
            await commitConcurrentBatchResults(node, batchResults);
            return batches[batches.length - 1] || inputs;
        }

        if (shouldTrackStandaloneConcurrentImageRequests(node) && batches.length === 1) {
            await executeStandaloneConcurrentImageRequests(node, batches[0], signal);
            return batches[0] || inputs;
        }

        const aggregatedImages = [];
        const textOutputPorts = getNodeOutputPortNames(node, 'text');
        const aggregatedTextsByPort = new Map(textOutputPorts.map((portName) => [portName, []]));
        const shouldAggregateImages = getNodeOutputPortNames(node, 'image').length > 0;
        const shouldAggregateTexts = textOutputPorts.length > 0;
        addLog('info', `批量执行节点: ${getNodeDisplayTitle(node)}`, `检测到多图输入，将顺序运行 ${batches.length} 次`, {
            nodeId: node.id,
            batchCount: batches.length
        });

        for (let index = 0; index < batches.length; index += 1) {
            if (signal?.aborted) {
                const abortError = new Error('Node run aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }

            if (shouldAggregateImages) resetNodeImageOutputsForBatch(node);
            if (shouldAggregateTexts) resetNodeTextOutputsForBatch(node);
            await executeNode(node, batches[index], signal);

            if (shouldAggregateImages) {
                const imageOutputs = normalizeImageList(node?.data?.images || node?.imageDataList || node?.data?.image || node?.imageData);
                aggregatedImages.push(...imageOutputs);
            }
            if (shouldAggregateTexts) {
                textOutputPorts.forEach((portName) => {
                    const values = normalizeTextList(getCachedOutputValue(node, portName));
                    if (values.length > 0) {
                        aggregatedTextsByPort.get(portName).push(...values);
                    }
                });
            }
        }

        if (shouldAggregateImages && aggregatedImages.length > 0) {
            node.data = node.data || {};
            node.data.images = aggregatedImages.slice();
            node.data.image = aggregatedImages[aggregatedImages.length - 1];
            node.imageDataList = aggregatedImages.slice();
            node.imageData = node.data.image;
            if (node.type === 'ImageGenerate') {
                node.generatedImages = aggregatedImages.slice();
                node.generationCompletedCount = aggregatedImages.length;
            }
        }

        if (shouldAggregateTexts) {
            node.data = node.data || {};
            aggregatedTextsByPort.forEach((values, portName) => {
                if (values.length === 0) return;
                node.data[portName] = values.length > 1 ? values.slice() : values[0];
                if (portName === 'text') {
                    node.data.texts = values.slice();
                    node.data.text = values[values.length - 1];
                }
            });
            if (node.type === 'TextChat') {
                const aggregatedTexts = aggregatedTextsByPort.get('text') || [];
                node.lastResponse = aggregatedTexts
                    .map((text, index) => `<div><strong>第 ${index + 1} 次</strong></div><div>${escapeHtml(text).replace(/\n/g, '<br>')}</div>`)
                    .join('<hr />');
                const responseArea = documentRef.getElementById(`${node.id}-response`);
                if (responseArea) responseArea.innerHTML = node.lastResponse;
            }
        }

        return batches[batches.length - 1] || inputs;
    }

    function collectDownstreamNodeIds(plan, sourceNodeId) {
        const downstream = new Set();
        const queue = [sourceNodeId];

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (downstream.has(currentId)) continue;
            downstream.add(currentId);

            state.connections
                .filter((connection) => (
                    connection.from.nodeId === currentId &&
                    plan.scopeNodeSet.has(connection.to.nodeId)
                ))
                .forEach((connection) => {
                    if (!downstream.has(connection.to.nodeId)) {
                        queue.push(connection.to.nodeId);
                    }
                });
        }

        return downstream;
    }

    function createLinkedAbortSignal(signals) {
        const controller = new AbortController();
        const validSignals = signals.filter(Boolean);
        const abort = () => {
            if (!controller.signal.aborted) {
                controller.abort();
            }
        };

        for (const signal of validSignals) {
            if (signal.aborted) {
                abort();
                break;
            }
            signal.addEventListener('abort', abort, { once: true });
        }

        return {
            signal: controller.signal,
            cleanup() {
                validSignals.forEach((signal) => {
                    signal.removeEventListener('abort', abort);
                });
            }
        };
    }

    function unregisterNodeCancelHandler(session, nodeId) {
        getRunningNodeCancelHandlers().delete(nodeId);
        session.nodeAbortControllers?.delete(nodeId);
    }

    function cancelRunningNode(nodeId) {
        const handler = getRunningNodeCancelHandlers().get(nodeId);
        if (typeof handler !== 'function') return false;
        handler();
        return true;
    }

    async function runWorkflow(runInput = null) {
        if (state.nodes.size === 0) {
            showToast('当前画布没有任何节点，请先添加节点或加载工作流', 'warning');
            return;
        }
        let runOptions = normalizeRunOptions(runInput);
        let plan = resolveExecutionPlan(runOptions);
        if (!plan) return;
        plan.externalInputsByNode = captureSelectedOnlyExternalInputs(plan);

        const alreadyRunningNodeIds = hasRunningNodeInPlan(plan);
        if (alreadyRunningNodeIds.length > 0) {
            showToast(`当前运行范围内有 ${alreadyRunningNodeIds.length} 个节点仍在运行，请等待这些节点完成后再运行`, 'warning');
            return;
        }

        const missingKeysProviders = new Set();
        for (const id of plan.nodeIds) {
            const node = state.nodes.get(id);
            if (!node) continue;
            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                const configSelect = documentRef.getElementById(`${id}-apiconfig`);
                if (configSelect) {
                    const modelCfg = state.models.find((model) => model.id === configSelect.value);
                    if (modelCfg) {
                        const selectedProviderId = documentRef.getElementById(`${id}-provider`)?.value || state.nodes.get(id)?.providerId || '';
                        const apiCfg = getResolvedProviderForModel(modelCfg, state.providers, selectedProviderId);
                        if (apiCfg && !apiCfg.apikey.trim()) {
                            missingKeysProviders.add(apiCfg.name);
                        }
                    }
                }
            }
        }

        if (missingKeysProviders.size > 0) {
            const names = Array.from(missingKeysProviders).join(', ');
            const msg = `场景中存在未配置 API 密钥的模型（涉及供应商: ${names}），可能会导致执行报错。\n\n您确定要强制继续运行吗？`;
            if (!confirmRef(msg)) {
                return;
            }
        }

        const session = {
            controller: new AbortController(),
            timeoutId: null,
            stopped: false,
            abortReason: null,
            finalized: false,
            canceledBranchNodeIds: new Set(),
            nodeAbortControllers: new Map()
        };
        getRunAbortControllers().add(session.controller);
        state.activeRunCount = (state.activeRunCount || 0) + 1;
        state.isRunning = true;
        state.abortReason = null;
        state.abortController = session.controller;
        syncRunToolbarState();
        if (state.requestTimeoutEnabled) {
            const timeoutMs = Math.max(1, parseInt(state.requestTimeoutSeconds, 10) || 60) * 1000;
            session.timeoutId = setTimeout(() => {
                if (session.finalized || session.controller.signal.aborted) return;
                session.abortReason = 'timeout';
                state.abortReason = 'timeout';
                session.stopped = true;
                session.controller.abort();
            }, timeoutMs);
        }

        if (state.notificationsEnabled) {
            if (!state.notificationAudio) {
                state.notificationAudio = audioFactory();
                state.notificationAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
                state.notificationAudio.loop = true;
            }
            state.notificationAudio.muted = false;
            state.notificationAudio.volume = 0.001;
            state.notificationAudio.play().catch((e) => {
                console.warn('Audio warm-up blocked:', e);
                addLog('warning', '音频保活受限', '浏览器禁用了后台音频，通知音效可能在非活动状态下失效，请确保已与页面交互。');
            });
        }

        const forceResetNodeIds = new Set();
        if (runOptions.mode === 'target-node' && runOptions.targetNodeId) {
            forceResetNodeIds.add(runOptions.targetNodeId);
        }

        resetNodesForPlan(plan, { forceResetNodeIds });

        let order = plan.executionOrder.slice();

        const emptyImageNodes = [];
        for (const nid of order) {
            const node = state.nodes.get(nid);
            if (node && node.enabled !== false && node.type === 'ImageImport' && !getCachedOutputValue(node, 'image')) {
                emptyImageNodes.push(nid);
            }
        }

        if (emptyImageNodes.length > 0) {
            showToast(`执行中止：当前路径中有 ${emptyImageNodes.length} 个图片导入节点未加载图片`, 'error', 5000);
            emptyImageNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    node.el.classList.add('error');
                    addLog('error', '前置检查未通过', `节点「图片导入」(${nid}) 未载入素材图片`);
                }
            });
            finalizeWorkflow();
            return;
        }

        const emptyPromptNodes = [];
        for (const nid of order) {
            const node = state.nodes.get(nid);
            if (node && node.enabled !== false && node.type === 'TextChat') {
                const fixedToggle = documentRef.getElementById(`${nid}-fixed`);
                if (fixedToggle && fixedToggle.checked && node.isSucceeded) continue;

                const textareaValue = documentRef.getElementById(`${nid}-prompt`)?.value || '';
                const hasPromptInput = hasPromptInputValue(plan, nid);
                if (!hasPromptInput && !textareaValue.trim()) {
                    emptyPromptNodes.push(nid);
                }
            }
        }

        if (emptyPromptNodes.length > 0) {
            showToast(`执行中止：当前路径中有 ${emptyPromptNodes.length} 个智能对话节点内容为空`, 'error', 5000);
            emptyPromptNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    node.el.classList.add('error');
                    addLog('error', '前置检查未通过', `节点「智能对话」(${nid}) 提示词内容缺失（连线或文本框均无内容）`);
                }
            });
            finalizeWorkflow();
            return;
        }

        if (state.globalSaveDirHandle) {
            const hasSaveNode = order.some((nid) => state.nodes.get(nid)?.type === 'ImageSave');
            if (hasSaveNode) {
                try {
                    const status = await state.globalSaveDirHandle.queryPermission({ mode: 'readwrite' });
                    if (status !== 'granted') {
                        addLog('info', '目录授权请求', '尝试获取保存目录的写入权限...');
                        const req = await state.globalSaveDirHandle.requestPermission({ mode: 'readwrite' });
                        if (req !== 'granted') {
                            showToast('自动保存未授权：工作流将继续，但图片无法自动落盘', 'warning', 4000);
                            addLog('warning', '目录授权失败', '用户拒绝了目录访问请求，图片将仅保存在节点内');
                        } else {
                            addLog('success', '目录授权成功', '自动保存功能已就绪');
                        }
                    }
                } catch (e) {
                    console.warn('Directory permission verify failed:', e);
                }
            }
        }

        function finalizeWorkflow() {
            if (session.finalized) return;
            session.finalized = true;
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }
            const controllers = getRunAbortControllers();
            controllers.delete(session.controller);
            for (const nodeId of Array.from(session.nodeAbortControllers.keys())) {
                unregisterNodeCancelHandler(session, nodeId);
            }
            state.activeRunCount = Math.max(0, (state.activeRunCount || 0) - 1);
            state.isRunning = state.activeRunCount > 0;
            state.abortController = Array.from(controllers).at(-1) || null;
            if (!state.isRunning) {
                state.abortReason = null;
            }
            syncRunToolbarState();
        }

        if (plan.mode !== 'selected-only') {
            let injected = false;
            for (const nid of order) {
                const node = state.nodes.get(nid);
                if (node && node.type === 'ImageGenerate') {
                    const hasConnection = state.connections.some((c) => c.from.nodeId === nid && c.from.port === 'image');
                    if (!hasConnection) {
                        const rect = node.el.getBoundingClientRect();
                        const nodeWidth = rect.width || 240;
                        const saveId = addNode('ImageSave', node.x + nodeWidth + 80, node.y);
                        if (saveId) {
                            state.connections.push({
                                id: 'conn_' + generateId(),
                                from: { nodeId: nid, port: 'image', type: 'image' },
                                to: { nodeId: saveId, port: 'image', type: 'image' },
                                type: 'image'
                            });
                            injected = true;
                            addLog('info', '自动注入节点', `为「${getNodeDisplayTitle(node)}」自动添加了图片保存节点`);
                        }
                    }
                }
            }
            if (injected) {
                updateAllConnections();
                updatePortStyles();
                runOptions = normalizeRunOptions(runOptions);
                plan = resolveExecutionPlan(runOptions);
                if (!plan) {
                    finalizeWorkflow();
                    return;
                }
                order = plan.executionOrder.slice();
                resetNodesForPlan(plan, { forceResetNodeIds });
            }
        }

        const totalWorkflowStartTime = Date.now();
        addLog('info', '并发工作流启动', `开始运行 ${order.length} 个节点...`);

        let retryAttempt = 0;
        const maxRetries = state.maxRetries || 15;
        const completedNodes = new Set();
        const failedNodes = new Set();
        const runningNodes = new Set();
        let terminatedByError = false;
        const isRunActive = () => !session.stopped && !session.controller.signal.aborted;

        const markNodeBranchCanceled = (nodeId) => {
            if (!runningNodes.has(nodeId)) return false;

            const branchNodeIds = collectDownstreamNodeIds(plan, nodeId);
            let newlyCanceledCount = 0;
            branchNodeIds.forEach((branchNodeId) => {
                if (!session.canceledBranchNodeIds.has(branchNodeId)) {
                    session.canceledBranchNodeIds.add(branchNodeId);
                    failedNodes.delete(branchNodeId);
                    newlyCanceledCount += 1;
                }
            });

            const nodeController = session.nodeAbortControllers.get(nodeId);
            if (nodeController && !nodeController.signal.aborted) {
                nodeController.abort();
            }

            const node = state.nodes.get(nodeId);
            const nodeTitle = node ? getNodeDisplayTitle(node) : nodeId;
            const downstreamCount = Math.max(0, branchNodeIds.size - 1);
            addLog('warning', `节点已取消: ${nodeTitle}`, downstreamCount > 0
                ? `已取消当前节点，并跳过 ${downstreamCount} 个下游节点`
                : '已取消当前节点');
            showToast(downstreamCount > 0
                ? `已取消当前节点，下游 ${downstreamCount} 个节点不会继续运行`
                : '已取消当前节点运行', 'info', 4000);
            return newlyCanceledCount > 0;
        };

        try {
            while (true) {
                while (true) {
                    if (!isRunActive()) break;

                    const readyNodes = order.filter((nid) => {
                        if (session.canceledBranchNodeIds.has(nid)) return false;
                        if (completedNodes.has(nid) || runningNodes.has(nid) || failedNodes.has(nid)) return false;
                        const node = state.nodes.get(nid);
                        if (!node || node.enabled === false) {
                            completedNodes.add(nid);
                            return false;
                        }

                        const deps = (plan.incomingConnectionsByNode[nid] || []).map((c) => c.from.nodeId);
                        return deps.every((dnid) => completedNodes.has(dnid));
                    });

                    if (readyNodes.length === 0 && runningNodes.size === 0) break;

                    if (readyNodes.length > 0) {
                        readyNodes.forEach((nid) => {
                            if (session.canceledBranchNodeIds.has(nid) || runningNodes.has(nid) || completedNodes.has(nid)) return;
                            runningNodes.add(nid);
                            const node = state.nodes.get(nid);
                            const nodeTitle = getNodeDisplayTitle(node);
                            const nodeController = new AbortController();
                            const linkedAbort = createLinkedAbortSignal([
                                session.controller.signal,
                                nodeController.signal
                            ]);
                            session.nodeAbortControllers.set(nid, nodeController);
                            getRunningNodeCancelHandlers().set(nid, () => markNodeBranchCanceled(nid));

                            (async () => {
                                markNodeRunning(nid, node);
                                const timeBadge = documentRef.getElementById(`${nid}-time`);
                                const timeContainer = documentRef.getElementById(`${nid}-time-container`);
                                const startTime = Date.now();
                                node.runStartedAt = startTime;
                                let timerId = null;
                                if (timeBadge) {
                                    if (timeContainer) timeContainer.style.display = 'flex';
                                    timerId = setInterval(() => {
                                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                                        timeBadge.textContent = `${elapsed}s`;
                                        if (elapsed > 60) timeBadge.style.color = 'var(--accent-red)';
                                        else timeBadge.style.color = '';
                                    }, 100);
                                }

                                try {
                                    const inputs = collectInputsForNode(plan, nid);
                                    const loggedInputs = await executeNodeWithInputBatches(node, inputs, linkedAbort.signal);

                                    if (session.canceledBranchNodeIds.has(nid) || nodeController.signal.aborted) {
                                        const abortError = new Error('Node run aborted');
                                        abortError.name = 'AbortError';
                                        throw abortError;
                                    }

                                    if (timerId) clearInterval(timerId);
                                    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                                    node.isSucceeded = true;
                                    node.lastDuration = durationSec;
                                    node.runStartedAt = null;
                                    clearNodeRunning(nid, node);
                                    node.el.classList.add('completed');
                                    if (timeBadge) {
                                        timeBadge.textContent = `${durationSec}s`;
                                        timeBadge.style.color = '';
                                    }
                                    addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, { nodeId: nid, inputs: loggedInputs, data: node.data });
                                    scheduleSave();
                                    completedNodes.add(nid);
                                } catch (err) {
                                    if (isAbortLikeError(err)) {
                                        node.runStartedAt = null;
                                        clearNodeRunning(nid, node);
                                        clearAbortedNodeFeedback(nid);
                                        if (session.abortReason) state.abortReason = session.abortReason;
                                        if (!session.canceledBranchNodeIds.has(nid)) {
                                            addLog('warning', `节点已中止: ${nodeTitle}`, getAbortMessage(state));
                                        }
                                        return;
                                    }
                                    clearNodeRunning(nid, node);
                                    node.runStartedAt = null;
                                    node.el.classList.add('error');
                                    const errorMsg = err.message || '未知错误';
                                    if (timeBadge) timeBadge.textContent = 'Err';
                                    const errorDetails = err.serverResponse || { nodeId: nid, error: err.stack || err };
                                    addLog('error', `节点失败: ${nodeTitle}`, errorMsg, errorDetails, {
                                        userFacing: err.userFacing || null
                                    });

                                    failedNodes.add(nid);

                                    if (!state.autoRetry) {
                                        showToast(`「${nodeTitle}」出错: ${errorMsg}`, 'error', 5000);
                                        terminatedByError = true;
                                        session.stopped = true;
                                    }
                                } finally {
                                    if (timerId) clearInterval(timerId);
                                    linkedAbort.cleanup();
                                    clearNodeRunning(nid, node);
                                    unregisterNodeCancelHandler(session, nid);
                                    runningNodes.delete(nid);
                                }
                            })();
                        });
                    }

                    await new Promise((resolve) => setTimeout(resolve, 100));
                    if (!isRunActive()) break;
                }

                if (!isRunActive()) break;

                const actualFailures = order.filter((id) => {
                    if (session.canceledBranchNodeIds.has(id)) return false;
                    const node = state.nodes.get(id);
                    return node && node.enabled !== false && !completedNodes.has(id);
                });

                if (actualFailures.length === 0) {
                    if (retryAttempt > 0) {
                        addLog('success', '工作流并行重试完成', `经过 ${retryAttempt} 次重试后，所有节点已成功执行。`);
                    }
                    break;
                }

                if (!state.autoRetry) break;

                retryAttempt++;
                if (retryAttempt > maxRetries) {
                    showToast(`已达到最大重试次数 (${maxRetries})，停止运行`, 'error');
                    addLog('error', '并行工作流强制终止', `已超过设定的最大自动重试次数 (${maxRetries} 轮)，执行已停止。请检查网络稳定性或节点配置。`);
                    terminatedByError = true;
                    break;
                }

                addLog('warning', `自动重试开始（第 ${retryAttempt} 轮）`, `${actualFailures.length} 个节点未成功，正在准备重新执行相关分支...`);
                showToast(`正在启动第 ${retryAttempt} 轮自动重试（${actualFailures.length} 个节点）...`, 'warning', 4000);
                failedNodes.clear();
                await new Promise((resolve) => setTimeout(resolve, 1500));
                if (!isRunActive()) break;
            }
        } finally {
            if (session.timeoutId) {
                clearTimeout(session.timeoutId);
                session.timeoutId = null;
            }
            if (!isRunActive()) {
                if (session.abortReason) state.abortReason = session.abortReason;
                addLog('info', '工作流停止', getAbortMessage(state));
                for (const nid of runningNodes) {
                    const node = state.nodes.get(nid);
                    if (node) clearNodeRunning(nid, node);
                }
            }

            for (const [id, node] of state.nodes) {
                if (node.type === 'ImageSave' && node.data.image) {
                    const btnSave = node.el.querySelector(`#${id}-manual-save`);
                    const btnView = node.el.querySelector(`#${id}-view-full`);
                    if (btnSave) btnSave.disabled = false;
                    if (btnView) btnView.disabled = false;
                }
            }

            const hasNodeBranchCancellation = session.canceledBranchNodeIds.size > 0;
            const completedRun = !terminatedByError && isRunActive() && !hasNodeBranchCancellation;
            const abortReason = session.abortReason || state.abortReason;
            finalizeWorkflow();

            if (state.notificationsEnabled) {
                const totalDuration = ((Date.now() - totalWorkflowStartTime) / 1000).toFixed(2);

                if (terminatedByError) {
                    showToast(`工作流运行停止，耗时 ${totalDuration}s`, 'error', 6000);
                    if (notificationRef && notificationRef.permission === 'granted') {
                        new notificationRef('CainFlow 运行出错', {
                            body: `工作流已停止，部分节点执行失败。耗时 ${totalDuration}s`,
                            icon: 'data:image/svg+xml;base64,...'
                        });
                    }
                    playNotificationSound();
                } else if (completedRun) {
                    showToast(`工作流运行完成，总耗时 ${totalDuration}s`, 'success', 6000);
                    if (notificationRef && notificationRef.permission === 'granted') {
                        new notificationRef('CainFlow 运行完毕', {
                            body: `所有节点执行成功，总耗时 ${totalDuration}s`,
                            icon: 'data:image/svg+xml;base64,...'
                        });
                    }
                    playNotificationSound();
                } else if (hasNodeBranchCancellation && isRunActive()) {
                    showToast(`已跳过被取消节点的下游，其余节点已结束，耗时 ${totalDuration}s`, 'info', 6000);
                    playNotificationSound();
                } else if (abortReason === 'timeout') {
                    showToast('请求超时，生成失败', 'error');
                } else {
                    showToast('已手动停止运行', 'info');
                }
            }
        }
    }

    return {
        runWorkflow,
        cancelRunningNode
    };
}
