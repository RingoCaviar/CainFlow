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

    function shouldResetNodeData(plan, nodeId) {
        if (plan.mode === 'all') return true;
        return plan.scopeNodeSet.has(nodeId);
    }

    function resetNodesForPlan(plan) {
        for (const [nid, node] of state.nodes) {
            if (!shouldResetNodeData(plan, nid)) continue;

            const fixedToggle = documentRef.getElementById(`${nid}-fixed`);
            const isFixed = fixedToggle ? fixedToggle.checked : false;

            if (isFixed && node.isSucceeded && node.data && Object.keys(node.data).length > 0) {
                node.el.classList.add('completed');
                node.el.classList.remove('error', 'running');
                continue;
            }

            node.el.classList.remove('completed', 'error', 'running');
            node.data = {};
            node.isSucceeded = false;
            if (node.type === 'ImageGenerate') {
                node.generationCompletedCount = 0;
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

        const outputs = nodeConfigs[fromNode.type]?.outputs || [];
        return outputs.some((output) => output.name === connection.from.port && output.type === 'text');
    }

    function hasPromptInputValue(plan, nodeId) {
        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            if (connection.to.port !== 'prompt') continue;
            const fromNode = state.nodes.get(connection.from.nodeId);
            const promptValue = getCachedOutputValue(fromNode, connection.from.port);
            if (typeof promptValue === 'string' && promptValue.trim()) return true;
            if (promptValue !== undefined && promptValue !== null && promptValue !== '') return true;
            if (isPromptProducedDuringPlan(plan, nodeId, connection)) return true;
        }
        return false;
    }

    function collectInputsForNode(plan, nodeId) {
        const inputs = {};

        for (const connection of plan.inputConnectionsByNode[nodeId] || []) {
            const fromNode = state.nodes.get(connection.from.nodeId);
            const outputValue = getCachedOutputValue(fromNode, connection.from.port);
            if (outputValue !== undefined) {
                inputs[connection.to.port] = outputValue;
            }
        }

        return inputs;
    }

    async function runWorkflow(runInput = null) {
        if (state.nodes.size === 0) {
            showToast('当前画布没有任何节点，请先添加节点或加载工作流', 'warning');
            return;
        }
        if (state.isRunning) return;

        let runOptions = normalizeRunOptions(runInput);
        let plan = resolveExecutionPlan(runOptions);
        if (!plan) return;

        const missingKeysProviders = new Set();
        for (const id of plan.nodeIds) {
            const node = state.nodes.get(id);
            if (!node) continue;
            if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
                const configSelect = documentRef.getElementById(`${id}-apiconfig`);
                if (configSelect) {
                    const modelCfg = state.models.find((model) => model.id === configSelect.value);
                    if (modelCfg) {
                        const apiCfg = state.providers.find((provider) => provider.id === modelCfg.providerId);
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

        state.isRunning = true;
        state.abortReason = null;
        state.abortController = new AbortController();
        if (state.workflowTimeoutId) {
            clearTimeout(state.workflowTimeoutId);
            state.workflowTimeoutId = null;
        }
        if (state.requestTimeoutEnabled) {
            const timeoutMs = Math.max(1, parseInt(state.requestTimeoutSeconds, 10) || 60) * 1000;
            state.workflowTimeoutId = setTimeout(() => {
                if (!state.isRunning || !state.abortController) return;
                state.abortReason = 'timeout';
                state.isRunning = false;
                state.abortController.abort();
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

        const runBtn = documentRef.getElementById('btn-run');
        const stopBtn = documentRef.getElementById('btn-stop');
        runBtn.classList.add('running');
        runBtn.disabled = true;
        if (stopBtn) {
            stopBtn.classList.add('running');
            stopBtn.disabled = false;
        }

        resetNodesForPlan(plan);

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
            state.isRunning = false;
            runBtn.classList.remove('running');
            runBtn.disabled = false;
            if (stopBtn) {
                stopBtn.classList.remove('running');
                stopBtn.disabled = true;
            }
            state.abortController = null;
            state.workflowTimeoutId = null;
            state.abortReason = null;
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
                            addLog('info', '自动注入节点', `为「${nodeConfigs[node.type].title}」自动添加了图片保存节点`);
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

        try {
            while (true) {
                while (true) {
                    if (!state.isRunning) break;

                    const readyNodes = order.filter((nid) => {
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
                            if (runningNodes.has(nid) || completedNodes.has(nid)) return;
                            runningNodes.add(nid);
                            const node = state.nodes.get(nid);
                            const nodeTitle = nodeConfigs[node.type].title;

                            (async () => {
                                node.el.classList.add('running');
                                node.el.classList.remove('completed', 'error');
                                const timeBadge = documentRef.getElementById(`${nid}-time`);
                                const timeContainer = documentRef.getElementById(`${nid}-time-container`);
                                const startTime = Date.now();
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

                                    await executeNode(node, inputs, state.abortController?.signal);

                                    if (timerId) clearInterval(timerId);
                                    const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
                                    node.isSucceeded = true;
                                    node.lastDuration = durationSec;
                                    node.el.classList.remove('running');
                                    node.el.classList.add('completed');
                                    if (timeBadge) {
                                        timeBadge.textContent = `${durationSec}s`;
                                        timeBadge.style.color = '';
                                    }
                                    addLog('success', `节点已完成: ${nodeTitle}`, `耗时 ${durationSec}s`, { nodeId: nid, inputs, data: node.data });
                                    scheduleSave();
                                    completedNodes.add(nid);
                                } catch (err) {
                                    if (isAbortLikeError(err)) {
                                        node.el.classList.remove('running');
                                        clearAbortedNodeFeedback(nid);
                                        addLog('warning', `节点已中止: ${nodeTitle}`, getAbortMessage(state));
                                        return;
                                    }
                                    node.el.classList.remove('running');
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
                                        state.isRunning = false;
                                    }
                                } finally {
                                    if (timerId) clearInterval(timerId);
                                    runningNodes.delete(nid);
                                }
                            })();
                        });
                    }

                    await new Promise((resolve) => setTimeout(resolve, 100));
                    if (!state.isRunning) break;
                }

                if (!state.isRunning) break;

                const actualFailures = order.filter((id) => {
                    const node = state.nodes.get(id);
                    return node && node.enabled !== false && !node.isSucceeded;
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
                if (!state.isRunning) break;
            }
        } finally {
            if (state.workflowTimeoutId) {
                clearTimeout(state.workflowTimeoutId);
                state.workflowTimeoutId = null;
            }
            if (!state.isRunning) {
                addLog('info', '工作流停止', getAbortMessage(state));
                for (const nid of runningNodes) {
                    const node = state.nodes.get(nid);
                    if (node) node.el.classList.remove('running');
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

            const wasRunning = state.isRunning;
            const abortReason = state.abortReason;
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
                } else if (state.isRunning || wasRunning) {
                    showToast(`工作流运行完成，总耗时 ${totalDuration}s`, 'success', 6000);
                    if (notificationRef && notificationRef.permission === 'granted') {
                        new notificationRef('CainFlow 运行完毕', {
                            body: `所有节点执行成功，总耗时 ${totalDuration}s`,
                            icon: 'data:image/svg+xml;base64,...'
                        });
                    }
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
        runWorkflow
    };
}
