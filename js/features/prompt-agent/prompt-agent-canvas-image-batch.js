function imageOutput(node) {
    return node.outputs.find(port => port.type === 'image');
}

export function selectedCanvasImageBatchSources(context) {
    const nodesById = new Map(context.nodes.map(node => [node.id, node]));
    const selected = (context.summary?.selectedIds || []).map(id => nodesById.get(id)).filter(Boolean);
    const imports = selected.filter(node => node.type === 'ImageImport');
    return (imports.length ? imports : selected.filter(imageOutput)).map(node => node.id);
}

export function buildCanvasImageBatch(context, { sourceNodeIds = selectedCanvasImageBatchSources(context), prompt, parameters = {} }) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 25000) throw new Error('请提供有效的批处理提示词。');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('批处理生图参数必须是对象。');
    if (Object.hasOwn(parameters, 'prompt') || Object.hasOwn(parameters.protocolParams || {}, 'prompt')) {
        throw new Error('请在批处理提示词中设置所有分支共用的提示词。');
    }
    if (!Array.isArray(sourceNodeIds) || !sourceNodeIds.length) throw new Error('请选中或指定要逐张处理的图片来源。');
    if (sourceNodeIds.length > 49 || new Set(sourceNodeIds).size !== sourceNodeIds.length) {
        throw new Error('批处理需要 1 至 49 个不同的图片来源。');
    }
    const nodesById = new Map(context.nodes.map(node => [node.id, node]));
    const sources = sourceNodeIds.map(id => {
        const node = nodesById.get(id);
        const port = node && imageOutput(node);
        if (!port) throw new Error('批处理图片来源不存在或没有图片输出。');
        if (!node.enabled || node.running || node.missing || !node.assets.length) {
            throw new Error(`「${node.name}」没有可用原图，请检查素材、禁用或运行状态。`);
        }
        return { node, port: port.name };
    });
    const stepCount = 1 + sources.reduce((count, { node }) => count + (node.assets.length === 1 ? 2 : node.assets.length * 3), 0);
    if (stepCount > 100) throw new Error('批处理超过 100 个画布操作，请分批选择图片。');
    const usedIds = new Set(nodesById.keys());
    const steps = [], connections = [];
    const add = (base, step) => {
        let id = base;
        for (let index = 2; usedIds.has(id); index++) id = `${base}-${index}`;
        usedIds.add(id);
        steps.push({ id, ...step });
        return id;
    };
    const connect = (sourceId, sourcePort, targetId, targetPort) => connections.push({
        from: { ref: sourceId, port: sourcePort }, to: { ref: targetId, port: targetPort }
    });
    const text = add('batch-prompt', { type: 'Text', title: '批处理提示词', parameters: { text: prompt }, execute: false });
    let branch = 0;
    for (const { node, port } of sources) {
        for (const [index, assetKey] of node.assets.entries()) {
            branch++;
            const label = node.assets.length > 1 ? `${node.name} · ${index + 1}` : node.name;
            const image = node.assets.length === 1 ? node.id : add(`batch-source-${branch}`, {
                type: 'ImageImport', title: label, assetKey, assetSourceNodeId: node.id, execute: false
            });
            const generator = add(`batch-generate-${branch}`, {
                type: 'ImageGenerate', title: `生图 · ${label}`, parameters: { ...parameters, prompt }
            });
            const preview = add(`batch-preview-${branch}`, { type: 'ImagePreview', title: `预览 · ${label}` });
            connect(text, 'text', generator, 'prompt');
            connect(image, image === node.id ? port : 'image', generator, 'referenceImages');
            connect(generator, 'image', preview, 'image');
        }
    }
    return { version: 1, steps, connections };
}
