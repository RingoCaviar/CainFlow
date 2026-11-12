import { getCanonicalImageList } from '../execution/execution-data-utils.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { getNodeDefinition } from '../../nodes/registry.js';
import { getUniversalInputRoles, resolveUniversalInput } from '../../nodes/universal-input-policy.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';

const typeLabels = { image: '图片', text: '文本', params: '参数', video: '视频', any: '任意类型' };
let moreSequence = 0;

function hasPreviewablePrimaryImage(source, output) {
    if (!source || source.enabled === false || !output) return false;
    if (output.remote) return !!output.images[0];
    if (output.missingPositions.includes(0)) return false;
    const raw = [source.data?.imageList, source.data?.images, source.imageDataList]
        .find(list => Array.isArray(list) && list.length);
    return (!raw || !!raw[0]) && !!(output.images[0] || output.assets[0]);
}

function describeSource(state, edge, referenceGroup, allowPreview) {
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
    const canPreview = allowPreview && hasPreviewablePrimaryImage(source, projection);
    return { source, type, count, title, status, missing, canPreview };
}

/** Presentation of the authoritative edges; edits are delegated to the graph API. */
export function createImageInputDetail({ state, node, documentRef, updateInputConnection, swapInputConnections, moveMergeInputConnection, openReferencePreview = null, onChange = () => {} }) {
    const element = documentRef.createElement('section');
    element.className = 'image-input-detail';
    element.setAttribute('aria-label', '输入明细');
    const surfaces = getSurfaceCoordinator(documentRef);
    let closeMore = null;
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
    function sourceMore(title) {
        const more = documentRef.createElement('details'); more.className = 'image-source-more image-input-more';
        const trigger = documentRef.createElement('summary'); trigger.className = 'image-source-more-trigger';
        trigger.textContent = '更多'; trigger.setAttribute('aria-label', `${title}输入连接的更多操作`);
        trigger.setAttribute('aria-expanded', 'false');
        const actions = documentRef.createElement('div'); actions.className = 'image-source-more-actions';
        const menuId = `image-input-more-${++moreSequence}`;
        actions.id = menuId; trigger.setAttribute('aria-controls', menuId);
        const close = () => {
            more.open = false; trigger.setAttribute('aria-expanded', 'false');
            if (closeMore === close) closeMore = null;
            surfaces?.forgetPopover(menuId);
        };
        more.append(trigger, actions);
        more.addEventListener('click', event => event.stopPropagation());
        const sync = () => {
            trigger.setAttribute('aria-expanded', String(more.open));
            if (more.open && more.isConnected) {
                if (closeMore !== close) {
                    closeMore?.(); closeMore = close;
                    surfaces?.openPopover(menuId, { element: actions, trigger, close });
                }
            } else {
                if (closeMore === close) closeMore = null;
                surfaces?.forgetPopover(menuId);
            }
        };
        trigger.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            if (more.open) close(); else { more.open = true; sync(); }
        });
        more.addEventListener('toggle', sync);
        more.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !more.open) return;
            event.preventDefault(); event.stopPropagation(); close(); trigger.focus({ preventScroll: true });
        });
        return { element: more, actions, close };
    }
    function focusRowControl(edgeId, selector = '.image-source-more-trigger') {
        if (!element.isConnected || !element.getClientRects().length || element.closest('[inert]')) return;
        const rows = [...element.querySelectorAll('.image-input-row')];
        const row = rows.find(item => item.dataset.inputConnectionId === edgeId);
        const control = row?.querySelector(selector) || row?.querySelector('.image-source-more-trigger')
            || rows[0]?.querySelector('.image-source-more-trigger');
        if (control) control.focus({ preventScroll: true });
        else { element.tabIndex = -1; element.focus({ preventScroll: true }); }
    }
    async function edit(edgeId, changes) {
        if (!updateInputConnection || pending) return;
        const restoreFocus = element.contains(documentRef.activeElement);
        const returnToRole = documentRef.activeElement?.hasAttribute('data-input-role');
        pending = true;
        try {
            const result = await updateInputConnection(edgeId, changes);
            if (result?.changed) { replacing = null; onChange(node.id); }
        } finally {
            pending = false; refresh(true);
            if (restoreFocus) focusRowControl(edgeId, replacing === edgeId ? '[data-input-replacement-source]'
                : returnToRole ? '[data-input-role]' : '.image-source-more-trigger');
        }
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
        const cameraPreview = !!openReferencePreview && node.type === 'CameraControl';
        const descriptions = edges.map(edge => describeSource(state, edge, references.get(edge.id), cameraPreview && edge.to.port === 'image'));
        const candidates = replacing ? outputs() : [];
        const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus);
        const editing = state.historyTransitionInProgress || state.canvasPlanApplying;
        const nextSignature = JSON.stringify([edges.map(({ id, from, to, type, order, maskConsumption }) => (
            [id, from, to, type, order, maskConsumption]
        )), descriptions.map(({ type, count, title, status, source, canPreview }) => (
            [type, count, title, status, canPreview, state.runningNodeIds?.has(source?.id)]
        )), candidates, running, editing, !!updateInputConnection, !!swapInputConnections, !!moveMergeInputConnection, pending, statusMessage]);
        if (!force && signature === nextSignature) return;
        signature = nextSignature;
        closeMore?.();
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
            const more = sourceMore(description.title);
            const mediaCount = description.type === 'image' ? `${description.count} 张图片`
                : description.type === 'video' ? `${description.count} 个视频` : '';
            const purpose = availableRoles.find(([role]) => role === edge.to.port)?.[1] || edge.to.port;
            const targetTitle = node.customTitle || node.el?.dataset.nodeTitle || getNodeDefinition(node.type)?.title || node.id;
            const replace = button('替换来源', 'replace', edge.id);
            const disconnect = button(`断开此来源${mediaCount ? ` · ${mediaCount}` : ''}`, 'disconnect', edge.id);
            replace.setAttribute('aria-label', `替换${description.title}到${targetTitle}的${purpose}连接`);
            disconnect.setAttribute('aria-label', `断开${description.title}到${targetTitle}的${purpose}连接${mediaCount ? `，来源完整批次包含 ${mediaCount}` : ''}，保留源节点和媒体`);
            disconnect.title = '仅断开此来源连接，保留源节点和媒体';
            replace.disabled = disconnect.disabled = disabled;
            replace.addEventListener('click', () => {
                more.close(); replacing = replacing === edge.id ? null : edge.id; refresh(true);
                focusRowControl(edge.id, '[data-input-replacement-source]');
            });
            disconnect.addEventListener('click', () => { void edit(edge.id, { disconnect: true }); });
            more.actions.append(replace, disconnect);
            controls.append(select);
            if (description.canPreview) {
                const preview = button('预览参考图', 'preview', edge.id);
                preview.dataset.nodeReadAction = 'true';
                preview.setAttribute('aria-label', `预览${description.title}的参考图`);
                preview.addEventListener('click', () => {
                    void openReferencePreview(edge, () => focusRowControl(edge.id, '[data-input-action="preview"]'));
                });
                controls.append(preview);
            }
            if (node.type === 'ImageMerge') {
                const ordering = documentRef.createElement('div'); ordering.className = 'image-input-order-controls';
                const locked = running || editing || pending || !moveMergeInputConnection
                    || descriptions.some(({ source }) => state.runningNodeIds?.has(source?.id) || ['waiting', 'running'].includes(source?.runStatus));
                const up = button('前移', 'move-up', edge.id), down = button('后移', 'move-down', edge.id);
                up.disabled = locked || index === 0; down.disabled = locked || index === edges.length - 1;
                up.setAttribute('aria-label', `前移${description.title}`); down.setAttribute('aria-label', `后移${description.title}`);
                up.addEventListener('click', () => { void move(edge.id, -1); });
                down.addEventListener('click', () => { void move(edge.id, 1); });
                ordering.append(up, down); controls.append(ordering);
            }
            controls.append(more.element); row.append(controls);
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
                cancel.addEventListener('click', () => { replacing = null; refresh(true); focusRowControl(edge.id); });
                replacement.append(sources, confirm, cancel); row.append(replacement);
            }
            element.append(row);
        });
    }
    element.addEventListener('input', event => event.stopPropagation());
    return { element, refresh };
}
