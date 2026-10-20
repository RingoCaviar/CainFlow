const DAMAGE_FIELDS = ['damageClass', 'identity', 'stage'];

function redactIdentity(value) {
    const text = String(value || '');
    if (!text) return '未知';
    return text.length <= 18 ? text : `${text.slice(0, 12)}…${text.slice(-6)}`;
}

function sourceDomain(node, item) {
    if (item?.sourceDomain) return String(item.sourceDomain);
    const candidate = node?.data?.imageTaskUrl || node?.data?.videoUrl || node?.data?.video?.url || '';
    try { return new URL(candidate).hostname || '本地'; } catch { return '本地'; }
}

function hasRecoverableSource(node, item) {
    if (typeof item?.recoverable === 'boolean') return item.recoverable;
    const data = node?.data || {};
    const url = data.imageTaskUrl || data.videoUrl || data.video?.url || '';
    return /^https?:\/\//i.test(String(url)) || Boolean(data.imageTaskId || data.videoTaskId || data.video?.taskId);
}

export function buildIntegrityDrawerModel({ safety = null, scan = null, report = null, nodes = [], workflowId = '', workflowName = '' } = {}) {
    const items = nodes.flatMap((node) => (node?.data?.mediaIntegrity?.missingItems || []).map((item) => ({
        workflowId: String(workflowId), workflowName: String(workflowName || workflowId || '当前工作流'),
        nodeId: String(node.id || ''), nodeName: String(node.data?.label || node.title || node.type || node.id || '节点'),
        mediaType: node.data?.mediaIntegrity?.mediaType === 'video' ? 'video' : 'image',
        position: Number(item.position || 0), positionLabel: `第 ${Number(item.position || 0) + 1} 项`,
        identity: redactIdentity(item.redactedSource || item.identity || item.assetKey),
        sourceDomain: sourceDomain(node, item), recoverable: hasRecoverableSource(node, item)
    })));
    const checkpoint = scan?.checkpoint || {};
    const state = String(safety?.state || 'unknown');
    return {
        state, paused: state !== 'healthy', reason: String(safety?.reason || '等待完整性检查'),
        editingBlocked: false, saveImpact: '编辑和保存不受影响；物理回收由后端安全闩锁控制。',
        phase: scan?.complete ? 'complete' : String(checkpoint.phase || (report ? 'complete' : 'idle')),
        progress: Number(checkpoint.sourceIndex || 0), cutoffRevision: Number(checkpoint.cutoffRevision ?? report?.cutoffRevision ?? 0),
        pendingCount: items.length, recoverableCount: items.filter((item) => item.recoverable).length,
        items, reportId: String(report?.reportId || '')
    };
}

export function createDiagnosticExport({ safety = {}, report = {} } = {}) {
    return {
        exportedAt: new Date().toISOString(),
        safety: { state: String(safety.state || ''), reason: String(safety.reason || ''), detectedAt: Number(safety.detectedAt || 0) },
        report: { reportId: String(report.reportId || ''), reportVersion: Number(report.reportVersion || 0), cutoffRevision: Number(report.cutoffRevision || 0) },
        damageItems: (report.damageItems || []).map((item) => Object.fromEntries(
            DAMAGE_FIELDS.map((key) => [key, String(item?.[key] || '')])
        ))
    };
}

