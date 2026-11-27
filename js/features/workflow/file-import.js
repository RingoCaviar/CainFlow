export function normalizeFileImport(value) {
    if (typeof value?.name !== 'string' || !value.name || /[\\/]/.test(value.name)) return null;
    return {
        name: value.name.slice(0, 255),
        ...(/^[a-f0-9]{32}$/.test(value.id) ? { id: value.id } : {})
    };
}

export function findTextFileSource(node, state) {
    const visited = new Set();
    while (node?.type === 'Text' && node.enabled !== false && !visited.has(node.id)) {
        visited.add(node.id);
        const edge = state.connections.findLast(connection => connection.to.nodeId === node.id
            && connection.to.port === 'text' && state.nodes.get(connection.from.nodeId)?.enabled !== false);
        if (edge?.from.port !== 'text') return null;
        node = edge && state.nodes.get(edge.from.nodeId);
    }
    return node?.type === 'FileImport' && node.enabled !== false ? node : null;
}

export async function readFileImportText(workflowId, nodeId, fileImport) {
    if (!workflowId || !fileImport?.id) throw new Error('请重新定位原文件。');
    const query = new URLSearchParams({ workflowId, nodeId, referenceId: fileImport.id });
    const response = await fetch(`/api/storage/file-imports/text?${query}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || typeof result.text !== 'string') {
        throw new Error(result.error || '无法读取原文件。');
    }
    return result.text;
}

export function bindFileImportNode({ node, workflowId, windowRef, isCurrent }) {
    const preview = node.el.querySelector('[data-file-import-preview]');
    const status = node.el.querySelector('[data-file-import-status]');
    const open = node.el.querySelector('[data-file-import-open]');
    const report = (state, message) => {
        if (!isCurrent()) return;
        node.fileImportStatus = state;
        status.textContent = message;
    };
    if (!node.fileImport?.id) {
        report('unbound', '请重新定位原文件。');
        open.disabled = true;
        return;
    }
    report('loading', '正在读取原文件…');
    void readFileImportText(workflowId, node.id, node.fileImport).then(text => {
        if (!isCurrent()) return;
        preview.value = text;
        report('ready', '');
    }).catch(error => report('unavailable', error.message));
    open.addEventListener('click', async () => {
        try {
            if (!await windowRef.__cainflowDesktop?.openFileImport?.(workflowId, node.id, node.fileImport.id)) {
                report(node.fileImportStatus, '请在 CainFlow 桌面应用打开原文件。');
            }
        } catch {
            report('unavailable', '系统无法打开原文件。');
        }
    });
}
