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
    setIntervalRef = setInterval, clearIntervalRef = clearInterval
} = {}) {
    let monitorId = null;
    let state = { safety: null, report: null, scan: null, paused: false, loading: false, error: '', model: buildIntegrityDrawerModel() };
    const update = (patch = {}) => {
        state = { ...state, ...patch };
        state.model = buildIntegrityDrawerModel({ ...state, nodes: getNodes(), workflowId: getWorkflowId(), workflowName: getWorkflowName() });
        onChange(state);
        return state;
    };
    async function requestJson(url, options) {
        const response = await fetchRef(url, options);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status || 500}`);
        return response.json();
    }
    async function load() {
        update({ loading: true, error: '' });
        try {
            const [safetyValue, reportValue] = await Promise.all([
                requestJson('/api/storage/safety-status'), requestJson('/api/storage/integrity-report')
            ]);
            return update({ safety: safetyValue.safety || null, report: reportValue.report || null, loading: false });
        } catch (error) { return update({ loading: false, error: error.message }); }
    }
    async function step() {
        if (state.paused) return state;
        update({ loading: true, error: '' });
        try {
            const scan = await requestJson('/api/storage/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'scan-media-integrity', workflows: getWorkflows(), batchSize: 100 }) });
            update({ scan, report: scan.report || state.report, loading: false });
            await load();
        } catch (error) { update({ loading: false, error: error.message }); }
        return state;
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
    return {
        load, step, retry: () => { update({ scan: null, error: '', paused: false }); return step(); },
        pause: () => update({ paused: true }), resume: () => update({ paused: false }),
        startMonitoring: (intervalMs = 3000) => {
            if (monitorId === null) monitorId = setIntervalRef(load, intervalMs);
            return load();
        },
        stopMonitoring: () => { if (monitorId !== null) clearIntervalRef(monitorId); monitorId = null; },
        runMissingAction, getState: () => state,
        exportDiagnostics: () => createDiagnosticExport(state)
    };
}

export function renderMediaIntegrityDrawer(root, state, {
    onPause, onResume, onRetry, onScan, onAction, onBatchRecover, onExport
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
    const status = add('section', `integrity-status-card integrity-status-card--${model.paused ? 'paused' : 'healthy'}`, '');
    add('strong', '', model.paused ? '物理回收已暂停' : '物理回收正常', status);
    add('p', '', `原因：${model.reason}`, status);
    add('p', '', model.saveImpact, status);
    add('p', '', `扫描：${state.loading ? '正在加载' : model.phase} · 进度 ${model.progress} · 截止修订 ${model.cutoffRevision || '—'}`, status);
    if (state.error) add('p', 'integrity-error', `操作失败：${state.error}`, status);
    const controls = add('div', 'integrity-controls', '', status);
    const button = (label, handler, parent = controls) => { const value = add('button', 'btn btn-secondary btn-xs', label, parent); value.type = 'button'; value.addEventListener('click', handler); return value; };
    button(state.paused ? '继续扫描' : '暂停扫描', state.paused ? onResume : onPause);
    button('扫描一步', onScan);
    button('重试', onRetry);
    button('导出脱敏诊断', onExport);
    const summary = add('section', 'integrity-summary', '');
    add('strong', '', `待处理 ${model.pendingCount} 项 · 可恢复 ${model.recoverableCount} 项`, summary);
    if (model.recoverableCount) button('确认批量恢复', onBatchRecover, summary).classList.add('integrity-batch-recover');
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
