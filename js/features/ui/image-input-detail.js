import { getCanonicalImageList } from '../execution/execution-data-utils.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { getNodeDefinition } from '../../nodes/registry.js';
import { getUniversalInputRoles, resolveUniversalInput } from '../../nodes/universal-input-policy.js';

const typeLabels = { image: '图片', text: '文本', params: '参数', video: '视频', any: '任意类型' };

function describeSource(state, edge, referenceGroup) {
    const source = state.nodes.get(edge.from.nodeId);
    const output = Array.from(source?.el?.querySelectorAll('.node-port[data-direction="output"]') || [])
        .find(port => port.dataset.port === edge.from.port);
    const type = output?.dataset.type || edge.type || '';
    const projection = type === 'image' ? referenceGroup || projectImageOutput(source, getCanonicalImageList(source)) : null;
    const videos = Array.isArray(source?.data?.videos) && source.data.videos.length ? source.data.videos
        : source?.data?.video ? [source.data.video] : [];
    const count = type === 'video' ? videos.length : projection?.count || 0;
    const integrity = source?.data?.mediaIntegrity;
    const missing = !source || (type === 'video'
        ? source.data?.videoMissingLocalAsset === true || integrity?.mediaType === 'video' && (integrity?.state === 'missing' || integrity?.missingItems?.length > 0)
        : !projection?.remote && (integrity?.state === 'missing' || integrity?.missingItems?.length > 0));
    const title = source?.customTitle || source?.el?.dataset.nodeTitle || getNodeDefinition(source?.type)?.title || edge.from.nodeId;
    const sourceRunning = referenceGroup?.running || state.runningNodeIds?.has(source?.id) || ['waiting', 'running'].includes(source?.runStatus);
    const status = !source ? '来源缺失' : source.enabled === false ? '已停用'
        : sourceRunning ? '来源运行中' : missing ? (type === 'video' ? '本地视频缺失' : '原图缺失')
            : ['image', 'video'].includes(type) && !count ? '尚无输出' : '已连接';
    return { source, type, count, title, status, missing };
}

