import { getCanonicalImageList, getImageImportMediaAssetReferences } from '../execution/execution-data-utils.js';
import { getNodeDefinition } from '../../nodes/registry.js';
import { resolveUniversalInput } from '../../nodes/universal-input-policy.js';

const roles = [
    ['prompt', '主提示词', 'text'],
    ['camera_prompt', '视角提示词', 'text'],
    ['referenceImages', '参考图', 'image'],
    ['mask', '遮罩', 'image'],
    ['params', '自定义参数', 'params']
];
const typeLabels = { image: '图片', text: '文本', params: '参数', video: '视频', any: '任意类型' };

function describeSource(state, edge) {
    const source = state.nodes.get(edge.from.nodeId);
    const output = Array.from(source?.el?.querySelectorAll('.node-port[data-direction="output"]') || [])
        .find(port => port.dataset.port === edge.from.port);
    const type = output?.dataset.type || edge.type || '';
    const images = type === 'image' ? getCanonicalImageList(source) : [];
    const durableCount = Math.max(getImageImportMediaAssetReferences(source).length,
        source?.data?.mediaAssetKeys?.length || 0, Number(source?.data?.imageCount) || 0);
    const count = type === 'image' ? Math.max(images.length, durableCount) : 0;
    const integrity = source?.data?.mediaIntegrity;
    const missing = !source || integrity?.state === 'missing' || integrity?.missingItems?.length > 0;
    const title = source?.customTitle || source?.el?.dataset.nodeTitle || getNodeDefinition(source?.type)?.title || edge.from.nodeId;
    const status = !source ? '来源缺失' : source.enabled === false ? '已停用'
        : missing ? '原图缺失' : type === 'image' && !count ? '尚无输出' : '已连接';
    return { source, type, count, title, status, missing };
}