export function createMediaIntegrityDrawerController({
    fetchRef = fetch, getWorkflows = () => [], getNodes = () => [], getWorkflowId = () => '',
    getWorkflowName = () => '', onMissingAction = async () => {}, onChange = () => {},
    isActive = () => true, shouldPoll = () => true,
    setIntervalRef = setInterval, clearIntervalRef = clearInterval
} = {}) {
    let monitorId = null;
    let loadPromise = null;
    let stepPromise = null;
    let refreshPromise = null;
    let refreshIncludesRecheck = false;
    let state = { safety: null, report: null, scan: null, paused: false, loading: false, error: '', model: buildIntegrityDrawerModel() };
    const update = (patch = {}) => {
        state = { ...state, ...patch };
        state.model = buildIntegrityDrawerModel({ ...state, nodes: getNodes(), workflowId: getWorkflowId(), workflowName: getWorkflowName() });
        onChange(state);
        return state;
    };
    async function requestJson(url, options, allowNotFound = false) {
        const response = await fetchRef(url, options);
        if (allowNotFound && response.status === 404) return { report: null };
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status || 500}`);
        return response.json();
    }
    async function load({ poll = false } = {}) {
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
        update({ loading: true, error: '' });
        try {
            let safetyValue; let reportValue;
            if (poll) {
                safetyValue = await requestJson('/api/storage/safety-status');
                const publishedId = String(safetyValue.safety?.reportId || '');
                const reportUnchanged = publishedId
                    ? publishedId === state.report?.reportId
                    : !state.report;
                reportValue = reportUnchanged
                    ? { report: state.report }
                    : await requestJson('/api/storage/integrity-report', undefined, true);
            } else {
                [safetyValue, reportValue] = await Promise.all([
                    requestJson('/api/storage/safety-status'), requestJson('/api/storage/integrity-report', undefined, true)
                ]);
            }
            return update({ safety: safetyValue.safety || null, report: reportValue.report || null, loading: false });
        } catch (error) { return update({ loading: false, error: error.message }); }
        })();
        try { return await loadPromise; } finally { loadPromise = null; }
    }
    async function step() {
        if (state.paused) return state;
        if (stepPromise) return stepPromise;
        stepPromise = (async () => {
        update({ loading: true, error: '' });
        try {
            const scan = await requestJson('/api/storage/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'scan-media-integrity', workflows: getWorkflows(), batchSize: 100 }) });
            update({ scan, report: scan.report || state.report, loading: false });
            if (scan.complete) await load();
        } catch (error) { update({ loading: false, error: error.message }); }
        return state;
        })();
        try { return await stepPromise; } finally { stepPromise = null; }
    }
    const needsScan = () => !state.safety?.backgroundScanPending && state.safety?.state !== 'healthy' && (
        state.safety?.state === 'scan_required' || state.safety?.state === 'scanning' || state.scan?.complete === false
        || (state.safety?.state === 'gc_suspended'
            && ['unclean_shutdown', 'fast_check_timeout'].includes(state.safety?.reason))
        || (state.scan?.complete !== true && !state.report)
    );
    async function refresh({ recheck = false, preloaded = false } = {}) {
        if (refreshPromise) {
            if (!recheck || refreshIncludesRecheck) return refreshPromise;
            await refreshPromise;
            return refresh({ recheck: true });
        }
        refreshIncludesRecheck = recheck;
        const request = (async () => {
            update({ paused: false, error: '' });
            if (!preloaded) await load();
            if (state.error || state.safety?.backgroundScanPending || (!recheck && !needsScan())) return state;
            do {
                await step();
            } while (!state.error && state.scan?.complete === false && isActive() && shouldPoll());
            return state;
        })();
        refreshPromise = request;
        try { return await request; }
        finally {
            if (refreshPromise === request) {
                refreshPromise = null;
                refreshIncludesRecheck = false;
            }
        }
    }
    async function runMissingAction(action, item, node) {
        try {
            const result = await onMissingAction({ action, item, node });
            if (result?.status === 'error') throw new Error(result.error);
            update({ error: '' });
        }
        catch (error) { update({ error: error.message || '媒体操作失败' }); }
        return state;
    }
    const stopMonitoring = () => { if (monitorId !== null) clearIntervalRef(monitorId); monitorId = null; };
    return {
        load, step, refresh, retry: () => { update({ scan: null, error: '', paused: false }); return step(); },
        pause: () => update({ paused: true }), resume: () => update({ paused: false }),
        startMonitoring: (intervalMs = 5000) => {
            if (monitorId === null) monitorId = setIntervalRef(() => {
                if (!isActive()) { stopMonitoring(); return; }
                if (!shouldPoll()) return;
                if (refreshPromise) return refreshPromise;
                return load({ poll: true }).then((current) => current.error || !needsScan() ? current : refresh({ preloaded: true }));
            }, intervalMs);
            return refresh();
        },
        stopMonitoring,
        runMissingAction, getState: () => state,
        exportDiagnostics: () => createDiagnosticExport(state)
    };
}

export function renderMediaIntegrityDrawer(root, state, {
    onAction, onBatchRecover
} = {}) {
    if (!root) return;
    root.replaceChildren();
    const add = (tag, className, text, parent = root) => {
        const element = root.ownerDocument.createElement(tag);
        element.className = className;
        if (text !== undefined) element.textContent = text;
        parent.appendChild(element);
        return element;
    };
    const model = state.model;
    const button = (label, handler, parent) => { const value = add('button', 'btn btn-secondary btn-xs', label, parent); value.type = 'button'; value.addEventListener('click', handler); return value; };
    const summary = add('section', 'integrity-summary', '');
    add('strong', '', `待处理 ${model.pendingCount} 项 · 可恢复 ${model.recoverableCount} 项`, summary);
    if (model.recoverableCount) button('确认批量恢复', onBatchRecover, summary).classList.add('integrity-batch-recover');
    if (model.paused && model.state !== 'unknown') add('p', 'integrity-notice', '媒体回收已暂停，清理可能保留文件');
    if (state.error) add('p', 'integrity-error', `操作失败：${state.error}`);
    const list = add('div', 'integrity-missing-list', '');
    model.items.forEach((item) => {
        const card = add('article', 'integrity-missing-item', '', list);
        add('strong', '', `${item.workflowName} / ${item.nodeName}`, card);
        add('p', '', `${item.mediaType} · ${item.positionLabel} · ${item.identity} · ${item.sourceDomain}`, card);
        const actions = add('div', 'integrity-item-actions', '', card);
        const action = (label, name) => { const value = add('button', 'btn btn-secondary btn-xs', label, actions); value.type = 'button'; value.addEventListener('click', () => onAction?.(name, item)); };
        if (item.recoverable) action('确认恢复', 'remote-recover');
        else action('选择本地文件', 'local-recover');
        action('定位', 'locate');
        action('详情', 'details');
        action('确认移除', 'remove');
    });
}