/** Presentation of the authoritative edges; edits are delegated to the graph API. */
export function createImageInputDetail({ state, node, documentRef, updateInputConnection, swapInputConnections, moveMergeInputConnection, onChange = () => {} }) {
    const element = documentRef.createElement('section');
    element.className = 'image-input-detail';
    element.setAttribute('aria-label', '输入明细');
    let signature = '', replacing = null, pending = false, statusMessage = '';

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
        control.dataset.inputAction = action;
        if (edgeId !== undefined) control.dataset.inputEdgeId = edgeId;
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
    async function swap() {
        if (!swapInputConnections || pending) return;
        pending = true; statusMessage = ''; refresh(true);
        try {
            const result = await swapInputConnections(node.id);
            statusMessage = result?.error || '';
            if (result?.changed) { replacing = null; onChange(node.id); }
        } catch (error) {
            statusMessage = error?.message || '交换失败，请重试。';
        } finally { pending = false; refresh(true); }
    }
    async function move(edgeId, direction) {
        if (!moveMergeInputConnection || pending) return;
        pending = true; statusMessage = ''; refresh(true);
        try {
            const result = await moveMergeInputConnection(edgeId, direction);
            statusMessage = result?.error || '';
            if (result?.changed) { replacing = null; onChange(node.id); }
        } catch (error) {
            statusMessage = error?.message || '排序失败，请重试。';
        } finally { pending = false; refresh(true); }
    }
    function refresh(force = false) {
        const edges = state.connections.filter(edge => edge.to.nodeId === node.id);
        if (node.type === 'ImageMerge') edges.sort((left, right) => (
            (Number(left.to.port.match(/^image_(\d+)$/)?.[1]) || Infinity)
            - (Number(right.to.port.match(/^image_(\d+)$/)?.[1]) || Infinity)
        ));
        const references = new Map(projectImageReferences({ state, targetId: node.id }).groups.map(group => [group.connection.id, group]));
        const descriptions = edges.map(edge => describeSource(state, edge, references.get(edge.id)));
        const candidates = replacing ? outputs() : [];
        const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus);
        const editing = state.historyTransitionInProgress || state.canvasPlanApplying;
        const nextSignature = JSON.stringify([edges.map(({ id, from, to, type, order, maskConsumption }) => (
            [id, from, to, type, order, maskConsumption]
        )), descriptions.map(({ type, count, title, status, source }) => (
            [type, count, title, status, state.runningNodeIds?.has(source?.id)]
        )), candidates, running, editing, !!updateInputConnection, !!swapInputConnections, !!moveMergeInputConnection, pending, statusMessage]);
        if (!force && signature === nextSignature) return;
        signature = nextSignature;
        element.replaceChildren();
        if (node.type === 'ImageCompare') {
            const actions = documentRef.createElement('div'); actions.className = 'image-input-compare-actions';
            const description = documentRef.createElement('span'); description.className = 'image-input-empty'; description.textContent = 'A 可选 · B 为必需输入';
            const swapButton = button('交换 A/B', 'swap');
            swapButton.disabled = pending || running || editing || !swapInputConnections
                || !edges.some(edge => ['imageA', 'imageB'].includes(edge.to.port))
                || descriptions.some(({ source }) => state.runningNodeIds?.has(source?.id) || ['waiting', 'running'].includes(source?.runStatus));
            swapButton.addEventListener('click', () => { void swap(); });
            actions.append(description, swapButton); element.append(actions);
        }
        if (statusMessage) {
            const status = documentRef.createElement('p'); status.className = 'image-input-feedback';
            status.setAttribute('role', 'status'); status.textContent = statusMessage; element.append(status);
        }
        if (!edges.length) {
            const empty = documentRef.createElement('p'); empty.className = 'image-input-empty';
            empty.textContent = node.type === 'ImageGenerate'
                ? '将图片、文本、视角或参数接到输入口，自动识别用途。'
                : node.type === 'ImageCompare' ? '将图片接到输入口，依次分配空闲 A、B。'
                    : node.type === 'ImageSave' ? '将图片或视频接到输入口，分别保留图片和视频用途。'
                        : node.type === 'CameraControl' ? '将图片接到输入口，用作视角编辑的参考。'
                    : '将图片接到输入口，保留来源的完整批次。';
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
            facts.textContent = `${typeLabels[description.type] || description.type || '未知类型'}${description.type === 'image' ? ` · ${description.count} 张` : description.type === 'video' ? ` · ${description.count} 个` : ''} · ${description.status}`;
            top.append(title, facts); row.append(top);
            const controls = documentRef.createElement('div'); controls.className = 'image-input-controls';
            const select = documentRef.createElement('select'); select.dataset.inputRole = '';
            select.setAttribute('aria-label', `${description.title}的输入用途`);
            const availableRoles = getUniversalInputRoles(node, state).filter(([role, , type]) => type === description.type || role === edge.to.port);
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
            const disabled = running || editing || state.runningNodeIds?.has(description.source?.id)
                || ['waiting', 'running'].includes(description.source?.runStatus) || !updateInputConnection || pending;
            select.disabled = disabled;
            select.addEventListener('change', event => { event.stopPropagation(); void edit(edge.id, { role: select.value }); });
            const replace = button('替换', 'replace', edge.id), disconnect = button('断开', 'disconnect', edge.id);
            replace.disabled = disconnect.disabled = disabled;
            replace.addEventListener('click', () => { replacing = replacing === edge.id ? null : edge.id; refresh(true); });
            disconnect.addEventListener('click', () => { void edit(edge.id, { disconnect: true }); });
            controls.append(select, replace, disconnect); row.append(controls);
            if (node.type === 'ImageMerge') {
                const ordering = documentRef.createElement('div'); ordering.className = 'image-input-order-controls';
                const locked = running || editing || pending || !moveMergeInputConnection
                    || descriptions.some(({ source }) => state.runningNodeIds?.has(source?.id) || ['waiting', 'running'].includes(source?.runStatus));
                const up = button('前移', 'move-up', edge.id), down = button('后移', 'move-down', edge.id);
                up.disabled = locked || index === 0; down.disabled = locked || index === edges.length - 1;
                up.setAttribute('aria-label', `前移${description.title}`); down.setAttribute('aria-label', `后移${description.title}`);
                up.addEventListener('click', () => { void move(edge.id, -1); });
                down.addEventListener('click', () => { void move(edge.id, 1); });
                ordering.append(up, down); row.append(ordering);
            }
            if (edge.to.port === 'mask' && edge.maskConsumption !== 'single') {
                const compatibility = documentRef.createElement('span'); compatibility.className = 'image-input-compatibility';
                compatibility.textContent = '使用来源第 1 张 · 旧连接兼容'; row.append(compatibility);
            }
            if (replacing === edge.id) {
                const replacement = documentRef.createElement('div'); replacement.className = 'image-input-replacement';
                const sources = documentRef.createElement('select'); sources.dataset.inputReplacementSource = '';
                sources.setAttribute('aria-label', `替换${description.title}的来源输出`);
                sources.disabled = disabled;
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
                sources.addEventListener('change', event => { event.stopPropagation(); confirm.disabled = disabled || !sources.value || pending; });
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