/** Presentation of the authoritative edges; edits are delegated to the graph API. */
export function createImageInputDetail({ state, node, documentRef, updateInputConnection, onChange = () => {} }) {
    const element = documentRef.createElement('section');
    element.className = 'image-input-detail';
    element.setAttribute('aria-label', '输入明细');
    let signature = '', replacing = null, pending = false;

    function outputs() {
        return Array.from(state.nodes.values()).filter(source => source !== node).flatMap(source => (
            Array.from(source.el?.querySelectorAll('.node-port[data-direction="output"]') || []).map(port => ({
                nodeId: source.id, port: port.dataset.port, type: port.dataset.type,
                title: `${source.customTitle || source.el.dataset.nodeTitle || getNodeDefinition(source.type)?.title || source.id} · ${port.querySelector('.port-label')?.textContent || port.dataset.port}（${typeLabels[port.dataset.type] || port.dataset.type}）`
            }))
        ));
    }
    function button(label, action, edgeId) {
        const control = documentRef.createElement('button');
        control.type = 'button'; control.textContent = label;
        control.dataset.inputAction = action; control.dataset.inputEdgeId = edgeId;
        return control;
    }
    async function edit(edgeId, changes) {
        if (!updateInputConnection || pending) return;
        pending = true;
        try {
            const result = await updateInputConnection(edgeId, changes);
            if (result?.changed) { replacing = null; onChange(node.id); }
        } finally { pending = false; refresh(true); }
    }
    function refresh(force = false) {
        const edges = state.connections.filter(edge => edge.to.nodeId === node.id);
        const descriptions = edges.map(edge => describeSource(state, edge));
        const candidates = replacing ? outputs() : [];
        const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus);
        const editing = state.historyTransitionInProgress || state.canvasPlanApplying;
        const nextSignature = JSON.stringify([edges.map(({ id, from, to, type, order, maskConsumption }) => (
            [id, from, to, type, order, maskConsumption]
        )), descriptions.map(({ type, count, title, status, source }) => (
            [type, count, title, status, state.runningNodeIds?.has(source?.id)]
        )), candidates, running, editing, !!updateInputConnection]);
        if (!force && signature === nextSignature) return;
        signature = nextSignature;
        element.replaceChildren();
        if (!edges.length) {
            const empty = documentRef.createElement('p'); empty.className = 'image-input-empty';
            empty.textContent = '将图片、文本、视角或参数接到输入口，自动识别用途。';
            element.append(empty); return;
        }
        edges.forEach((edge, index) => {
            const description = descriptions[index];
            const row = documentRef.createElement('article'); row.className = 'image-input-row';
            row.dataset.inputConnectionId = edge.id;
            const top = documentRef.createElement('div'); top.className = 'image-input-source';
            const title = documentRef.createElement('span'); title.className = 'image-input-source-title';
            title.textContent = description.title; title.title = `${description.title} · ${edge.from.nodeId} / ${edge.from.port}`;
            const facts = documentRef.createElement('span'); facts.className = 'image-input-facts';
            facts.textContent = `${typeLabels[description.type] || description.type || '未知类型'}${description.type === 'image' ? ` · ${description.count} 张` : ''} · ${description.status}`;
            top.append(title, facts); row.append(top);
            const controls = documentRef.createElement('div'); controls.className = 'image-input-controls';
            const select = documentRef.createElement('select'); select.dataset.inputRole = '';
            select.setAttribute('aria-label', `${description.title}的输入用途`);
            const availableRoles = roles.filter(([role, , type]) => type === description.type || role === edge.to.port);
            if (!availableRoles.some(([role]) => role === edge.to.port)) availableRoles.push([edge.to.port, edge.to.port]);
            for (const [role, label] of availableRoles) {
                const option = documentRef.createElement('option'); option.value = role; option.textContent = label;
                if (role !== edge.to.port) {
                    const result = resolveUniversalInput({ state, sourceNode: description.source,
                        sourcePort: edge.from.port, sourceType: description.type, targetNode: node,
                        role, ignoreConnectionId: edge.id });
                    option.disabled = !!result.error;
                    if (result.error) option.title = result.error;
                }
                select.append(option);
            }
            select.value = edge.to.port;
            const disabled = running || editing || state.runningNodeIds?.has(description.source?.id) || !updateInputConnection || pending;
            select.disabled = disabled;
            select.addEventListener('change', event => { event.stopPropagation(); void edit(edge.id, { role: select.value }); });
            const replace = button('替换', 'replace', edge.id), disconnect = button('断开', 'disconnect', edge.id);
            replace.disabled = disconnect.disabled = disabled;
            replace.addEventListener('click', () => { replacing = replacing === edge.id ? null : edge.id; refresh(true); });
            disconnect.addEventListener('click', () => { void edit(edge.id, { disconnect: true }); });
            controls.append(select, replace, disconnect); row.append(controls);
            if (edge.to.port === 'mask' && edge.maskConsumption !== 'single') {
                const compatibility = documentRef.createElement('span'); compatibility.className = 'image-input-compatibility';
                compatibility.textContent = '使用来源第 1 张 · 旧连接兼容'; row.append(compatibility);
            }
            if (replacing === edge.id) {
                const replacement = documentRef.createElement('div'); replacement.className = 'image-input-replacement';
                const sources = documentRef.createElement('select'); sources.dataset.inputReplacementSource = '';
                sources.setAttribute('aria-label', `替换${description.title}的来源输出`);
                const placeholder = documentRef.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择来源输出'; sources.append(placeholder);
                for (const candidate of candidates.filter(candidate => candidate.type === description.type)) {
                    const option = documentRef.createElement('option'); option.value = JSON.stringify({ nodeId: candidate.nodeId, port: candidate.port }); option.textContent = candidate.title;
                    const result = resolveUniversalInput({ state, sourceNode: state.nodes.get(candidate.nodeId),
                        sourcePort: candidate.port, sourceType: candidate.type, targetNode: node,
                        role: edge.to.port, ignoreConnectionId: edge.id });
                    option.disabled = !!result.error;
                    if (result.error) option.title = result.error;
                    sources.append(option);
                }
                const confirm = button('确认替换', 'confirm-replace', edge.id), cancel = button('取消', 'cancel-replace', edge.id);
                confirm.disabled = true;
                sources.addEventListener('change', event => { event.stopPropagation(); confirm.disabled = !sources.value || pending; });
                confirm.addEventListener('click', () => { if (sources.value) void edit(edge.id, { from: JSON.parse(sources.value) }); });
                cancel.addEventListener('click', () => { replacing = null; refresh(true); });
                replacement.append(sources, confirm, cancel); row.append(replacement);
            }
            element.append(row);
        });
    }
    element.addEventListener('input', event => event.stopPropagation());
    return { element, refresh };
}
