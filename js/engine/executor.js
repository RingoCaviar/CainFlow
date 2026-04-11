import { state } from '../modules/state.js';
import { NODE_CONFIGS } from '../modules/constants.js';
import { showToast, generateId } from '../modules/utils.js';
import { NodeHandlers } from './handlers.js';

import { 
    addLog, 
    updateAllConnections, 
    updatePortStyles, 
    scheduleSave, 
    pushHistory,
    addNode
} from '../modules/ui_bridge.js';

/**
 * Topologically sorts nodes starting from an optional target node.
 * Ensures dependencies are executed in the correct order.
 */
export function topologicalSort(targetNodeId = null) {
    const visited = new Set();
    const order = [];
    const visiting = new Set();
    const nodesInFlow = new Set();

    // If targetNodeId is provided, we only want nodes that lead to it
    if (targetNodeId) {
        const stack = [targetNodeId];
        while (stack.length > 0) {
            const nid = stack.pop();
            if (nodesInFlow.has(nid)) continue;
            nodesInFlow.add(nid);
            state.connections
                .filter(c => c.to.nodeId === nid)
                .forEach(c => stack.push(c.from.nodeId));
        }
    } else {
        state.nodes.forEach((_, id) => nodesInFlow.add(id));
    }

    function visit(nid) {
        if (visiting.has(nid)) {
            showToast('检测到工作流中存在循环引用，执行中止', 'error');
            return false;
        }
        if (visited.has(nid)) return true;
        
        visiting.add(nid);
        const deps = state.connections.filter(c => c.to.nodeId === nid).map(c => c.from.nodeId);
        for (const dnid of deps) {
            if (nodesInFlow.has(dnid)) {
                if (!visit(dnid)) return false;
            }
        }
        
        visiting.delete(nid);
        visited.add(nid);
        order.push(nid);
        return true;
    }

    for (const nid of nodesInFlow) {
        if (!visited.has(nid)) {
            if (!visit(nid)) return null;
        }
    }
    return order;
}

/**
 * Dispatches node execution to the appropriate handler.
 */
export async function executeNode(node, inputs, signal) {
    const handler = NodeHandlers[node.type];
    if (handler) {
        await handler(node, inputs, signal);
    } else {
        console.warn(`No handler defined for node type: ${node.type}`);
    }
}

/**
 * Main workflow execution entry point.
 */
