import { cleanupElementResources } from '../../core/common-utils.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { createImageInputDetail } from './image-input-detail.js';
import { isImageFirstCardNode } from '../../nodes/image-first-presentation.js';
import { getCanonicalImageList, getCanonicalImageIndex } from '../execution/execution-data-utils.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';

const nodeLabels = { ImageGenerate: '图片生成', ImageImport: '图片导入', ImagePreview: '图片预览' };

/** A single editor presentation; the workflow and its original controls remain authoritative. */
export function createImageFirstCanvas({ state, selectionApi, documentRef, windowRef, storage,
    runToNode, fitNode, onSettingsChanged = () => {}, bindPorts = () => {}, updateInputConnection }) {
    const views = new Map();
    const panel = documentRef.createElement('section');
    panel.id = 'image-parameter-panel';
    panel.className = 'image-parameter-panel';
    panel.setAttribute('aria-label', '节点参数');
    panel.hidden = true;
    panel.innerHTML = `<header class="image-parameter-header"><div class="image-parameter-tools"><button type="button" data-parameter-action="close" aria-label="关闭参数面板">×</button></div></header>
        <div class="image-parameter-scroll"></div><footer class="image-parameter-footer"><span class="image-parameter-feedback"></span><button type="button" class="save-btn" data-parameter-action="generate">生成</button></footer>
        <span class="image-parameter-resize" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整参数面板宽度"></span>`;
    const store = documentRef.createElement('div');
    store.hidden = true;
    store.className = 'image-parameter-store';
    documentRef.body.append(store, panel);
    const scroll = panel.querySelector('.image-parameter-scroll');
    const feedback = panel.querySelector('.image-parameter-feedback');
    const generate = panel.querySelector('[data-parameter-action="generate"]');
    let current = null, closed = null, preferredWidth = Number(storage?.getItem('cainflow_node_parameter_width')) || 480;
    let positionFrame = null, resizing = null;

    function position() {
        if (panel.hidden || !current?.el?.isConnected) return;
        const rect = current.el.getBoundingClientRect();
        const width = Math.max(280, Math.min(preferredWidth, windowRef.innerWidth - 24));
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(12, Math.min(windowRef.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`;
        panel.style.top = `${rect.bottom + 50}px`;
    }
    function schedulePosition() {
        if (positionFrame !== null || panel.hidden) return;
        positionFrame = windowRef.requestAnimationFrame(() => { positionFrame = null; position(); });
    }
    function park() {
        if (current?.parameterRoot) store.append(current.parameterRoot);
        current = null;
    }
    function close({ remember = true } = {}) {
        if (remember) closed = current;
        park();
        panel.hidden = true;
    }
    function remove(node) {
        const view = views.get(node);
        if (!view) return;
        if (current === node) close({ remember: false });
        view.observer.disconnect();
        cleanupElementResources(view.form);
        view.form.remove();
        views.delete(node);
        delete node.parameterRoot;
        delete node.onImageFirstSelect;
    }
    function sweep() {
        for (const [node, view] of views) {
            const active = state.nodes.get(node.id) === node;
            if (!active) {
                if (current === node) close({ remember: false });
                view.fragment.append(view.form);
            } else if (view.form.parentNode === view.fragment) store.append(view.form);
        }
    }
    function setGroup(node, group) {
        const view = views.get(node);
        if (!view) return;
        view.group = view.group === group ? null : group;
        for (const section of view.sections) {
            section.hidden = section.dataset.parameterGroup !== view.group;
            if (section.tagName === 'DETAILS') section.open = !section.hidden;
        }
        view.form.querySelectorAll('[data-parameter-group-toggle]').forEach(button => {
            button.setAttribute('aria-expanded', String(button.dataset.parameterGroupToggle === view.group));
        });
        schedulePosition();
    }
    function refreshNode(nodeId) {
        const node = state.nodes.get(nodeId), view = views.get(node);
        if (!view) return;
        if (node.type === 'ImageGenerate') {
            const settings = readImageGenerationSettings(node, documentRef);
            const model = state.models.find(item => item.id === settings.apiConfigId);
            view.model.textContent = `${model?.name || model?.modelId || '未选择模型'} · ${settings.aspect || '自动'} · ${settings.resolution || '自动'}`;
            const { count } = projectImageReferences({ state, targetId: node.id });
            view.references.textContent = `参考 ${count} 张`;
            view.placeholder.hidden = !view.result.hidden;
        } else if (node.type === 'ImageImport') {
            const mode = documentRef.getElementById(`${node.id}-import-mode`)?.value || node.importMode || 'upload';
            view.urlFields.hidden = mode !== 'url';
            view.urlFields.classList.toggle('hidden', mode !== 'url');
            view.model.textContent = mode === 'url' ? 'URL 来源' : '本地素材';
        } else {
            const { count } = projectImageOutput(node, getCanonicalImageList(node));
            const index = getCanonicalImageIndex(node, new Array(count));
            view.model.textContent = count ? `图片预览 · ${index + 1} / ${count}` : '图片预览';
            view.references.textContent = `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}`;
        }
        view.inputs?.refresh();
        if (current === node) {
            const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus) || node.el.classList.contains('running');
            generate.hidden = node.type === 'ImageImport';
            generate.textContent = node.type === 'ImagePreview' ? (running ? '更新中' : '更新预览') : (running ? '生成中' : '生成');
            generate.disabled = running || node.enabled === false;
            feedback.textContent = node.type === 'ImageImport' ? '在卡片选择文件，或切换 URL 输入链接。'
                : node.type === 'ImagePreview' ? (node.previewInputState === 'stale' ? '未更新 · 当前无输入' : node.previewInputState === 'empty' ? '当前无输入' : '预览当前连接的图片')
                    : documentRef.getElementById(`${node.id}-run-status`)?.textContent || '修改不会自动生成';
            schedulePosition();
        }
    }
    function open(node, group) {
        if (!views.has(node) || state.nodes.get(node.id) !== node) return;
        sweep();
        if (current !== node) park();
        current = node; closed = null;
        scroll.append(node.parameterRoot);
        panel.hidden = false;
        panel.dataset.nodeId = node.id;
        panel.setAttribute('aria-label', `${node.customTitle || nodeLabels[node.type]} · 节点参数`);
        if (group) { const view = views.get(node); if (view.group !== group) setGroup(node, group); }
        refreshNode(node.id);
        position();
    }
    function select(node, group) {
        if (!state.selectedNodes.has(node.id) || state.selectedNodes.size !== 1) selectionApi.setSelection([node.id]);
        open(node, group);
    }
    function selectionChanged() {
        sweep();
        const ids = Array.from(state.selectedNodes);
        const node = ids.length === 1 ? state.nodes.get(ids[0]) : null;
        if (!node || !views.has(node)) { close({ remember: false }); closed = null; return; }
        if (closed !== node) open(node);
    }
    function installUniversalInput(node) {
        const inputSection = node.el.querySelector('.node-inputs-section');
        if (inputSection) {
            for (const port of inputSection.querySelectorAll('.node-port[data-direction="input"]')) {
                port.hidden = true;
                port.classList.add('image-first-canonical-input');
            }
            const universal = documentRef.createElement('div');
            universal.className = 'node-port input universal-input';
            universal.dataset.nodeId = node.id; universal.dataset.port = 'auto';
            universal.dataset.type = 'any'; universal.dataset.direction = 'input';
            universal.innerHTML = '<div class="port-dot type-any"></div><span class="port-label">输入</span>';
            inputSection.append(universal); bindPorts(universal.parentElement);
        }
    }
    function registerView(node, view, observed) {
        const { form } = view;
        node.parameterRoot = form;
        node.el.classList.add('image-first-card');
        node.el.dataset.imageFirst = 'true';
        const observer = new MutationObserver(() => { if (state.nodes.get(node.id) === node) refreshNode(node.id); });
        for (const element of observed.filter(Boolean)) observer.observe(element, { attributes: true, childList: true, subtree: true });
        observer.observe(node.el, { attributes: true, attributeFilter: ['style','class'] });
        view.observer = observer;
        views.set(node, view); store.append(form);
        node.onImageFirstSelect = () => select(node);
        form.addEventListener('mousedown', event => event.stopPropagation());
        form.addEventListener('input', () => { refreshNode(node.id); onSettingsChanged(node.id); });
        form.addEventListener('change', () => { refreshNode(node.id); onSettingsChanged(node.id); });
        node.el.addEventListener('click', event => {
            if (!event.target.closest('button,input,textarea,select,.node-port,.node-select')) select(node);
        });
        if (!Array.isArray(node.el._cleanupFns)) node.el._cleanupFns = [];
        node.el._cleanupFns.push(() => remove(node));
        refreshNode(node.id);
        fitNode(node.id, { allowShrink: true, preserveCurrentWidth: true, reason: 'element-resize', save: false });
        selectionChanged();
    }
    function installMedia(node) {
        const body = node.el.querySelector('.node-body');
        if (!body) return;
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content'; form.dataset.nodeId = node.id;
        const sections = [], observed = [];
        const summary = documentRef.createElement('div'); summary.className = 'image-first-summary';
        const model = documentRef.createElement('span'); summary.append(model);
        let inputs = null, references = null, urlFields = null;
        node.el.classList.add('image-first-media');
        if (node.type === 'ImageImport') {
            const mode = body.querySelector('.image-import-mode-shell');
            const modeInput = body.querySelector(`[id="${node.id}-import-mode"]`);
            if (mode) form.append(mode);
            if (modeInput) form.append(modeInput);
            const urlSection = body.querySelector(`[id="${node.id}-url-section"]`);
            urlFields = documentRef.createElement('div'); urlFields.className = 'image-import-url-fields';
            urlFields.dataset.imageImportMode = 'url';
            for (const element of Array.from(urlSection?.children || [])) {
                if (!element.classList.contains('file-drop-zone')) urlFields.append(element);
            }
            form.append(urlFields);
            observed.push(body.querySelector(`[id="${node.id}-upload-section"]`), urlSection);
        } else {
            installUniversalInput(node);
            inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, onChange: () => refreshNode(node.id) });
            inputs.element.dataset.parameterGroup = 'input'; sections.push(inputs.element); form.append(inputs.element);
            references = documentRef.createElement('button'); references.type = 'button';
            references.addEventListener('click', () => select(node, 'input')); summary.append(references);
            observed.push(body.querySelector(`[id="${node.id}-preview"]`));
        }
        body.append(summary);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, model, references, inputs, urlFields,
            group: node.type === 'ImagePreview' ? 'input' : null }, observed);
    }
    function install(nodeId) {
        sweep();
        const node = state.nodes.get(nodeId);
        if (!isImageFirstCardNode(node) || views.has(node)) return;
        if (node.type !== 'ImageGenerate') { installMedia(node); return; }
        const body = node.el.querySelector('.node-body');
        const result = body?.querySelector(`#${nodeId}-image-results`);
        if (!body || !result) return;
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content';
        form.dataset.nodeId = node.id;
        for (const element of Array.from(body.children)) {
            if (element === result || element.id === `${nodeId}-error` || element.classList.contains('image-node-run-actions') || element.classList.contains('node-generation-progress-field')) continue;
            form.append(element);
        }
        installUniversalInput(node);
        const sections = [];
        function group(element, name) {
            if (!element) return;
            element.dataset.parameterGroup = name; element.hidden = true; sections.push(element);
        }
        group(form.querySelector('.image-reference-overview'), 'reference');
        const inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection,
            onChange: () => refreshNode(node.id) });
        form.append(inputs.element); group(inputs.element, 'input');
        const grids = Array.from(form.querySelectorAll(':scope > .node-parameter-grid'));
        group(grids[0], 'model');
        const countField = form.querySelector(`[id="${nodeId}-generation-count"]`)?.closest('.node-field');
        if (countField) { form.append(countField); group(countField, 'count'); }
        group(grids[1], 'size');
        group(form.querySelector('.node-advanced-parameters'), 'advanced');
        const bar = documentRef.createElement('div'); bar.className = 'image-parameter-setting-bar';
        for (const [name, label] of [['input','输入'],['reference','参考图'],['model','模型 / 供应商'],['size','尺寸 / 质量'],['count','次数'],['advanced','更多参数']]) {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
            button.dataset.parameterGroupToggle = name; button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', () => setGroup(node, name)); bar.append(button);
        }
        const promptField = form.querySelector('.image-node-prompt-field');
        if (promptField) promptField.after(bar); else form.prepend(bar);
        const placeholder = documentRef.createElement('div'); placeholder.className = 'image-first-placeholder';
        const emptyText = documentRef.createElement('span'); emptyText.textContent = '尚未生成';
        const edit = documentRef.createElement('button'); edit.type = 'button'; edit.textContent = '编辑提示词';
        edit.addEventListener('click', () => { select(node); documentRef.getElementById(`${node.id}-prompt`)?.focus({ preventScroll: true }); });
        placeholder.append(emptyText, edit); body.prepend(placeholder);
        const summary = documentRef.createElement('div'); summary.className = 'image-first-summary';
        const model = documentRef.createElement('span'), references = documentRef.createElement('button');
        references.type = 'button'; references.addEventListener('click', () => select(node, 'reference'));
        summary.append(model, references); body.append(summary);
        const runState = body.querySelector('.image-node-run-actions');
        const progress = body.querySelector('.node-generation-progress-field');
        if (runState && progress) runState.append(progress);
        body.append(placeholder, result, summary);
        if (runState) body.append(runState);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, placeholder, model, references, result, inputs, group: null }, [result]);
    }
    panel.querySelector('[data-parameter-action="close"]').addEventListener('click', () => close());
    generate.addEventListener('click', () => {
        if (!current) return;
        if (generate.disabled) return;
        runToNode(current.id);
    });
    panel.addEventListener('mousedown', event => event.stopPropagation());
    const resize = panel.querySelector('.image-parameter-resize');
    resize.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); resizing = { x: event.clientX, width: panel.getBoundingClientRect().width };
        resize.setPointerCapture?.(event.pointerId);
    });
    windowRef.addEventListener('pointermove', event => {
        if (!resizing) return;
        preferredWidth = Math.max(280, Math.min(960, resizing.width + event.clientX - resizing.x)); position();
    });
    windowRef.addEventListener('pointerup', () => {
        if (!resizing) return;
        resizing = null; storage?.setItem('cainflow_node_parameter_width', String(Math.round(preferredWidth)));
    });
    resize.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
        event.preventDefault(); preferredWidth = Math.max(280, Math.min(960, preferredWidth + (event.key === 'ArrowRight' ? 10 : -10)));
        storage?.setItem('cainflow_node_parameter_width', String(preferredWidth)); position();
    });
    documentRef.addEventListener('cainflow:canvas-transform', schedulePosition);
    windowRef.addEventListener('resize', schedulePosition);
    return { install, selectionChanged, close, refreshNode,
        refreshSource: sourceId => {
            const targets = new Set(state.connections.filter(edge => edge.from.nodeId === sourceId).map(edge => edge.to.nodeId));
            targets.add(sourceId); targets.forEach(refreshNode);
        },
        refresh: () => { sweep(); for (const node of views.keys()) if (state.nodes.get(node.id) === node) refreshNode(node.id); } };
}
