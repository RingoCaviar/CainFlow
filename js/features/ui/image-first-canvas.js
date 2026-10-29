import { cleanupElementResources } from '../../core/common-utils.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { createImageInputDetail } from './image-input-detail.js';
import { isImageFirstCardNode } from '../../nodes/image-first-presentation.js';
import { getCanonicalImageList, getCanonicalImageIndex } from '../execution/execution-data-utils.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { normalizeCameraState } from '../camera/camera-prompt-utils.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';
import { renderImageNodeRunState } from '../../nodes/image-node-run-state.js';

const nodeLabels = { ImageGenerate: '图片生成', ImageImport: '图片导入', ImagePreview: '图片预览', ImageResize: '缩放图片', ColorReset: '复位颜色', ImageCompare: '图片对比', ImageMerge: '多图合一', ImageSave: '保存节点', CameraControl: '视角控制' };
const cameraFields = [['pitch', '俯仰角 Pitch'], ['yaw', '偏航角 Yaw'], ['distance', '距离 Distance'], ['fov', '视野角 FOV'], ['roll', '翻滚角 Roll']];

/** A single editor presentation; the workflow and its original controls remain authoritative. */
export function createImageFirstCanvas({ state, selectionApi, documentRef, windowRef, storage,
    runToNode, fitNode, onSettingsChanged = () => {}, bindPorts = () => {}, updateInputConnection, swapInputConnections, moveMergeInputConnection,
    panelManager = null, openAgent = () => {} }) {
    const views = new Map();
    const surfaces = getSurfaceCoordinator(documentRef);
    const panel = documentRef.createElement('section');
    panel.id = 'image-parameter-panel';
    panel.className = 'image-parameter-panel';
    panel.setAttribute('aria-label', '节点参数浮层');
    panel.hidden = true;
    panel.innerHTML = `<header class="image-parameter-header"><span class="image-parameter-drag-handle" tabindex="0" role="button" aria-label="拖动节点参数浮层" hidden>⠿</span><div class="image-parameter-tools"><button type="button" data-parameter-action="expand" aria-label="放大节点参数浮层" aria-pressed="false">⤢</button><button type="button" data-parameter-action="close" aria-label="关闭节点参数浮层">×</button></div></header>
        <div class="image-parameter-scroll"></div><footer class="image-parameter-footer"><span class="image-parameter-feedback"></span><span class="image-parameter-count-slot" hidden></span><button type="button" class="save-btn" data-parameter-action="generate">生成</button></footer>
        <span class="image-parameter-resize" data-parameter-resize="width" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整节点参数浮层宽度"></span>
        <span class="image-parameter-resize-height" data-parameter-resize="height" tabindex="0" role="separator" aria-orientation="horizontal" aria-label="调整节点参数浮层高度" hidden></span>
        <span class="image-parameter-resize-corner" data-parameter-resize="both" tabindex="0" role="button" aria-label="调整节点参数浮层大小" hidden></span>`;
    const store = documentRef.createElement('div');
    store.hidden = true;
    store.className = 'image-parameter-store';
    const switcher = documentRef.createElement('nav'); switcher.className = 'image-panel-switcher';
    switcher.setAttribute('aria-label', '面板置顶');
    switcher.innerHTML = '<button type="button" data-parameter-action="front-parameters" aria-controls="image-parameter-panel" aria-expanded="false">打开参数</button><button type="button" data-parameter-action="front-agent" aria-controls="prompt-agent-panel" aria-expanded="false">打开助手</button>';
    documentRef.body.append(store, panel, switcher);
    const scroll = panel.querySelector('.image-parameter-scroll');
    const feedback = panel.querySelector('.image-parameter-feedback');
    const footer = panel.querySelector('.image-parameter-footer');
    const countSlot = panel.querySelector('.image-parameter-count-slot');
    const generate = panel.querySelector('[data-parameter-action="generate"]');
    const promptSizing = new WeakMap();
    const storedWidth = Number(storage?.getItem('cainflow_node_parameter_width'));
    let current = null, closed = null, preferredWidth = storedWidth >= 280 && storedWidth <= 960 ? storedWidth : 480;
    let positionFrame = null, gesture = null, expanded = false, expandedRect = null, returnFocusElement = null;
    const expandButton = panel.querySelector('[data-parameter-action="expand"]');
    const dragHandle = panel.querySelector('.image-parameter-drag-handle');
    const widthHandle = panel.querySelector('[data-parameter-resize="width"]');
    const heightHandle = panel.querySelector('[data-parameter-resize="height"]');
    const cornerHandle = panel.querySelector('[data-parameter-resize="both"]');
    const parametersFront = switcher.querySelector('[data-parameter-action="front-parameters"]');
    const agentFront = switcher.querySelector('[data-parameter-action="front-agent"]');
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
    const available = () => {
        const toolbar = documentRef.getElementById('toolbar');
        // The toolbar reveals itself on hover. Keep floating controls outside
        // its full footprint even while its translated presentation is hidden.
        const top = expanded && toolbar?.getClientRects().length
            ? Math.min(toolbar.offsetHeight + 12, Math.max(12, windowRef.innerHeight - 12)) : 12;
        return { width: Math.max(1, windowRef.innerWidth - 24), height: Math.max(1, windowRef.innerHeight - top - 12), top };
    };
    const selectedNode = () => state.selectedNodes.size === 1 ? state.nodes.get([...state.selectedNodes][0]) : null;
    function updateSwitcher() {
        const node = selectedNode(), agentOpen = documentRef.getElementById('prompt-agent-panel')?.classList.contains('active');
        parametersFront.disabled = !node || !views.has(node);
        parametersFront.textContent = panel.hidden ? '打开参数' : '参数置顶';
        parametersFront.setAttribute('aria-expanded', String(!panel.hidden));
        agentFront.textContent = agentOpen ? '助手置顶' : '打开助手';
        agentFront.setAttribute('aria-expanded', String(!!agentOpen));
    }
    function updateMode() {
        panel.classList.toggle('is-expanded', expanded); panel.dataset.mode = expanded ? 'expanded' : 'normal';
        expandButton.setAttribute('aria-label', expanded ? '还原节点参数浮层' : '放大节点参数浮层');
        expandButton.setAttribute('aria-pressed', String(expanded));
        expandButton.textContent = expanded ? '⤡' : '⤢';
        dragHandle.hidden = heightHandle.hidden = cornerHandle.hidden = !expanded;
    }
    function setReturnFocus(node, candidate = documentRef.activeElement) {
        if (candidate?.isConnected && !panel.contains(candidate) && !candidate.closest?.('.image-parameter-store')
            && (node.el.contains(candidate) || switcher.contains(candidate))
            && candidate.matches?.('button,input,textarea,select,a[href],[tabindex]')) returnFocusElement = candidate;
        else { node.el.setAttribute('tabindex', '-1'); returnFocusElement = node.el; }
    }

    function sizePrompt() {
        const prompt = current?.parameterRoot?.querySelector('.image-generate-prompt');
        if (!prompt?.getClientRects().length) return;
        let sizing = promptSizing.get(prompt);
        if (!sizing) {
            sizing = { manual: !!prompt.style.height, autoHeight: '', key: '' };
            promptSizing.set(prompt, sizing);
        }
        if (sizing.autoHeight && prompt.style.height !== sizing.autoHeight) sizing.manual = true;
        if (sizing.manual) return;
        const key = `${panel.style.width}\n${prompt.value}`;
        if (sizing.key === key) return;
        sizing.key = key;
        const style = windowRef.getComputedStyle(prompt);
        const line = Number.parseFloat(style.lineHeight) || 21;
        const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
        prompt.style.height = 'auto';
        const height = Math.min(line * 6 + padding + border,
            Math.max(line * 3 + padding + border, prompt.scrollHeight + border));
        sizing.autoHeight = `${Math.ceil(height)}px`;
        prompt.style.height = sizing.autoHeight;
    }

    function position() {
        if (panel.hidden || !current?.el?.isConnected) return;
        const rect = current.el.getBoundingClientRect();
        const bounds = available();
        if (expanded) {
            if (!expandedRect) {
                const width = Math.min(860, bounds.width);
                const height = Math.min(680, bounds.height, Math.max(160, windowRef.innerHeight - bounds.top * 2));
                expandedRect = { left: (windowRef.innerWidth - width) / 2, top: (windowRef.innerHeight - height) / 2, width, height };
            }
            const width = Math.min(expandedRect.width, bounds.width), height = Math.min(expandedRect.height, bounds.height);
            panel.style.setProperty('--image-parameter-available-height', `${bounds.height}px`);
            panel.style.width = `${width}px`; panel.style.height = `${height}px`;
            panel.style.left = `${clamp(expandedRect.left, 12, Math.max(12, windowRef.innerWidth - width - 12))}px`;
            panel.style.top = `${clamp(expandedRect.top, bounds.top, Math.max(bounds.top, windowRef.innerHeight - height - 12))}px`;
            heightHandle.setAttribute('aria-valuenow', String(Math.round(height)));
            widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
            sizePrompt();
            return;
        }
        const width = Math.min(preferredWidth, bounds.width);
        panel.style.width = `${width}px`;
        panel.style.height = '';
        panel.style.left = `${rect.left + rect.width / 2 - width / 2}px`;
        const floatingBottoms = ['.image-first-run-feedback', '.image-result-actions']
            .map(selector => current.el.querySelector(selector)).filter(element => element?.getClientRects().length)
            .map(element => element.getBoundingClientRect().bottom + 12);
        panel.style.top = `${Math.max(rect.bottom + 12, ...floatingBottoms)}px`;
        widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
        sizePrompt();
    }
    function schedulePosition() {
        if (positionFrame !== null || panel.hidden) return;
        positionFrame = windowRef.requestAnimationFrame(() => { positionFrame = null; position(); });
    }
    function park() {
        if (current?.parameterRoot) {
            const countField = views.get(current)?.countField;
            if (countField) { current.parameterRoot.append(countField); countField.hidden = true; }
            panel.append(footer);
            store.append(current.parameterRoot);
        }
        current = null;
    }
    function close({ remember = true } = {}) {
        if (remember) closed = current;
        finishGesture(true); expanded = false; expandedRect = null; updateMode();
        park();
        panel.hidden = true;
        panel.setAttribute('aria-hidden', 'true'); panel.inert = true; updateSwitcher();
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
    function setText(element, text) {
        if (element.textContent !== text) element.textContent = text;
    }
    function refreshNode(nodeId) {
        const node = state.nodes.get(nodeId), view = views.get(node);
        if (!view) return;
        if (node.type === 'ImageGenerate') {
            const settings = readImageGenerationSettings(node, documentRef);
            const model = state.models.find(item => item.id === settings.apiConfigId);
            setText(view.model, `当前设置：${model?.name || model?.modelId || '未选择模型'} · ${settings.aspect || '自动'} · ${settings.resolution || '自动'}`);
            const { count } = projectImageReferences({ state, targetId: node.id });
            setText(view.references, `参考 ${count} 张`);
            for (const [group, button] of view.groupButtons || []) {
                const text = group === 'model' ? (model?.name || model?.modelId || '选择模型')
                    : group === 'size' ? `${settings.aspect || '自动'} · ${settings.resolution || '自动'}`
                        : group === 'reference' ? `参考 ${count}`
                            : group === 'input' ? `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}` : '更多参数';
                setText(button, text);
                if (button.title !== text) button.title = text;
            }
            view.placeholder.hidden = !view.result.hidden;
            renderImageNodeRunState(node);
        } else if (node.type === 'ImageImport') {
            const mode = documentRef.getElementById(`${node.id}-import-mode`)?.value || node.importMode || 'upload';
            if (view.urlFields.hidden !== (mode !== 'url')) view.urlFields.hidden = mode !== 'url';
            view.urlFields.classList.toggle('hidden', mode !== 'url');
            setText(view.model, mode === 'url' ? 'URL 来源' : '本地素材');
        } else if (node.type === 'ImagePreview' || node.type === 'ImageMerge') {
            const { count } = projectImageOutput(node, getCanonicalImageList(node));
            const index = getCanonicalImageIndex(node, new Array(count));
            const message = node.type === 'ImageMerge' ? node.el.querySelector('.image-merge-preview')?.dataset.mergeMessage : '';
            setText(view.model, `${nodeLabels[node.type]}${count ? ` · ${index + 1} / ${count}` : ''}${message ? ` · ${message}` : ''}`);
            setText(view.references, `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}`);
        } else if (node.type === 'ImageResize' || node.type === 'ColorReset') {
            const message = node.el.querySelector('.preview-container')?.dataset.processingMessage;
            setText(view.model, `${nodeLabels[node.type]}${message ? ` · ${message}` : ''}`);
            setText(view.references, `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}`);
        } else if (node.type === 'ImageCompare') {
            const message = node.el.querySelector('.image-compare-container')?.dataset.compareMessage;
            setText(view.model, `${nodeLabels[node.type]}${message ? ` · ${message}` : ''}`);
            const edges = state.connections.filter(edge => edge.to.nodeId === node.id);
            setText(view.references, `A ${edges.some(edge => edge.to.port === 'imageA') ? '已连接' : '可选'} · B ${edges.some(edge => edge.to.port === 'imageB') ? '已连接' : '必需'}`);
        } else if (node.type === 'ImageSave') {
            const { count } = projectImageOutput(node, getCanonicalImageList(node));
            const videos = Array.isArray(node.data?.videos) && node.data.videos.length ? node.data.videos : node.data?.video ? [node.data.video] : [];
            const message = node.el.querySelector('.save-preview-container')?.dataset.saveMessage;
            setText(view.model, `图片 ${count} 张 · 视频 ${videos.length} 个${message ? ` · ${message}` : ''}`);
            setText(view.references, `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}`);
        } else if (node.type === 'CameraControl') {
            const settings = normalizeCameraState(Object.fromEntries(cameraFields.map(([key]) => [key, node.data?.[key] ?? node[key]])));
            const message = node.el.querySelector('.camera-control-node-preview')?.dataset.cameraMessage;
            setText(view.model, `俯仰 ${settings.pitch}° · 偏航 ${settings.yaw}°${message ? ` · ${message}` : ''}`);
            setText(view.references, `输入 ${state.connections.filter(edge => edge.to.nodeId === node.id).length}`);
            for (const [key, element] of view.cameraValues) {
                setText(element, key === 'viewMode' ? (node.data?.cameraViewMode === 'thirdPerson' ? '第三人称' : '第一人称')
                    : `${settings[key]}${key === 'distance' ? '' : '°'}`);
            }
            setText(view.cameraPrompt, node.data?.cameraPrompt || node.data?.text || '');
        }
        view.inputs?.refresh();
        if (current === node) {
            const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus) || node.el.classList.contains('running');
            generate.hidden = node.type === 'ImageImport';
            setText(generate, node.type === 'ImagePreview' ? (running ? '更新中' : '更新预览')
                : node.type === 'ImageCompare' ? (running ? '更新中' : '更新对比')
                : node.type === 'ImageMerge' ? (running ? '合并中' : '更新合并')
                : node.type === 'ImageSave' ? (running ? '更新中' : '更新媒体')
                : node.type === 'CameraControl' ? '编辑视角'
                : node.type === 'ImageResize' ? (running ? '处理中' : '处理图片')
                    : node.type === 'ColorReset' ? (running ? '调色中' : '应用调色') : (running ? '生成中' : '生成'));
            generate.disabled = running || node.enabled === false || (node.type === 'CameraControl' && (node.isClone || view.cameraOpen?.disabled));
            setText(feedback, node.type === 'ImageImport' ? '在卡片选择文件，或切换 URL 输入链接。'
                : node.type === 'ImagePreview' ? (node.previewInputState === 'stale' ? '未更新 · 当前无输入' : node.previewInputState === 'empty' ? '当前无输入' : '预览当前连接的图片')
                    : node.type === 'ImageCompare' ? node.el.querySelector('.image-compare-container')?.dataset.compareMessage || 'B 为必需输入；A 可选，移动指针调整分界。'
                    : node.type === 'ImageMerge' ? node.el.querySelector('.image-merge-preview')?.dataset.mergeMessage || '按图片输入的数字顺序合并每个来源的完整批次。'
                    : node.type === 'ImageSave' ? node.el.querySelector('.save-preview-container')?.dataset.saveMessage || '修改文件名后，使用卡片上的保存按钮保存媒体。'
                    : node.type === 'CameraControl' ? '在独立编辑器调整相机；参数即时保存，输出为相机提示词。'
                    : node.type === 'ImageResize' || node.type === 'ColorReset' ? '修改即时预览；点击按钮执行当前节点。'
                    : documentRef.getElementById(`${node.id}-run-status`)?.textContent || '修改不会自动生成');
            const passiveFeedback = ['修改不会自动生成', '待运行', '已完成', '预览当前连接的图片',
                'B 为必需输入；A 可选，移动指针调整分界。', '按图片输入的数字顺序合并每个来源的完整批次。',
                '修改文件名后，使用卡片上的保存按钮保存媒体。', '在独立编辑器调整相机；参数即时保存，输出为相机提示词。',
                '修改即时预览；点击按钮执行当前节点。'];
            const hasFeedback = !!feedback.textContent && !passiveFeedback.includes(feedback.textContent);
            feedback.hidden = !hasFeedback;
            panel.dataset.hasFeedback = String(hasFeedback);
            footer.hidden = node.type === 'ImageImport';
            schedulePosition();
        }
    }
    function open(node, group) {
        if (!views.has(node) || state.nodes.get(node.id) !== node) return;
        sweep();
        if (current !== node) { finishGesture(true); setReturnFocus(node); park(); }
        panelManager?.beforeOpen?.('parameters');
        current = node; closed = null;
        if (node.parameterRoot.parentNode !== scroll) scroll.append(node.parameterRoot);
        if (footer.parentNode !== node.parameterRoot) node.parameterRoot.append(footer);
        const view = views.get(node);
        countSlot.hidden = !view.countField;
        if (view.countField) {
            if (view.countField.parentNode !== countSlot) countSlot.append(view.countField);
            view.countField.hidden = false;
        }
        panel.dataset.nodeType = node.type;
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false'); panel.inert = false;
        panel.dataset.nodeId = node.id;
        panel.setAttribute('aria-label', `${node.customTitle || nodeLabels[node.type]} · 节点参数浮层`);
        if (group) { const view = views.get(node); if (view.group !== group) setGroup(node, group); }
        refreshNode(node.id);
        position();
        surfaces?.bringToFront?.(panel); updateSwitcher();
    }
    function select(node, group) {
        if (!state.selectedNodes.has(node.id) || state.selectedNodes.size !== 1) selectionApi.setSelection([node.id]);
        open(node, group);
    }
    function selectionChanged() {
        sweep();
        updateSwitcher();
        const ids = Array.from(state.selectedNodes);
        const node = ids.length === 1 ? state.nodes.get(ids[0]) : null;
        if (!node || !views.has(node)) { close({ remember: false }); closed = null; return; }
        if (closed !== node) open(node);
    }
    function installUniversalInput(node) {
        const inputSection = node.el.querySelector('.node-inputs-section');
        if (inputSection) {
            let universal = inputSection.querySelector('.universal-input');
            for (const port of inputSection.querySelectorAll('.node-port[data-direction="input"]')) {
                if (port === universal) continue;
                port.hidden = true;
                port.classList.add('image-first-canonical-input');
            }
            if (!universal) {
                universal = documentRef.createElement('div');
                universal.className = 'node-port input universal-input';
                universal.dataset.nodeId = node.id; universal.dataset.port = 'auto';
                universal.dataset.type = 'any'; universal.dataset.direction = 'input';
                universal.innerHTML = '<div class="port-dot type-any"></div><span class="port-label">输入</span>';
                inputSection.append(universal);
            }
            bindPorts(inputSection);
        }
    }
    function registerView(node, view, observed) {
        const { form } = view;
        form.dataset.nodeType = node.type;
        node.parameterRoot = form;
        node.el.classList.add('image-first-card');
        node.el.dataset.imageFirst = 'true';
        const observer = new MutationObserver(records => {
            if (state.nodes.get(node.id) !== node) return;
            let presentationChanged = false, geometryChanged = false;
            for (const record of records) {
                if (record.target === node.el && record.type === 'attributes') {
                    if (record.oldValue === node.el.getAttribute(record.attributeName)) continue;
                    // Canvas geometry does not change the graph or settings.
                    // Only the current editor needs to follow its anchor.
                    if (record.attributeName === 'style') geometryChanged = true;
                    else presentationChanged = true;
                } else presentationChanged = true;
            }
            if (presentationChanged) refreshNode(node.id);
            else if (geometryChanged && current === node) schedulePosition();
        });
        for (const element of observed.filter(Boolean)) observer.observe(element, {
            attributes: true, childList: true, subtree: true,
            ...(node.type === 'ImageCompare' ? { attributeFilter: ['src', 'data-compare-state', 'data-compare-message'] } : {})
        });
        observer.observe(node.el, { attributes: true, attributeOldValue: true, attributeFilter: ['style','class'] });
        view.observer = observer;
        views.set(node, view); store.append(form);
        node.onImageFirstSelect = () => select(node);
        form.addEventListener('mousedown', event => event.stopPropagation());
        form.addEventListener('input', () => { refreshNode(node.id); onSettingsChanged(node.id); });
        form.addEventListener('change', () => { refreshNode(node.id); onSettingsChanged(node.id); });
        form.addEventListener('toggle', () => { if (current === node) schedulePosition(); }, true);
        form.addEventListener('pointerup', () => { if (current === node) schedulePosition(); });
        node.el.addEventListener('click', event => {
            if (event.target.closest('.color-reset-preview.is-picking,.image-compare-divider')) return;
            if (!event.target.closest('button,input,textarea,select,video,.node-port,.node-select')) select(node);
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
        let inputs = null, references = null, urlFields = null, cameraOpen = null, cameraValues = null, cameraPrompt = null;
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
            if (node.type === 'ImageSave') {
                const warning = body.querySelector(`[id="${node.id}-path-warning"]`);
                const filename = body.querySelector(`[id="${node.id}-filename"]`)?.closest('.node-field');
                if (warning) form.append(warning);
                if (filename) form.append(filename);
            } else if (node.type === 'CameraControl') {
                cameraOpen = body.querySelector(`[id="${node.id}-camera-open"]`);
                const note = body.querySelector('.camera-control-note');
                if (note) form.append(note);
                const details = documentRef.createElement('dl'); details.className = 'image-camera-state-summary';
                details.setAttribute('aria-label', '相机参数（只读）'); cameraValues = new Map();
                for (const [key, label] of [...cameraFields, ['viewMode', '预览模式']]) {
                    const row = documentRef.createElement('div'), title = documentRef.createElement('dt'), value = documentRef.createElement('dd');
                    title.textContent = label; value.dataset.cameraSummary = key; row.append(title, value); details.append(row); cameraValues.set(key, value);
                }
                cameraPrompt = documentRef.createElement('output'); cameraPrompt.className = 'image-camera-prompt-summary';
                cameraPrompt.setAttribute('aria-label', '相机提示词（只读）'); cameraPrompt.tabIndex = 0;
                const promptDisclosure = documentRef.createElement('details'); promptDisclosure.className = 'image-camera-prompt-details';
                const promptSummary = documentRef.createElement('summary'); promptSummary.textContent = '相机提示词（只读）';
                promptDisclosure.append(promptSummary, cameraPrompt);
                form.append(details, promptDisclosure);
            }
            installUniversalInput(node);
            inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, swapInputConnections, moveMergeInputConnection, onChange: () => refreshNode(node.id) });
            inputs.element.dataset.parameterGroup = 'input'; sections.push(inputs.element); form.append(inputs.element);
            references = documentRef.createElement('button'); references.type = 'button';
            references.addEventListener('click', () => select(node, 'input')); summary.append(references);
            const suffix = { ImageCompare: 'compare', ImageMerge: 'merge-preview', ImageSave: 'save-preview', CameraControl: 'camera-preview' }[node.type] || 'preview';
            observed.push(body.querySelector(`[id="${node.id}-${suffix}"]`));
        }
        body.append(summary);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, model, references, inputs, urlFields, cameraOpen, cameraValues, cameraPrompt,
            group: node.type !== 'ImageImport' ? 'input' : null }, observed);
    }
    function installProcessing(node) {
        const body = node.el.querySelector('.node-body');
        const controls = body?.querySelector(node.type === 'ImageResize' ? '.image-resize-panel' : '.color-reset-panel');
        if (!body || !controls) return;
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content'; form.dataset.nodeId = node.id;
        // Move the original controls as one unit. The preview, its dedicated
        // gesture target and output metadata retain their original DOM identity.
        const surfaces = node.type === 'ImageResize'
            ? Array.from(controls.querySelectorAll(':scope > .image-resize-preview-frame, :scope > .image-resize-meta'))
            : Array.from(controls.querySelectorAll(':scope > .color-reset-preview, :scope > .image-resolution-badge'));
        body.append(...surfaces);
        controls.dataset.parameterGroup = 'settings';
        form.append(controls);
        installUniversalInput(node);
        const inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, onChange: () => refreshNode(node.id) });
        inputs.element.dataset.parameterGroup = 'input'; inputs.element.hidden = true;
        form.append(inputs.element);
        const bar = documentRef.createElement('div'); bar.className = 'image-parameter-setting-bar';
        for (const [name, label] of [['settings', node.type === 'ImageResize' ? '缩放设置' : '颜色设置'], ['input', '输入']]) {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
            button.dataset.parameterGroupToggle = name; button.setAttribute('aria-expanded', String(name === 'settings'));
            button.addEventListener('click', () => setGroup(node, name)); bar.append(button);
        }
        form.prepend(bar);
        const summary = documentRef.createElement('div'); summary.className = 'image-first-summary';
        const model = documentRef.createElement('span'), references = documentRef.createElement('button');
        references.type = 'button'; references.addEventListener('click', () => select(node, 'input'));
        summary.append(model, references); body.append(summary);
        node.el.classList.add('image-first-media', 'image-first-processing');
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections: [controls, inputs.element],
            model, references, inputs, group: 'settings' }, surfaces);
    }
    function install(nodeId) {
        sweep();
        const node = state.nodes.get(nodeId);
        if (!isImageFirstCardNode(node) || views.has(node)) return;
        if (node.type === 'ImageImport' || node.type === 'ImagePreview' || node.type === 'ImageCompare' || node.type === 'ImageMerge' || node.type === 'ImageSave' || node.type === 'CameraControl') { installMedia(node); return; }
        if (node.type === 'ImageResize' || node.type === 'ColorReset') { installProcessing(node); return; }
        if (node.type !== 'ImageGenerate') return;
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
        if (countField) {
            form.append(countField); countField.hidden = true;
            countField.classList.add('image-parameter-count-control');
            const label = countField.querySelector('label');
            if (label) label.textContent = '次数';
        }
        group(grids[1], 'size');
        group(form.querySelector('.node-advanced-parameters'), 'advanced');
        const bar = documentRef.createElement('div'); bar.className = 'image-parameter-setting-bar';
        const groupButtons = new Map();
        for (const [name, label] of [['input','输入'],['reference','参考图'],['model','模型 / 供应商'],['size','尺寸 / 质量'],['advanced','更多参数']]) {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
            button.dataset.parameterGroupToggle = name; button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', () => setGroup(node, name)); bar.append(button);
            groupButtons.set(name, button);
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
        const runFeedback = documentRef.createElement('div'); runFeedback.className = 'image-first-run-feedback';
        runFeedback.setAttribute('aria-label', '本轮生成状态');
        if (runState) runFeedback.append(runState);
        const dirty = documentRef.createElement('span'); dirty.dataset.imageGenerationDirty = '';
        dirty.textContent = '设置待生成'; dirty.hidden = true; runFeedback.append(dirty);
        const failureSummary = node.el.querySelector('.node-failure-summary');
        if (failureSummary) runFeedback.append(failureSummary);
        const failureDetails = documentRef.createElement('button'); failureDetails.type = 'button';
        failureDetails.dataset.imageRunAction = 'details'; failureDetails.textContent = '查看详情'; failureDetails.hidden = true;
        failureDetails.addEventListener('click', event => { event.stopPropagation(); failureSummary?.click(); });
        runFeedback.append(failureDetails);
        const cancel = node.el.querySelector('.node-run-cancel-btn');
        if (cancel) runFeedback.append(cancel);
        const fullError = body.querySelector(`[id="${nodeId}-error"]`);
        if (fullError) { fullError.tabIndex = 0; fullError.setAttribute('aria-label', '完整运行错误'); form.append(fullError); }
        body.append(placeholder, result, summary);
        node.el.append(runFeedback);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, placeholder, model, references, result, inputs, countField, groupButtons, group: null }, [result, progress]);
    }
    updateMode(); updateSwitcher();
    surfaces?.registerModeless?.(panel, { close: () => close(), isOpen: () => !panel.hidden, opener: () => returnFocusElement });
    panelManager?.registerAuxiliary?.('parameters', { close: () => close({ remember: false }) });
    panel.querySelector('[data-parameter-action="close"]').addEventListener('click', () => {
        if (surfaces?.closeModeless) surfaces.closeModeless(panel); else close();
    });
    expandButton.addEventListener('click', () => {
        finishGesture(true); expanded = !expanded; expandedRect = null; updateMode(); position(); surfaces?.bringToFront?.(panel);
    });
    parametersFront.addEventListener('click', () => {
        const node = selectedNode();
        if (!node || !views.has(node)) return;
        setReturnFocus(node, parametersFront); open(node);
    });
    agentFront.addEventListener('click', async () => {
        if (!documentRef.getElementById('prompt-agent-panel')?.classList.contains('active')) await openAgent();
        const agent = documentRef.getElementById('prompt-agent-panel');
        if (agent?.classList.contains('active')) surfaces?.bringToFront?.(agent);
        updateSwitcher();
    });
    const agent = documentRef.getElementById('prompt-agent-panel');
    if (agent) new windowRef.MutationObserver(updateSwitcher).observe(agent, { attributes: true, attributeFilter: ['class', 'hidden'] });
    generate.addEventListener('click', () => {
        if (!current) return;
        if (generate.disabled) return;
        if (current.type === 'CameraControl') { views.get(current)?.cameraOpen?.click(); return; }
        runToNode(current.id);
    });
    panel.addEventListener('mousedown', event => event.stopPropagation());
    function finishGesture(cancelled = false) {
        const previous = gesture;
        if (!previous) return;
        gesture = null; panel.classList.remove('is-dragging', 'is-resizing');
        if (cancelled) { preferredWidth = previous.preferredWidth; expandedRect = previous.expandedRect; }
        else if (!expanded && previous.changed) storage?.setItem('cainflow_node_parameter_width', String(Math.round(preferredWidth)));
        if (previous.handle.hasPointerCapture?.(previous.id)) previous.handle.releasePointerCapture(previous.id);
        position();
    }
    for (const [handle, kind] of [[dragHandle, 'drag'], [widthHandle, 'width'], [heightHandle, 'height'], [cornerHandle, 'both']]) {
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || panel.hidden || (!expanded && kind !== 'width')) return;
            event.preventDefault(); event.stopPropagation(); finishGesture(true);
            const rect = panel.getBoundingClientRect();
            gesture = { kind, id: event.pointerId, handle, x: event.clientX, y: event.clientY,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                preferredWidth, expandedRect: expandedRect ? { ...expandedRect } : null, changed: false };
            panel.classList.add(kind === 'drag' ? 'is-dragging' : 'is-resizing'); handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) finishGesture(true); });
        handle.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            if (!expanded && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); finishGesture(true);
            const rect = panel.getBoundingClientRect(), bounds = available();
            const dx = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
            const dy = event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0;
            if (!expanded) {
                preferredWidth = clamp(event.key === 'Home' ? 280 : event.key === 'End' ? 960 : rect.width + dx, 280, 960);
                storage?.setItem('cainflow_node_parameter_width', String(Math.round(preferredWidth)));
            } else if (kind === 'drag') {
                expandedRect.left = clamp(rect.left + dx, 12, Math.max(12, windowRef.innerWidth - rect.width - 12));
                expandedRect.top = clamp(rect.top + dy, bounds.top, Math.max(bounds.top, windowRef.innerHeight - rect.height - 12));
            } else {
                const maxWidth = Math.max(1, windowRef.innerWidth - rect.left - 12), maxHeight = Math.max(1, windowRef.innerHeight - rect.top - 12);
                if (kind !== 'height') expandedRect.width = clamp(event.key === 'Home' ? 280 : event.key === 'End' ? maxWidth : rect.width + dx, Math.min(280, bounds.width), maxWidth);
                if (kind !== 'width') expandedRect.height = clamp(event.key === 'Home' ? 160 : event.key === 'End' ? maxHeight : rect.height + dy, Math.min(160, bounds.height), maxHeight);
            }
            position();
        });
    }
    windowRef.addEventListener('pointermove', event => {
        if (!gesture || event.pointerId !== gesture.id) return;
        event.preventDefault(); event.stopPropagation();
        const { rect, kind } = gesture, dx = event.clientX - gesture.x, dy = event.clientY - gesture.y, bounds = available();
        gesture.changed ||= Math.abs(dx) + Math.abs(dy) > 0;
        if (!expanded) preferredWidth = clamp(rect.width + dx, 280, 960);
        else if (kind === 'drag') {
            expandedRect.left = clamp(rect.left + dx, 12, Math.max(12, windowRef.innerWidth - rect.width - 12));
            expandedRect.top = clamp(rect.top + dy, bounds.top, Math.max(bounds.top, windowRef.innerHeight - rect.height - 12));
        } else {
            if (kind !== 'height') expandedRect.width = clamp(rect.width + dx, Math.min(280, bounds.width), Math.max(1, windowRef.innerWidth - rect.left - 12));
            if (kind !== 'width') expandedRect.height = clamp(rect.height + dy, Math.min(160, bounds.height), Math.max(1, windowRef.innerHeight - rect.top - 12));
        }
        position();
    });
    windowRef.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) finishGesture(); });
    windowRef.addEventListener('pointercancel', event => { if (gesture?.id === event.pointerId) finishGesture(true); });
    windowRef.addEventListener('blur', () => finishGesture(true));
    documentRef.addEventListener('cainflow:canvas-transform', schedulePosition);
    windowRef.addEventListener('resize', schedulePosition);
    return { install, selectionChanged, close, refreshNode,
        refreshSource: sourceId => {
            const targets = new Set(state.connections.filter(edge => edge.from.nodeId === sourceId).map(edge => edge.to.nodeId));
            targets.add(sourceId); targets.forEach(refreshNode);
        },
        refresh: () => { sweep(); for (const node of views.keys()) if (state.nodes.get(node.id) === node) refreshNode(node.id); } };
}