export async function runWorkflow(targetNodeId = null) {
    if (state.nodes.size === 0) {
        showToast('当前画布没有任何节点，请先添加节点或加载工作流', 'warning');
        return;
    }
    if (state.isRunning) return;

    // Pre-flight check: Warn if models are used without API keys configured
    const missingKeysProviders = new Set();
    for (const [id, node] of state.nodes) {
        if (node.type === 'ImageGenerate' || node.type === 'TextChat') {
            const configSelect = document.getElementById(`${id}-apiconfig`);
            if (configSelect) {
                const modelCfg = state.models.find(m => m.id === configSelect.value);
                if (modelCfg) {
                    const apiCfg = state.providers.find(p => p.id === modelCfg.providerId);
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
        if (!confirm(msg)) {
            return;
        }
    }

    state.isRunning = true;
    state.abortController = new AbortController();

    // Warm up audio context for background notifications
    if (state.notificationsEnabled) {
        if (!state.notificationAudio) {
            state.notificationAudio = new Audio();
            state.notificationAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
            state.notificationAudio.loop = true;
        }
        state.notificationAudio.muted = true;
        state.notificationAudio.play().catch(e => console.warn('Audio warm-up blocked:', e));
    }

    const runBtn = document.getElementById('btn-run');
    const stopBtn = document.getElementById('btn-stop');
    runBtn.classList.add('running'); runBtn.disabled = true;
    if (stopBtn) { stopBtn.classList.add('running'); stopBtn.disabled = false; }

    // Reset nodes (unless fixed and succeeded)
    for (const [nid, n] of state.nodes) {
        const fixedToggle = document.getElementById(`${nid}-fixed`);
        const isFixed = fixedToggle ? fixedToggle.checked : false;
        
        if (isFixed && n.isSucceeded && n.data && Object.keys(n.data).length > 0) {
            n.el.classList.add('completed');
            n.el.classList.remove('error', 'running');
            continue;
        }

        n.el.classList.remove('completed', 'error', 'running');
        n.data = {};
        n.isSucceeded = false;
    }

    const order = topologicalSort(targetNodeId);
    if (!order) {
        finalizeWorkflow();
        return;
    }

    // Pre-flight check: ImageImport nodes in the path MUST have images
    const emptyImageNodes = [];
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.enabled !== false && node.type === 'ImageImport' && !node.imageData) {
            emptyImageNodes.push(nid);
        }
    }
    
    if (emptyImageNodes.length > 0) {
        showToast(`执行中止：当前路径中有 ${emptyImageNodes.length} 个图片导入节点未加载图片`, 'error', 5000);
        emptyImageNodes.forEach(nid => {
            const node = state.nodes.get(nid);
            if (node) {
                node.el.classList.add('error');
                addLog('error', '前置检查未通过', `节点「图片导入」(${nid}) 未载入素材图片`);
            }
        });
        finalizeWorkflow();
        return;
    }

    // Pre-flight check: TextChat nodes in path must have a prompt
    const emptyPromptNodes = [];
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.enabled !== false && node.type === 'TextChat') {
            const fixedToggle = document.getElementById(`${nid}-fixed`);
            if (fixedToggle && fixedToggle.checked && node.isSucceeded) continue;

            const hasPortInput = state.connections.some(c => c.to.nodeId === nid && c.to.port === 'prompt');
            const textareaValue = document.getElementById(`${nid}-prompt`)?.value || '';
            if (!hasPortInput && !textareaValue.trim()) {
                emptyPromptNodes.push(nid);
            }
        }
    }

    if (emptyPromptNodes.length > 0) {
        showToast(`执行中止：当前路径中有 ${emptyPromptNodes.length} 个智能对话节点内容为空`, 'error', 5000);
        emptyPromptNodes.forEach(nid => {
            const node = state.nodes.get(nid);
            if (node) {
                node.el.classList.add('error');
                addLog('error', '前置检查未通过', `节点「智能对话」(${nid}) 提示词内容缺失（连线或文本框均无内容）`);
            }
        });
        finalizeWorkflow();
        return;
    }

    // Pre-verify Global Save Directory permission
    if (state.globalSaveDirHandle) {
        const hasSaveNode = order.some(nid => state.nodes.get(nid)?.type === 'ImageSave');
        if (hasSaveNode) {
            try {
                const status = await state.globalSaveDirHandle.queryPermission({ mode: 'readwrite' });
                if (status !== 'granted') {
                    addLog('info', '目录授权申请', '尝试获取保存目录的写入权限...');
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
        runBtn.classList.remove('running'); runBtn.disabled = false;
        if (stopBtn) { stopBtn.classList.remove('running'); stopBtn.disabled = true; }
        state.abortController = null;
    }

    // Auto-inject ImageSave nodes
    let injected = false;
    for (const nid of order) {
        const node = state.nodes.get(nid);
        if (node && node.type === 'ImageGenerate') {
            const hasConnection = state.connections.some(c => c.from.nodeId === nid && c.from.port === 'image');
            if (!hasConnection) {
                const rect = node.el.getBoundingClientRect();
                const nodeWidth = rect.width || 240;
                const saveId = addNode('ImageSave', node.x + nodeWidth + 80, node.y);
                if (saveId) {
                    state.connections.push({ id: 'conn_' + generateId(), from: { nodeId: nid, port: 'image', type: 'image' }, to: { nodeId: saveId, port: 'image', type: 'image' }, type: 'image' });
                    injected = true;
                    addLog('info', '自动注入节点', `为「${NODE_CONFIGS[node.type].title}」自动添加了图片保存节点`);
                }
            }
        }
    }
    if (injected) {
        updateAllConnections(); updatePortStyles();
        const newOrder = topologicalSort(targetNodeId);
        if (newOrder) order.splice(0, order.length, ...newOrder);
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
            // Parallel execution loop for this round
            while (true) {
                if (!state.isRunning) break;

                const readyNodes = order.filter(nid => {
                    if (completedNodes.has(nid) || runningNodes.has(nid) || failedNodes.has(nid)) return false;
                    const node = state.nodes.get(nid);
                    if (!node || node.enabled === false) { completedNodes.add(nid); return false; }

                    const deps = state.connections.filter(c => c.to.nodeId === nid).map(c => c.from.nodeId);
                    return deps.every(dnid => completedNodes.has(dnid));
                });

                if (readyNodes.length === 0 && runningNodes.size === 0) break;

                if (readyNodes.length > 0) {
                    readyNodes.forEach(nid => {
                        if (runningNodes.has(nid) || completedNodes.has(nid)) return;
                        runningNodes.add(nid);
                        const node = state.nodes.get(nid);
                        const nodeTitle = NODE_CONFIGS[node.type].title;

                        (async () => {
                            node.el.classList.add('running');
                            node.el.classList.remove('completed', 'error');
                            const timeBadge = document.getElementById(`${nid}-time`);
                            const timeContainer = document.getElementById(`${nid}-time-container`);
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
                                const inputs = {};
                                for (const c of state.connections.filter(c => c.to.nodeId === nid)) {
                                    const fn = state.nodes.get(c.from.nodeId);
                                    if (fn && fn.data[c.from.port] !== undefined) inputs[c.to.port] = fn.data[c.from.port];
                                }

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
                                if (err.name === 'AbortError') {
                                    node.el.classList.remove('running');
                                    addLog('warning', `节点已中止: ${nodeTitle}`, '用户终止了工作流');
                                    return;
                                }
                                node.el.classList.remove('running');
                                node.el.classList.add('error');
                                const errorMsg = err.message || '未知错误';
                                if (timeBadge) timeBadge.textContent = 'Err';
                                const errorDetails = err.serverResponse || { nodeId: nid, error: err.stack || err };
                                addLog('error', `节点失败: ${nodeTitle}`, errorMsg, errorDetails);

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

                await new Promise(r => setTimeout(r, 100));
                if (!state.isRunning) break;
            }

            if (!state.isRunning) break;

            const actualFailures = order.filter(id => {
                const n = state.nodes.get(id);
                return n && n.enabled !== false && !n.isSucceeded;
            });

            if (actualFailures.length === 0) {
                if (retryAttempt > 0) addLog('success', '工作流并行重试完成', `经过 ${retryAttempt} 次重试后，所有节点已成功执行。`);
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

            addLog('warning', `自动重试开始 (第 ${retryAttempt} 轮)`, `${actualFailures.length} 个节点未成功，正在准备重新执行相关分支...`);
            showToast(`正在启动第 ${retryAttempt} 轮自动重试 (${actualFailures.length} 个节点)...`, 'warning', 4000);
            failedNodes.clear();
            await new Promise(r => setTimeout(r, 1500));
            if (!state.isRunning) break;
        }
    } finally {
        if (!state.isRunning && !terminatedByError) {
            addLog('info', '工作流停止', '用户手动终止了运行流程');
            for (const nid of runningNodes) {
                const node = state.nodes.get(nid);
                if (node) node.el.classList.remove('running');
            }
        }

        for (const [id, n] of state.nodes) {
            if (n.type === 'ImageSave' && n.data.image) {
                const btnSave = n.el.querySelector(`#${id}-manual-save`);
                const btnView = n.el.querySelector(`#${id}-view-full`);
                if (btnSave) btnSave.disabled = false;
                if (btnView) btnView.disabled = false;
            }
        }

        const wasRunning = state.isRunning;
        finalizeWorkflow();

        if (state.notificationsEnabled) {
            const totalDuration = ((Date.now() - totalWorkflowStartTime) / 1000).toFixed(2);
            if (terminatedByError) {
                showToast(`工作流运行停止 ✗ 耗时 ${totalDuration}s`, 'error', 6000);
                // Notification and sound logic removed for brevity or kept if reachable
            } else if (wasRunning) {
                showToast(`工作流运行完成 ✓ 总耗时 ${totalDuration}s`, 'success', 6000);
            }
        }
    }
}
