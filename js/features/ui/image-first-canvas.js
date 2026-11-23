import { hasVisualStyleReference } from '../../nodes/visual-style-view.js';
import { cleanupElementResources } from '../../core/common-utils.js';
import { readImageGenerationSettings } from '../../nodes/image-generation-settings.js';
import { REFERENCE_IMAGES_PORT } from '../../nodes/reference-image-ports.js';
import { createImageInputDetail } from './image-input-detail.js';
import { hasDedicatedInputPort } from '../../nodes/universal-input-policy.js';
import { isImageFirstCardNode } from '../../nodes/image-first-presentation.js';
import { getCanonicalImageList, getCanonicalImageIndex } from '../execution/execution-data-utils.js';
import { projectImageOutput } from '../../nodes/image-output-projection.js';
import { normalizeCameraState } from '../camera/camera-prompt-utils.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';
import { projectImageCardRunStatus, renderImageNodeRunState } from '../../nodes/image-node-run-state.js';
import { getNodeModelConfigurationIssue } from '../execution/model-configuration-readiness.js';
import { getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { createCommerceImageSetView } from '../../nodes/commerce-image-set-view.js';
import { createProductRetouchView } from '../../nodes/product-retouch-view.js';
import { createImageGenerationBatchView } from './image-generation-batch.js';

const nodeLabels = { VisualStyle: '画面风格', ImageGenerate: '图片生成', TextChat: '智能对话', ECommerceImageSet: '电商套图', ProductRetouch: '产品精修', ImageImport: '图片导入', ImagePreview: '图片预览', ImageResize: '缩放图片', ColorReset: '复位颜色', ImageCompare: '图片对比', ImageMerge: '多图合一', ImageSave: '保存节点', CameraControl: '视角控制' };
const dockWidthKeys = new Map([
    ['ECommerceImageSet', 'cainflow_ecommerce_image_set_dock_width'],
    ['ProductRetouch', 'cainflow_product_retouch_dock_width']
]);
const dockMinWidth = 300;
const dockMaxWidth = 640;
const dockCompactWidth = 240;
const dockCanvasReserve = 240;
const dockNarrowCanvasReserve = 72;
// The desktop dock layout leaves 136px beside Agent's normal 320px minimum.
const dockAgentReserve = 456;
const dockWidthProperty = '--node-parameter-dock-width';
// Allow space for the prompt, a batch heading and expanded rows, and the footer.
const compactBatchHeight = 280;
const cameraFields = [['pitch', '俯仰角 Pitch'], ['yaw', '偏航角 Yaw'], ['distance', '距离 Distance'], ['fov', '视野角 FOV'], ['roll', '翻滚角 Roll']];
// Only ordinary empty states get onboarding copy. The media renderer owns
// loading, recovery and errors, including replacements of an existing element.
const emptyPreviewMessages = new Set(['无输入图片', '无输入视频', '运行后预览图片', '运行后显示图片',
    '运行后显示图片或视频', '运行后对比图片', '运行后查看合并图片', '等待上游图片', '等待图片输入',
    '等待 B 输入', '等待 A / B 输入', '拖拽图片到此处', '输入 URL 后自动显示预览']);

/** A single editor presentation; the workflow and its original controls remain authoritative. */
export function createImageFirstCanvas({ state, selectionApi, documentRef, windowRef, storage,
    runCurrentNode, waitForNodeRun, cancelCommerceImageSet, removeCommerceScene, fitNode, onSettingsChanged = () => {}, bindPorts = () => {}, updateInputConnection, swapInputConnections, moveMergeInputConnection,
    panelManager = null, openModelSettings = () => {}, openResultPreview = () => {}, focusReferenceSource = () => {},
    openShotError = () => {}, openNodeFailureLog = () => false, openNodeRunError = null, openReferencePreview = null, bindReferencePrompt = null,
    uploadRetouchReference, referenceImageCatalog, pickCommerceStyleReference, onNativeClipboardWrite, readReferenceAsset }) {
    const views = new Map();
    const geometryClasses = new Set(['selected', 'is-interacting', 'connection-insert-candidate', 'connection-shake-armed',
        'is-virtualized', 'render-refresh']);
    const presentationClasses = value => (value || '').split(/\s+/).filter(name => name && !geometryClasses.has(name)).sort().join(' ');
    const surfaces = getSurfaceCoordinator(documentRef);
    const panel = documentRef.createElement('section');
    panel.id = 'image-parameter-panel';
    panel.className = 'image-parameter-panel';
    panel.setAttribute('aria-label', '节点参数浮层');
    panel.tabIndex = -1;
    panel.hidden = true;
    const toolIcon = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${name === 'close' ? '<path d="m6 6 12 12M6 18 18 6"/>' : name === 'restore' ? '<path d="M8 3v5H3m18 8h-5v5M8 8 3 3m13 13 5 5"/>' : '<path d="M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7"/>'}</svg>`;
    panel.innerHTML = `<header class="image-parameter-header"><h2 class="image-parameter-title"></h2><span class="image-parameter-drag-handle" tabindex="0" role="button" aria-label="拖动节点参数浮层" hidden><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></span><div class="image-parameter-tools"><button type="button" data-parameter-action="expand" aria-label="放大节点参数浮层" aria-pressed="false">${toolIcon('expand')}</button><button type="button" data-parameter-action="close" aria-label="关闭节点参数浮层">${toolIcon('close')}</button></div></header>
        <div class="image-parameter-scroll"></div><footer class="image-parameter-footer"><span class="image-parameter-feedback"></span><span class="image-parameter-count-slot" hidden></span><button type="button" class="save-btn" data-parameter-action="generate">生成</button></footer>
        <span class="image-parameter-resize" data-parameter-resize="width" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整节点参数浮层宽度"></span>
        <span class="image-parameter-resize-height" data-parameter-resize="height" tabindex="0" role="separator" aria-orientation="horizontal" aria-label="调整节点参数浮层高度" hidden></span>
        <span class="image-parameter-resize-corner" data-parameter-resize="both" tabindex="0" role="button" aria-label="调整节点参数浮层大小" hidden></span>`;
    const store = documentRef.createElement('div');
    store.hidden = true;
    store.className = 'image-parameter-store';
    documentRef.body.append(store, panel);
    const dock = documentRef.getElementById('main-layout') || documentRef.body;
    const agent = documentRef.getElementById('prompt-agent-panel');
    const canvasContainer = documentRef.getElementById('canvas-container');
    const header = panel.querySelector('.image-parameter-header');
    const scroll = panel.querySelector('.image-parameter-scroll');
    const targetContext = documentRef.createElement('div');
    targetContext.className = 'image-parameter-context';
    scroll.before(targetContext);
    const feedback = panel.querySelector('.image-parameter-feedback');
    const footer = panel.querySelector('.image-parameter-footer');
    const countSlot = panel.querySelector('.image-parameter-count-slot');
    const generate = panel.querySelector('[data-parameter-action="generate"]');
    const configuration = documentRef.createElement('div');
    configuration.className = 'image-parameter-configuration';
    configuration.hidden = true;
    configuration.innerHTML = '<span role="status"></span><button type="button" data-parameter-action="configure-model">配置生图模型</button>';
    const configurationMessage = configuration.querySelector('span');
    const configureModel = configuration.querySelector('button');
    scroll.append(configuration);
    configureModel.addEventListener('click', () => {
        if (!current) return;
        const issue = getNodeModelConfigurationIssue({ state, node: current, documentRef });
        openModelSettings({ ...issue?.target, onClose: () => { if (current) refreshNode(current.id); } });
    });
    const promptSizing = new WeakMap();
    const emptyPreviewContents = new WeakMap();
    const storedWidth = Number(storage?.getItem('cainflow_node_parameter_width'));
    let current = null, closed = null, preferredWidth = storedWidth >= 280 && storedWidth <= 960 ? storedWidth : null;
    const storedImportWidth = Number(storage?.getItem('cainflow_image_import_parameter_width'));
    let importPreferredWidth = storedImportWidth >= 280 && storedImportWidth <= 960 ? storedImportWidth : 280;
    const dockWidthPreferences = new Map();
    for (const [type, key] of dockWidthKeys) {
        const width = Number(storage?.getItem(key));
        if (width >= dockMinWidth && width <= dockMaxWidth) dockWidthPreferences.set(type, width);
    }
    const persistDockWidth = type => storage?.setItem(dockWidthKeys.get(type), String(dockWidthPreferences.get(type)));
    const currentWidthPreference = () => current?.type === 'ImageImport' ? importPreferredWidth
        : preferredWidth ?? (current?.type === 'ImageMerge' ? 440 : 560);
    const setWidthPreference = width => { if (current?.type === 'ImageImport') importPreferredWidth = width; else preferredWidth = width; };
    const persistWidthPreference = () => storage?.setItem(current?.type === 'ImageImport' ? 'cainflow_image_import_parameter_width' : 'cainflow_node_parameter_width', String(Math.round(currentWidthPreference())));
    let positionFrame = null, gesture = null, expanded = false, expandedRect = null, returnFocusElement = null;
    let ordinaryAnchor = null;
    let panLayout = null;
    let workflowSidebarMoving = false;
    let preserveOrdinaryAnchor = false;
    let deferredRetouchDock = null;
    const expandButton = panel.querySelector('[data-parameter-action="expand"]');
    const closeButton = panel.querySelector('[data-parameter-action="close"]');
    const dragHandle = panel.querySelector('.image-parameter-drag-handle');
    const widthHandle = panel.querySelector('[data-parameter-resize="width"]');
    const heightHandle = panel.querySelector('[data-parameter-resize="height"]');
    const cornerHandle = panel.querySelector('[data-parameter-resize="both"]');
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
    const isDocked = () => dockWidthKeys.has(current?.type);
    function dockWidthBounds() {
        const layoutWidth = Math.max(1, Math.floor(Math.min(dock.clientWidth || windowRef.innerWidth, windowRef.innerWidth)));
        // Keep a compact editor usable before increasing the canvas reserve in narrow windows.
        const agentBesideDock = windowRef.innerWidth > 800 && agent?.classList.contains('active') && !agent.hidden;
        const minimumCanvasReserve = Math.min(dockNarrowCanvasReserve, Math.floor(layoutWidth / 2));
        const canvasReserve = agentBesideDock ? dockAgentReserve
            : clamp(layoutWidth - dockCompactWidth, minimumCanvasReserve, dockCanvasReserve);
        const maximum = clamp(layoutWidth - canvasReserve, 1, dockMaxWidth);
        return { min: Math.min(dockMinWidth, maximum), max: maximum, layoutWidth };
    }
    function dockResizeBoundsChanged(previous, current) {
        return previous.layoutWidth !== current.layoutWidth || previous.min !== current.min || previous.max !== current.max;
    }
    function dockWidth(type, { min, max }) {
        const defaultWidth = clamp(windowRef.innerWidth * .34, dockMinWidth, 380);
        return Math.round(clamp(dockWidthPreferences.get(type) ?? defaultWidth, min, max));
    }
    function positionDock() {
        const bounds = dockWidthBounds();
        if (gesture?.dockType && dockResizeBoundsChanged(gesture.dockBounds, bounds)) {
            finishGesture(true);
            return;
        }
        const { min, max } = bounds;
        const width = dockWidth(current.type, bounds);
        const value = `${width}px`;
        if (documentRef.body.style.getPropertyValue(dockWidthProperty) !== value) documentRef.body.style.setProperty(dockWidthProperty, value);
        widthHandle.setAttribute('aria-valuemin', String(min));
        widthHandle.setAttribute('aria-valuemax', String(max));
        widthHandle.setAttribute('aria-valuenow', String(width));
        widthHandle.setAttribute('aria-valuetext', `${width} 像素`);
        widthHandle.setAttribute('aria-disabled', String(min === max));
    }
    const available = () => {
        const toolbar = documentRef.getElementById('toolbar');
        // Reserve the toolbar only while it is exposed; a collapsed, wrapping
        // toolbar must not consume the editor's usable height in small windows.
        const toolbarActive = toolbar && (documentRef.body.matches('.toolbar-pinned, .toolbar-peek-active')
            || toolbar.matches(':hover, :has(:focus-visible)')
            || toolbar.querySelector('details[open], .btn.active:not(#btn-prompt-agent), [aria-expanded="true"]:not(#btn-prompt-agent), #btn-stop:not([hidden])'));
        const top = toolbarActive
            ? Math.min(toolbar.offsetHeight + 12, Math.max(12, windowRef.innerHeight - 12)) : 12;
        const canvas = canvasContainer?.getBoundingClientRect();
        let left = Math.max(12, (canvas?.left || 0) + 12);
        const workflowPanel = documentRef.getElementById('workflow-sidebar');
        if (workflowPanel?.classList.contains('active') && !workflowPanel.hidden) {
            left = Math.max(left, workflowPanel.getBoundingClientRect().right + 12);
        }
        let right = Math.min(windowRef.innerWidth - 12, (canvas?.right || windowRef.innerWidth) - 12);
        const agentPanel = agent;
        if (agentPanel?.classList.contains('active') && !agentPanel.hidden) {
            const besideAgent = Math.min(right, agentPanel.getBoundingClientRect().left - 12);
            // Narrow windows overlap; a visible edge lets either editor be clicked
            // to the front without squeezing its controls into a strip.
            right = besideAgent - left >= 280 ? besideAgent : windowRef.innerWidth - 12;
        }
        // Keep the screen-space editor usable when sidebars or a scrolled
        // layout leave less canvas visible than its minimum control width.
        if (right - left < Math.min(280, windowRef.innerWidth - 24)) {
            left = 12;
            right = windowRef.innerWidth - 12;
        }
        right = Math.max(left + 1, right);
        // Canvas navigation must not cover the
        // parameter footer, especially in short/narrow viewports.
        let bottom = windowRef.innerHeight - 12;
        for (const control of [documentRef.getElementById('canvas-navigation')]) {
            if (!control?.getClientRects().length) continue;
            const area = control.getBoundingClientRect();
            if (area.right > left && area.left < right) bottom = Math.min(bottom, area.top - 8);
        }
        // In narrow windows the horizontal navigation docks below Agent.
        // Keep its raised composer reachable when parameters are in front.
        if (agentPanel?.classList.contains('active') && agentPanel.classList.contains('needs-navigation-space') && !agentPanel.hidden) {
            const composer = documentRef.getElementById('prompt-agent-form')?.getBoundingClientRect();
            if (composer && composer.right > left && composer.left < right) bottom = Math.min(bottom, composer.top - 8);
        }
        bottom = Math.max(top + 1, bottom);
        return { left, right, bottom, width: right - left, height: Math.max(1, bottom - top), top };
    };
    function updateMode() {
        const docked = isDocked();
        const canExpand = !docked && !['ImageImport', 'ImageSave', 'CameraControl'].includes(current?.type);
        if (!canExpand) { expanded = false; expandedRect = null; }
        expandButton.hidden = expandButton.disabled = !canExpand;
        panel.classList.toggle('is-expanded', expanded);
        panel.classList.toggle('is-docked', docked);
        panel.dataset.mode = docked ? 'docked' : expanded ? 'expanded' : 'normal';
        const parent = docked ? dock : documentRef.body;
        if (panel.parentNode !== parent) parent.append(panel);
        widthHandle.setAttribute('aria-label', docked ? `调整${nodeLabels[current.type]}参数宽度` : '调整节点参数浮层宽度');
        if (docked) widthHandle.setAttribute('aria-controls', panel.id);
        else {
            for (const attribute of ['aria-controls', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-disabled']) widthHandle.removeAttribute(attribute);
            documentRef.body.style.removeProperty(dockWidthProperty);
        }
        closeButton.setAttribute('aria-label', docked ? `关闭${nodeLabels[current.type]}参数` : '关闭节点参数浮层');
        if (docked) {
            for (const property of ['left', 'top', 'width', 'height', 'min-width', 'max-height']) panel.style.removeProperty(property);
        }
        expandButton.setAttribute('aria-label', expanded ? '还原节点参数浮层' : '放大节点参数浮层');
        expandButton.setAttribute('aria-pressed', String(expanded));
        expandButton.innerHTML = toolIcon(expanded ? 'restore' : 'expand');
        dragHandle.hidden = heightHandle.hidden = cornerHandle.hidden = !expanded;
        if (header.parentNode !== panel) panel.prepend(header);
    }
    function setReturnFocus(node, candidate = documentRef.activeElement) {
        if (candidate?.isConnected && !panel.contains(candidate) && !candidate.closest?.('.image-parameter-store')
            && (node.el.contains(candidate))
            && candidate.matches?.('button,input,textarea,select,a[href],[tabindex]')) returnFocusElement = candidate;
        else { node.el.setAttribute('tabindex', '-1'); returnFocusElement = node.el; }
    }

    function sizePrompt() {
        if (windowRef.CSS?.supports('field-sizing', 'content')) return;
        const prompt = current?.parameterRoot?.querySelector('.image-generate-prompt');
        if (!prompt?.getClientRects().length) return;
        let sizing = promptSizing.get(prompt);
        if (!sizing) {
            sizing = { key: '' };
            promptSizing.set(prompt, sizing);
        }
        const key = `${panel.style.width}\n${prompt.value}`;
        if (sizing.key === key) return;
        sizing.key = key;
        const style = windowRef.getComputedStyle(prompt);
        const line = Number.parseFloat(style.lineHeight) || 21;
        const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        const border = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
        // Collapse before measuring: height:auto retains the textarea's rows
        // intrinsic height and would prevent shrinking to two lines.
        prompt.style.height = '0px';
        const height = Math.min(line * 6 + padding + border,
            Math.max(line * 2 + padding + border, prompt.scrollHeight + border));
        prompt.style.height = `${Math.ceil(height)}px`;
        prompt.style.overflowY = prompt.scrollHeight > prompt.clientHeight ? 'auto' : 'hidden';
    }

    function position({ rememberPanLayout = false } = {}) {
        panLayout = null;
        // Keep the action under the pointer until the native button press ends.
        if (generate.matches(':active')) {
            schedulePosition();
            return;
        }
        positionPanel(rememberPanLayout);
        positionSettingsPopup();
    }
    function positionSettingsPopup() {
        const view = views.get(current);
        const popup = view?.settingsPopup;
        if (!popup?.matches(':popover-open')) return;
        const rect = footer.getBoundingClientRect();
        const bottom = Math.min(rect.top - 6, windowRef.innerHeight - 12);
        const width = view.group === 'more' ? Math.min(400, panel.offsetWidth) : panel.offsetWidth - 24;
        popup.style.width = `${Math.max(0, Math.min(width, windowRef.innerWidth - 24))}px`;
        popup.style.maxHeight = `${Math.max(0, bottom - 12)}px`;
        const anchorLeft = view.group === 'more'
            ? view.groupButtons.get('more').getBoundingClientRect().right - popup.offsetWidth
            : rect.left + 12;
        popup.style.left = `${clamp(anchorLeft, 12, Math.max(12, windowRef.innerWidth - popup.offsetWidth - 12))}px`;
        popup.style.top = `${Math.max(12, bottom - popup.offsetHeight)}px`;
    }
    function anchorGeometry(rect, bounds, preferredTop) {
        return [rect.left, rect.top, rect.width, rect.height, bounds.left, bounds.top, bounds.right, bounds.bottom, preferredTop];
    }
    function ordinaryPanelLeft(rect, bounds, width) {
        return clamp(rect.left + rect.width / 2 - width / 2, bounds.left, Math.max(bounds.left, bounds.right - width));
    }
    function placeOrdinaryPanel(left, preferredTop, bounds, height, geometry, hasCancel) {
        // Follow below the card and stay at the bottom boundary instead of flipping above it.
        const top = clamp(preferredTop, bounds.top, Math.max(bounds.top, bounds.bottom - height));
        if (panel.style.left !== `${left}px`) panel.style.left = `${left}px`;
        if (panel.style.top !== `${top}px`) panel.style.top = `${top}px`;
        ordinaryAnchor = { node: current, geometry, hasCancel, left, top, maxHeight: bounds.height };
    }
    function positionPanel(rememberPanLayout) {
        if (panel.hidden || !current?.el?.isConnected) return;
        const name = current.customTitle || current.el.dataset.nodeTitle || nodeLabels[current.type] || current.type;
        const panelTitle = panel.querySelector('.image-parameter-title');
        setText(panelTitle, name);
        panelTitle.title = name;
        if (panel.dataset.mode === 'docked') {
            positionDock();
            return;
        }
        setText(targetContext, `当前编辑：${name}`);
        const scrollTop = scroll.scrollTop;
        const rect = current.el.getBoundingClientRect();
        const bounds = available();
        const batch = views.get(current)?.batch?.element;
        if (batch) {
            const batchParent = bounds.height < compactBatchHeight ? scroll : panel;
            if (batch.parentNode !== batchParent) {
                const active = documentRef.activeElement;
                batchParent.insertBefore(batch, batchParent === panel ? footer : null);
                if (batch.contains(active)) active.focus({ preventScroll: true });
            }
        }
        panel.style.maxHeight = `${bounds.height}px`;
        panel.style.minWidth = `${Math.min(280, bounds.width)}px`;
        if (expanded) {
            ordinaryAnchor = null;
            if (!expandedRect) {
                const width = Math.min(860, bounds.width);
                const height = Math.min(680, bounds.height, Math.max(160, windowRef.innerHeight - bounds.top * 2));
                expandedRect = { left: bounds.left + (bounds.width - width) / 2, top: (windowRef.innerHeight - height) / 2, width, height };
            }
            const width = Math.min(expandedRect.width, bounds.width), height = Math.min(expandedRect.height, bounds.height);
            panel.style.setProperty('--image-parameter-available-height', `${bounds.height}px`);
            panel.style.width = `${width}px`; panel.style.height = `${height}px`;
            panel.style.left = `${clamp(expandedRect.left, bounds.left, Math.max(bounds.left, bounds.right - width))}px`;
            panel.style.top = `${clamp(expandedRect.top, bounds.top, Math.max(bounds.top, bounds.bottom - height))}px`;
            heightHandle.setAttribute('aria-valuenow', String(Math.round(height)));
            widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
            sizePrompt();
            scroll.scrollTop = scrollTop;
            return;
        }
        const compactImport = current.type === 'ImageImport' && panel.dataset.importMode === 'upload';
        const modeWidth = current.parameterRoot.querySelector('.image-import-mode-shell')?.offsetWidth || 112;
        const desiredWidth = current.type === 'CameraControl' ? 300 : compactImport ? modeWidth + 72 : currentWidthPreference();
        // Position with the same minimum width that CSS actually renders.
        const width = Math.min(Math.max(desiredWidth, Math.min(280, bounds.width)), bounds.width);
        panel.style.width = `${width}px`;
        panel.style.height = '';
        const floatingBottoms = ['.image-result-actions', '.node-run-cancel-btn']
            .map(selector => current.el.querySelector(selector)).filter(element => element?.getClientRects().length)
            .map(element => element.getBoundingClientRect().bottom + 12);
        const preferredTop = Math.max(rect.bottom + 12, ...floatingBottoms);
        const hasCancel = !!current.el.querySelector('.node-run-cancel-btn')?.getClientRects().length;
        // Ordinary edits keep controls under the pointer. Explicit disclosure
        // changes release this anchor so the new content can use the viewport.
        const geometry = anchorGeometry(rect, bounds, preferredTop);
        // A measured rectangle may round a translated edge to a slightly different subpixel.
        if (preserveOrdinaryAnchor && ordinaryAnchor?.node === current && ordinaryAnchor.hasCancel === hasCancel &&
            geometry.every((value, index) => Math.abs(value - ordinaryAnchor.geometry[index]) < 0.02)) {
            panel.style.left = `${clamp(ordinaryAnchor.left, bounds.left, Math.max(bounds.left, bounds.right - width))}px`;
            panel.style.top = `${ordinaryAnchor.top}px`;
            panel.style.maxHeight = `${Math.max(1, Math.min(ordinaryAnchor.maxHeight, bounds.bottom - ordinaryAnchor.top))}px`;
            widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
            sizePrompt();
            scroll.scrollTop = scrollTop;
            return;
        }
        preserveOrdinaryAnchor = false;
        const left = ordinaryPanelLeft(rect, bounds, width);
        panel.style.left = `${left}px`;
        panel.style.top = `${preferredTop}px`;
        widthHandle.setAttribute('aria-valuenow', String(Math.round(width)));
        sizePrompt();
        const height = panel.getBoundingClientRect().height;
        placeOrdinaryPanel(left, preferredTop, bounds, height, geometry, hasCancel);
        // Some locate actions scroll the viewport natively. That offset can also
        // clamp as the transform changes, so keep measuring while it is nonzero.
        if (rememberPanLayout && state.canvas && !canvasContainer?.scrollLeft && !canvasContainer?.scrollTop) {
            const { x, y, zoom } = state.canvas;
            panLayout = { node: current, rect, bounds, preferredTop, hasCancel, width, height, x, y, zoom };
        }
        // Measuring at the viewport limit can temporarily remove overflow and
        // clamp the browser's scroll offset. Restore it after final layout.
        scroll.scrollTop = scrollTop;
    }
    function schedulePosition() {
        panLayout = null;
        if (positionFrame !== null || panel.hidden) return;
        positionFrame = windowRef.requestAnimationFrame(() => { positionFrame = null; position(); });
    }
    function positionDuringCanvasPan() {
        if (expanded || panel.hidden || isDocked() || !current?.el?.isConnected) return;
        const { x, y, zoom } = state.canvas || {};
        const canReuseLayout = !workflowSidebarMoving && !views.get(current)?.settingsPopup?.matches(':popover-open');
        if (!canReuseLayout || panLayout?.node !== current || panLayout.zoom !== zoom ||
            ![x, y, zoom].every(Number.isFinite)) {
            if (positionFrame !== null) {
                windowRef.cancelAnimationFrame(positionFrame);
                positionFrame = null;
            }
            position({ rememberPanLayout: canReuseLayout });
            return;
        }
        const { rect, bounds, width, height, hasCancel } = panLayout;
        const offsetX = x - panLayout.x, offsetY = y - panLayout.y;
        const translated = { left: rect.left + offsetX, top: rect.top + offsetY, width: rect.width, height: rect.height };
        const preferredTop = panLayout.preferredTop + offsetY;
        if (x !== panLayout.x || y !== panLayout.y) preserveOrdinaryAnchor = false;
        placeOrdinaryPanel(ordinaryPanelLeft(translated, bounds, width), preferredTop, bounds, height,
            anchorGeometry(translated, bounds, preferredTop), hasCancel);
    }
    function park() {
        ordinaryAnchor = null;
        panLayout = null;
        preserveOrdinaryAnchor = false;
        if (header.parentNode !== panel) panel.prepend(header);
        if (current?.parameterRoot) {
            const currentView = views.get(current);
            currentView?.settingsPopup?.hidePopover?.();
            if (currentView?.footerTools) current.parameterRoot.append(currentView.footerTools);
            if (currentView?.batch) current.parameterRoot.append(currentView.batch.element);
            const countField = currentView?.countField;
            if (countField) { current.parameterRoot.append(countField); countField.hidden = true; }
            panel.append(footer);
            store.append(current.parameterRoot);
        }
        current = null;
    }
    function close({ remember = true } = {}) {
        cancelDeferredRetouchDock();
        if (remember) closed = current;
        finishGesture(true); expanded = false; expandedRect = null;
        park();
        panel.hidden = true;
        updateMode();
        panel.setAttribute('aria-hidden', 'true'); panel.inert = true;
    }
    function remove(node) {
        const view = views.get(node);
        if (!view) return;
        if (deferredRetouchDock?.node === node) cancelDeferredRetouchDock();
        if (current === node) close({ remember: false });
        view.observer.disconnect();
        view.resizeObserver?.disconnect();
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
    function setGroup(node, group, { focus = false } = {}) {
        const view = views.get(node);
        if (!view) return;
        if (view.settingsPopup && group === 'reference') return;
        if (view.settingsPopup && group === 'advanced') group = 'more';
        if (view.settingsPopup?.matches(':popover-open')) surfaces?.closePopovers?.(panel);
        // A submenu entry selects a page; closing the popup must not turn the
        // next activation of that same page into an empty menu.
        view.group = view.settingsPopup ? group : view.group === group ? null : group;
        for (const section of view.sections) {
            section.hidden = section.dataset.parameterGroup !== view.group && !(view.settingsPopup && view.group === 'more' && section.dataset.parameterGroup === 'advanced');
            if (section.tagName === 'DETAILS') section.open = !section.hidden;
        }
        view.form.querySelectorAll('[data-parameter-group-toggle]').forEach(button => {
            button.setAttribute('aria-expanded', String(button.dataset.parameterGroupToggle === view.group));
        });
        for (const [name, button] of view.groupButtons || []) button.setAttribute('aria-expanded', String(name === view.group));
        if (view.settingsPopup && current === node) {
            view.settingsPopup.setAttribute('aria-label', group === 'model' ? '模型与供应商' : group === 'size' ? '宽高比与分辨率' : '更多设置');
            view.settingsPopup.showPopover();
            surfaces?.openPopover?.(view.settingsPopup.id, { element: view.settingsPopup, trigger: view.groupButtons.get(group), relatedTriggers: [...view.groupButtons.values()], owner: panel, close: () => view.settingsPopup.hidePopover() });
            positionSettingsPopup();
            if (focus) {
                const control = view.sections.filter(section => !section.hidden).flatMap(section => Array.from(section.querySelectorAll('button, input, select, textarea, [tabindex]')))
                    .find(element => !element.disabled && element.tabIndex >= 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
                (control || view.groupButtons.get(group))?.focus({ preventScroll: true });
            }
        }
        schedulePosition();
    }
    function setText(element, text) {
        if (element.textContent !== text) element.textContent = text;
    }
    function openEmptyAction(node, view, action) {
        if (state.nodes.get(node.id) !== node || views.get(node) !== view || !node.el.isConnected
            || node.enabled === false || node.isClone || state.runningNodeIds?.has(node.id)) return;
        if (action === 'file') {
            view.selectFile?.click();
            return;
        }
        select(node);
        if (action === 'model') {
            if (!configuration.hidden) configureModel.click();
        } else {
            const input = documentRef.getElementById(`${node.id}-${action === 'url' ? 'url-input' : 'prompt'}`);
            const focusTarget = action === 'prompt' && input?.readOnly
                ? view.form.querySelector('.image-prompt-source summary')
                : input;
            focusTarget?.focus();
        }
    }
    function updateEmptyContent(element, node, view, name, message, action = '', actionText = '') {
        let content = emptyPreviewContents.get(element);
        if (content?.title.parentElement !== element) {
            const title = documentRef.createElement('span');
            title.className = 'image-first-empty-title';
            const detail = documentRef.createElement('span');
            detail.className = 'image-first-empty-detail';
            element.append(title, detail);
            content = { title, detail, action };
            emptyPreviewContents.set(element, content);
        }
        setText(content.title, name);
        setText(content.detail, message);
        if (content.detail.hidden === Boolean(message)) content.detail.hidden = !message;
        content.action = node.enabled === false || node.isClone ? '' : action;
        if (content.action && !content.button) {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.className = 'image-first-empty-action';
            button.addEventListener('mousedown', event => {
                if (!state.batchConnectionMode?.sourceNodeId) event.stopPropagation();
            });
            button.addEventListener('click', event => {
                event.stopPropagation();
                if (button.isConnected && !button.hidden && content.action) openEmptyAction(node, view, content.action);
            });
            element.append(button);
            content.button = button;
        }
        if (content.button) {
            if (content.button.hidden === Boolean(content.action)) content.button.hidden = !content.action;
            setText(content.button, actionText);
        }
    }
    function refreshMediaEmptyContent(node, view, name, previewMessage = '') {
        const placeholders = node.el.querySelectorAll('.preview-placeholder, .save-preview-placeholder, .drop-text');
        if (!placeholders.length) return;
        for (const element of placeholders) {
            const canonicalText = element.querySelector(':scope > .preview-placeholder-text');
            let source = canonicalText?.textContent.trim() || '';
            if (!canonicalText) {
                for (const child of element.childNodes) if (child.nodeType === 3) source += child.textContent;
                source = source.trim();
            }
            const ordinary = emptyPreviewMessages.has(source);
            element.classList.toggle('image-first-empty-name', ordinary);
            if (!ordinary) {
                const content = emptyPreviewContents.get(element);
                content?.title.remove();
                content?.detail.remove();
                content?.button?.remove();
                emptyPreviewContents.delete(element);
                continue;
            }
            // Legacy markup uses a bare text node. Give the media renderer its
            // canonical span so it can update it without touching our controls.
            if (!canonicalText) {
                const text = documentRef.createElement('span');
                text.className = 'preview-placeholder-text';
                text.textContent = source;
                for (const child of Array.from(element.childNodes)) if (child.nodeType === 3) child.remove();
                element.append(text);
            }
            let message = source, action = '', label = '';
            if (node.type === 'ImageImport') {
                const byUrl = source === '输入 URL 后自动显示预览';
                const retained = !byUrl && (node.imageImportAssetKey || node.data?.imageImportAssetKey || node.data?.mediaAssetKeys?.length);
                if (retained) {
                    message = node.data?.mediaIntegrity?.state === 'missing'
                        ? '已保存的图片暂不可用，请从媒体管理恢复' : '等待已保存图片的预览';
                } else {
                    message = byUrl ? '输入链接后预览图片' : '将图片拖到这里';
                    action = byUrl ? 'url' : 'file';
                    label = byUrl ? '输入图片链接' : '选择文件';
                }
            } else if (previewMessage) message = previewMessage;
            updateEmptyContent(element, node, view, name, message, action, label);
        }
    }
    function refreshGenerationEmptyContent(node, view, name, settings) {
        const empty = view.result.hidden;
        if (view.placeholder.hidden === empty) view.placeholder.hidden = !empty;
        if (!empty) return;
        const busy = node.isFailed || node.executionFailure || ['waiting', 'running', 'error'].includes(node.runStatus)
            || state.runningNodeIds?.has(node.id);
        if (busy || node.enabled === false || node.isClone) {
            updateEmptyContent(view.placeholder, node, view, name, '');
            return;
        }
        const issue = getNodeModelConfigurationIssue({ state, node, documentRef });
        if (issue) {
            updateEmptyContent(view.placeholder, node, view, name, issue.message, 'model', '配置生图模型');
        } else if (view.form.querySelector('.image-prompt-source.is-active')) {
            updateEmptyContent(view.placeholder, node, view, name, '使用上游已有提示词');
        } else if (!String(settings.prompt || '').trim()) {
            updateEmptyContent(view.placeholder, node, view, name, '', 'prompt', '填写提示词');
        } else {
            updateEmptyContent(view.placeholder, node, view, name, '打开节点参数以生成图片');
        }
    }
    function refreshNode(nodeId) {
        const node = state.nodes.get(nodeId), view = views.get(node);
        if (!view) return;
        if (view.runIndicator) {
            const status = projectImageCardRunStatus(node, state.runningNodeIds?.has(nodeId));
            const { runIndicator } = view;
            if (runIndicator.hidden !== !status) runIndicator.hidden = !status;
            if (status) {
                if (runIndicator.dataset.status !== status.status) runIndicator.dataset.status = status.status;
                setText(runIndicator, status.label);
            }
        }
        let mergeSourceCount = 0, mergeHasEnabledSource = false, mergeFeedback = '';
        node.refreshVisualStyle?.();
        view.commerce?.refresh();
        view.retouch?.refresh();
        if (view.referenceDetails) {
            view.referenceDetails.hidden = !state.connections.some(edge => edge.to.nodeId === nodeId && edge.to.port === REFERENCE_IMAGES_PORT);
        }
        const name = node.el.dataset.nodeTitle || node.customTitle || nodeLabels[node.type];
        if (view.chatEmptyTitle) setText(view.chatEmptyTitle, name);
        if (node.type !== 'ImagePreview') refreshMediaEmptyContent(node, view, name);
        if (node.type === 'ImageGenerate') {
            const settings = readImageGenerationSettings(node, documentRef);
            refreshGenerationEmptyContent(node, view, name, settings);
            const model = state.models.find(item => item.id === settings.apiConfigId);
            const provider = getResolvedProviderForModel(model, state.providers, settings.providerId);
            const automaticLabel = value => !value || value === 'auto' ? '自动' : value;
            const resolutionLabel = settings.resolution === 'custom'
                ? `${settings.customWidth || '自动'} × ${settings.customHeight || '自动'}`
                : automaticLabel(settings.resolution);
            const sizeSummary = `${automaticLabel(settings.aspect)} · ${resolutionLabel}`;
            if (view.settingsEntry) {
                setText(view.settingsEntry.querySelector('.image-parameter-entry-label'), sizeSummary);
                view.settingsEntry.title = `比例与分辨率：${sizeSummary}`;
                view.settingsEntry.setAttribute('aria-label', view.settingsEntry.title);
            }
            for (const [group, button] of view.groupButtons || []) {
                if (group === 'size') continue;
                if (group === 'more') {
                    button.title = '更多设置：质量、背景、内容审核与高级参数';
                    continue;
                }
                const text = group === 'model' ? [model?.name || model?.modelId || '选择模型', provider?.name].filter(Boolean).join(' · ')
                    : group === 'size' ? sizeSummary
                        : '更多设置';
                setText(button.querySelector('.image-parameter-entry-label') || button, text);
                button.setAttribute('aria-label', group === 'model' ? `模型与供应商：${text}` : text);
                if (button.title !== text) button.title = text;
            }
            renderImageNodeRunState(node);
        } else if (node.type === 'ImageImport') {
            const mode = documentRef.getElementById(`${node.id}-import-mode`)?.value || node.importMode || 'upload';
            if (view.urlFields.hidden !== (mode !== 'url')) view.urlFields.hidden = mode !== 'url';
            view.urlFields.classList.toggle('hidden', mode !== 'url');
            setText(view.model, mode === 'url' ? 'URL 来源' : '本地素材');
        } else if (node.type === 'ImagePreview') {
            const { count } = projectImageOutput(node, getCanonicalImageList(node));
            const index = getCanonicalImageIndex(node, new Array(count));
            setText(view.model, `${nodeLabels[node.type]}${count ? ` · ${index + 1} / ${count}` : ''}`);
            let inputCount = 0, hasSource = false, hasEnabledSource = false;
            for (const edge of state.connections) {
                if (edge.to.nodeId !== node.id) continue;
                inputCount++;
                if (hasEnabledSource || edge.to.port !== 'image') continue;
                const source = state.nodes.get(edge.from.nodeId);
                if (source) {
                    hasSource = true;
                    hasEnabledSource = source.enabled !== false;
                }
            }
            setText(view.references, `输入 ${inputCount}`);
            refreshMediaEmptyContent(node, view, name, hasEnabledSource ? '等待上游图片'
                : hasSource ? '启用上游节点以更新预览' : '从上游图片节点拖线连接');
        } else if (node.type === 'ImageMerge' && current === node) {
            const { count } = projectImageOutput(node, getCanonicalImageList(node));
            const { mergeState, mergeMessage } = node.el.querySelector('.image-merge-preview')?.dataset || {};
            const imageConnections = state.connections.filter(edge => edge.to.nodeId === node.id && /^image_\d+$/.test(edge.to.port));
            mergeSourceCount = imageConnections.length;
            mergeHasEnabledSource = imageConnections.some(edge => {
                const source = state.nodes.get(edge.from.nodeId);
                return source && source.enabled !== false;
            });
            if (mergeMessage && mergeMessage !== '等待图片输入') mergeFeedback = mergeMessage;
            else if (count && mergeState === 'current') mergeFeedback = `输出 ${count} 张`;
            else if (mergeSourceCount) mergeFeedback = mergeHasEnabledSource ? '等待来源输出' : '没有可用的图片来源';
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
            setText(view.cameraPrompt, node.data?.cameraPrompt || node.data?.text || '');
        }
        view.inputs?.refresh();
        if (current === node) {
            panel.dataset.importMode = node.type === 'ImageImport'
                ? (view.urlFields.hidden ? 'upload' : 'url') : '';
            widthHandle.hidden = node.type === 'ImageImport' && panel.dataset.importMode === 'upload';
            const running = state.runningNodeIds?.has(node.id) || ['waiting', 'running'].includes(node.runStatus) || node.el.classList.contains('running');
            const isChat = node.type === 'TextChat';
            const generationCount = node.type === 'ImageGenerate' ? readImageGenerationSettings(node, documentRef).generationCount : 1;
            generate.hidden = ['ImageImport', 'ImageSave'].includes(node.type) || dockWidthKeys.has(node.type)
                || (node.type === 'ImageMerge' && !mergeSourceCount)
                || (node.type === 'VisualStyle' && !hasVisualStyleReference(state, node.id));
            setText(generate, node.type === 'ImagePreview' ? (running ? '更新中' : '更新预览')
                : node.type === 'ImageCompare' ? (running ? '更新中' : '更新对比')
                : node.type === 'ImageMerge' ? (running ? '合并中' : '更新合并')
                : node.type === 'ImageSave' ? (running ? '更新中' : '更新媒体')
                : node.type === 'VisualStyle' ? (running ? '提取中…' : '提取风格')
                : node.type === 'CameraControl' ? '编辑视角'
                : isChat ? '生成回复'
                : node.type === 'ImageResize' ? (running ? '处理中' : '处理图片')
                    : node.type === 'ColorReset' ? (running ? '调色中' : '应用调色') : (generationCount > 1 ? `生成 ×${generationCount}` : '生成'));
            const issue = node.type === 'ImageGenerate' || (isChat && !node.isClone)
                ? getNodeModelConfigurationIssue({ state, node, documentRef }) : null;
            if (view.batch) {
                const { hasRequests, allFailed } = view.batch.refresh({ running, blocked: !!issue || running || node.enabled === false || node.isClone === true });
                view.form.classList.toggle('has-image-batch', hasRequests);
                view.form.classList.toggle('has-failed-image-batch', allFailed);
            }
            configuration.hidden = !issue;
            setText(configurationMessage, issue?.message || '');
            setText(configureModel, isChat ? '配置对话模型' : '配置生图模型');
            generate.disabled = !!issue || running || node.enabled === false
                || (isChat && node.isClone === true)
                || (node.type === 'VisualStyle' && (state.isRunning || state.runningNodeIds?.size > 0 || node.isClone))
                || (node.type === 'ImageMerge' && !mergeHasEnabledSource)
                || (node.type === 'CameraControl' && (node.isClone || view.cameraOpen?.disabled));
            setText(feedback, node.type === 'ImageImport' ? '在卡片选择文件，或切换 URL 输入链接。'
                : node.type === 'ImagePreview' ? (node.previewInputState === 'stale' ? '未更新 · 当前无输入' : node.previewInputState === 'empty' ? '当前无输入' : '预览当前连接的图片')
                    : node.type === 'ImageCompare' ? node.el.querySelector('.image-compare-container')?.dataset.compareMessage || 'B 为必需输入；A 可选，移动指针调整分界。'
                    : node.type === 'ImageMerge' ? mergeFeedback
                    : node.type === 'ImageSave' ? node.el.querySelector('.save-preview-container')?.dataset.saveMessage || '修改文件名后，使用卡片上的保存按钮保存媒体。'
                    : node.type === 'CameraControl' ? '在独立编辑器调整相机；参数即时保存，输出为相机提示词。'
                    : node.type === 'ImageResize' || node.type === 'ColorReset' ? '修改即时预览；点击按钮执行当前节点。'
                    : documentRef.getElementById(`${node.id}-run-status`)?.textContent || '修改不会自动生成');
            const passiveFeedback = ['修改不会自动生成', '待运行', '已完成', '当前无输入', '预览当前连接的图片',
                'B 为必需输入；A 可选，移动指针调整分界。',
                '修改文件名后，使用卡片上的保存按钮保存媒体。', '在独立编辑器调整相机；参数即时保存，输出为相机提示词。',
                '修改即时预览；点击按钮执行当前节点。'];
            const hasFeedback = node.type !== 'VisualStyle' && node.type !== 'ImageGenerate' && node.type !== 'ProductRetouch'
                && !!feedback.textContent && !passiveFeedback.includes(feedback.textContent);
            feedback.hidden = !hasFeedback;
            panel.dataset.hasFeedback = String(hasFeedback);
            footer.hidden = node.type === 'ImageImport' || (generate.hidden && !hasFeedback && ['ImageSave', 'ImageMerge', 'VisualStyle'].includes(node.type));
            schedulePosition();
        }
    }
    function open(node, group) {
        if (!views.has(node) || state.nodes.get(node.id) !== node) return;
        cancelDeferredRetouchDock();
        sweep();
        if (current !== node) { finishGesture(true); setReturnFocus(node); park(); }
        panelManager?.beforeOpen?.('parameters');
        current = node; closed = null;
        updateMode();
        if (node.parameterRoot.parentNode !== scroll) scroll.insertBefore(node.parameterRoot, configuration);
        if (footer.parentNode !== panel) panel.append(footer);
        const view = views.get(node);
        countSlot.hidden = !view.countField;
        if (view.countField) {
            if (view.countField.parentNode !== countSlot) countSlot.append(view.countField);
            view.countField.hidden = false;
        }
        if (view.footerTools) {
            footer.insertBefore(view.footerTools, generate);
        }
        footer.insertBefore(countSlot, generate);
        panel.dataset.nodeType = node.type;
        if (node.type === 'ImageMerge') feedback.setAttribute('role', 'status');
        else feedback.removeAttribute('role');
        panel.hidden = false;
        panel.setAttribute('aria-hidden', 'false'); panel.inert = false;
        panel.dataset.nodeId = node.id;
        panel.setAttribute('aria-label', `${node.el.dataset.nodeTitle || node.customTitle || nodeLabels[node.type]} · ${isDocked() ? '节点参数' : '节点参数浮层'}`);
        if (group) { const view = views.get(node); if (view.group !== group || view.settingsPopup && !view.settingsPopup.matches(':popover-open')) setGroup(node, group); }
        refreshNode(node.id);
        position();
        surfaces?.bringToFront?.(panel);
    }
    function selectOnly(node) {
        if (!state.selectedNodes.has(node.id) || state.selectedNodes.size !== 1) selectionApi.setSelection([node.id]);
    }
    function select(node, group) {
        selectOnly(node);
        open(node, group);
    }
    function openNodeSettings(nodeId, action) {
        const node = state.nodes.get(nodeId);
        if (!views.has(node)) return false;
        select(node);
        let target;
        if (node.type === 'ECommerceImageSet') {
            if (action === 'plan' || action === 'fill') {
                target = footer.querySelector(`[data-commerce-action="${action}"]`);
            } else if (action === 'confirm') {
                target = footer.querySelector('[data-commerce-action="fill"]:enabled:not([hidden])');
            } else if (action === 'configure') {
                const models = node.parameterRoot.querySelector('details.node-model-settings');
                if (models) {
                    models.closest('.commerce-image-set-configuration').open = true;
                    models.open = true;
                }
                target = models?.querySelector('summary');
            }
        }
        if (target && !target.disabled && target.checkVisibility()) target.focus();
        else panel.focus({ preventScroll: true });
        return true;
    }
    function cancelDeferredRetouchDock() {
        if (!deferredRetouchDock) return;
        windowRef.clearTimeout(deferredRetouchDock.timer);
        deferredRetouchDock = null;
    }
    function openDeferredRetouchDock(node) {
        if (deferredRetouchDock?.node !== node) return;
        cancelDeferredRetouchDock();
        if (state.dragging || state.marquee || state.nodes.get(node.id) !== node || !node.el.isConnected
            || state.selectedNodes.size !== 1 || !state.selectedNodes.has(node.id) || surfaces?.topModal?.()) return;
        open(node);
    }
    function deferRetouchDock(node) {
        cancelDeferredRetouchDock();
        // Let the next pointer click hit the same image before the new dock covers it.
        const timer = windowRef.setTimeout(() => openDeferredRetouchDock(node), 650);
        deferredRetouchDock = { node, timer };
        selectOnly(node);
    }
    let selectionFrame = null;
    let selectionAllowsOpen = true;
    function selectionChanged() {
        // Capture the selection's intent before coalescing: a marquee may
        // already have ended by the time this frame runs.
        selectionAllowsOpen = !state.marquee;
        if (selectionFrame !== null) return;
        selectionFrame = windowRef.requestAnimationFrame(() => {
            selectionFrame = null;
            // Pointer down establishes the drag after updating selection.
            // Completed movement cancels this pending automatic opening below.
            if (state.dragging) { selectionChanged(); return; }
            // Right-click may select a node to target its menu. Opening the
            // parameter panel in that frame would dismiss the menu.
            const contextMenu = documentRef.getElementById('context-menu');
            const contextMenuOpen = contextMenu && !contextMenu.classList.contains('hidden');
            refreshSelection({ allowOpen: selectionAllowsOpen && !state.marquee && !contextMenuOpen });
        });
    }
    documentRef.addEventListener('cainflow:node-drag-ended', () => {
        cancelDeferredRetouchDock();
        if (selectionFrame !== null) windowRef.cancelAnimationFrame(selectionFrame);
        selectionFrame = null;
        refreshSelection({ allowOpen: false });
    });
    function refreshSelection({ allowOpen = true } = {}) {
        sweep();
        const ids = Array.from(state.selectedNodes);
        const node = ids.length === 1 ? state.nodes.get(ids[0]) : null;
        if (deferredRetouchDock) {
            if (allowOpen && deferredRetouchDock.node === node) return;
            cancelDeferredRetouchDock();
        }
        if (!node || !views.has(node)) { close({ remember: false }); closed = null; return; }
        if (!allowOpen) {
            if (current !== node) close({ remember: false });
            return;
        }
        if (current === node && !panel.hidden) {
            refreshNode(node.id);
            return;
        }
        if (closed !== node) open(node);
    }
    function installUniversalInput(node) {
        const inputSection = node.el.querySelector('.node-inputs-section');
        if (inputSection) {
            let universal = inputSection.querySelector('.universal-input');
            for (const port of inputSection.querySelectorAll('.node-port[data-direction="input"]')) {
                if (port === universal || hasDedicatedInputPort(node, port.dataset.port)) continue;
                port.hidden = true;
                port.classList.add('image-first-canonical-input');
            }
            if (!universal) {
                universal = documentRef.createElement('div');
                universal.className = 'node-port input universal-input';
                universal.dataset.nodeId = node.id; universal.dataset.port = 'auto';
                universal.dataset.type = 'any'; universal.dataset.direction = 'input';
                universal.innerHTML = '<div class="port-dot type-any"></div><span class="port-label">输入</span>';
                inputSection.prepend(universal);
            }
            bindPorts(inputSection);
        }
    }
    function registerView(node, view, observed) {
        const { form } = view;
        if (node.type !== 'ImageImport') {
            const indicator = documentRef.createElement('button');
            indicator.type = 'button';
            indicator.className = 'node-card-run-status';
            indicator.hidden = true;
            indicator.dataset.nodeReadAction = '';
            indicator.title = '查看本轮运行详情';
            indicator.setAttribute('aria-controls', panel.id);
            indicator.addEventListener('mousedown', event => {
                if (!state.batchConnectionMode?.sourceNodeId) event.stopPropagation();
            });
            indicator.addEventListener('click', event => {
                event.stopPropagation();
                if (state.nodes.get(node.id) !== node || indicator.hidden) return;
                select(node);
                if (view.batch?.focusDetails()) return;
                const target = panel.querySelector('[data-image-run-action="details"]:enabled:not([hidden]), [data-retouch-action="error"]:enabled:not([hidden]), [data-commerce-action="error-detail"]:enabled:not([hidden])')
                    || (indicator.dataset.status === 'partial' ? footer.querySelector('[data-commerce-action="fill"]:enabled:not([hidden])') : null);
                if (target?.checkVisibility()) {
                    target.focus();
                } else if (indicator.dataset.status === 'error' && node.executionFailure?.message && openNodeRunError) {
                    openNodeRunError(node.el.dataset.nodeTitle || node.customTitle || nodeLabels[node.type] || node.type, node.executionFailure.message);
                } else panel.focus({ preventScroll: true });
            });
            view.runIndicator = indicator;
            node.el.append(indicator);
        }
        if (windowRef.ResizeObserver) {
            view.resizeObserver = new windowRef.ResizeObserver(() => {
                if (current === node) schedulePosition();
            });
            view.resizeObserver.observe(node.el);
            view.resizeObserver.observe(form);
            if (view.settingsPopup) view.resizeObserver.observe(view.settingsPopup);
            if (view.batch) view.resizeObserver.observe(view.batch.element);
        }
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
                    if (record.attributeName === 'class' && presentationClasses(record.oldValue) === presentationClasses(node.el.className)) {
                        geometryChanged = true;
                        continue;
                    }
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
        observer.observe(node.el, { attributes: true, attributeOldValue: true, attributeFilter: ['style','class','data-node-title'] });
        view.observer = observer;
        views.set(node, view); store.append(form);
        node.onImageFirstSelect = group => select(node, group);
        form.addEventListener('mousedown', event => event.stopPropagation());
        const updateFromForm = event => {
            // The commerce editor handles these fields together with its draft and results.
            if (view.commerce && event.target.matches('[data-commerce-art-direction], [data-commerce-shot-field]')) return;
            refreshNode(node.id);
            onSettingsChanged(node.id);
        };
        form.addEventListener('input', updateFromForm);
        form.addEventListener('change', updateFromForm);
        form.addEventListener('toggle', event => {
            if (current !== node) return;
            // Explicit disclosure changes need a fresh content-height measurement.
            // Keep the editing anchor only for ordinary inputs, not collapsed geometry.
            if (event.target.matches('details')) preserveOrdinaryAnchor = false;
            schedulePosition();
        }, true);
        form.addEventListener('pointerup', () => { if (current === node) schedulePosition(); });
        let resizePress = false;
        node.el.addEventListener('mousedown', event => {
            resizePress = !!event.target.closest('.node-resize-handle');
        }, true);
        const retouchPreview = node.type === 'ProductRetouch' ? node.el.querySelector('.product-retouch-card-preview') : null;
        const isRetouchPreviewPointer = event => retouchPreview?.contains(event.target) && event.detail > 0 && event.button === 0
            && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (retouchPreview) node.el.addEventListener('dblclick', event => {
            if (isRetouchPreviewPointer(event)) openDeferredRetouchDock(node);
        }, true);
        node.el.addEventListener('click', event => {
            if (event.target.closest('.node-resize-handle') || (resizePress && event.detail > 0)) return;
            if (event.target.closest('.color-reset-preview.is-picking,.image-compare-divider')) return;
            if (node.type === 'TextChat' && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
                || event.target.closest('.chat-response-area a[href]'))) return;
            if (isRetouchPreviewPointer(event)) {
                if (deferredRetouchDock?.node === node && event.detail > 1) return;
                if (event.detail === 1 && (current !== node || panel.hidden)) {
                    const boundary = dock.getBoundingClientRect().right - dockWidth(node.type, dockWidthBounds());
                    if (event.clientX >= boundary) { deferRetouchDock(node); return; }
                }
            }
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
        let summary = null, model = null, inputs = null, references = null, urlFields = null, cameraOpen = null, cameraPrompt = null, selectFile = null;
        let promptDisclosure = null;
        if (node.type !== 'ImageMerge') {
            summary = documentRef.createElement('div'); summary.className = 'image-first-summary';
            model = documentRef.createElement('span'); summary.append(model);
        }
        node.el.classList.add('image-first-media');
        if (node.type === 'ImageImport') {
            const mode = body.querySelector('.image-import-mode-shell');
            const modeInput = body.querySelector(`[id="${node.id}-import-mode"]`);
            if (mode) form.append(mode);
            if (modeInput) form.append(modeInput);
            selectFile = body.querySelector(`[id="${node.id}-select-btn"]`);
            const resolution = body.querySelector(`[id="${node.id}-res"]`);
            const source = documentRef.createElement('div');
            source.className = 'image-import-source-settings';
            if (selectFile) source.append(selectFile);
            const urlSection = body.querySelector(`[id="${node.id}-url-section"]`);
            urlFields = documentRef.createElement('div'); urlFields.className = 'image-import-url-fields';
            urlFields.dataset.imageImportMode = 'url';
            for (const element of Array.from(urlSection?.children || [])) {
                if (!element.classList.contains('file-drop-zone')) urlFields.append(element);
            }
            source.append(urlFields);
            if (resolution) source.append(resolution);
            form.append(source);
            observed.push(body.querySelector(`[id="${node.id}-upload-section"]`), urlSection);
        } else {
            if (node.type === 'CameraControl') {
                cameraOpen = body.querySelector(`[id="${node.id}-camera-open"]`);
                body.querySelector('.camera-control-note')?.remove();
                cameraPrompt = documentRef.createElement('output'); cameraPrompt.className = 'image-camera-prompt-summary';
                cameraPrompt.setAttribute('aria-label', '相机提示词（只读）'); cameraPrompt.tabIndex = 0;
                promptDisclosure = documentRef.createElement('details'); promptDisclosure.className = 'image-camera-prompt-details';
                const promptSummary = documentRef.createElement('summary'); promptSummary.textContent = '相机提示词（只读）';
                promptDisclosure.append(promptSummary, cameraPrompt);
            }
            installUniversalInput(node);
            inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, swapInputConnections, moveMergeInputConnection,
                openReferencePreview, onChange: () => refreshNode(node.id) });
            inputs.element.dataset.parameterGroup = 'input'; sections.push(inputs.element); form.append(inputs.element);
            if (summary && node.type !== 'CameraControl') {
                references = documentRef.createElement('button'); references.type = 'button';
                references.addEventListener('click', () => select(node, 'input')); summary.append(references);
            }
            const suffix = { ImageCompare: 'compare', ImageMerge: 'merge-preview', ImageSave: 'save-preview', CameraControl: 'camera-preview' }[node.type] || 'preview';
            observed.push(body.querySelector(`[id="${node.id}-${suffix}"]`));
        }
        if (summary) {
            if (['ImageImport', 'ImageSave', 'CameraControl'].includes(node.type)) form.append(summary);
            else body.append(summary);
        }
        if (promptDisclosure) form.append(promptDisclosure);
        if (node.type === 'ImageSave') {
            const tools = body.querySelector('.image-save-preview-tools');
            if (tools) form.append(tools);
            const settings = documentRef.createElement('section');
            settings.className = 'node-parameter-section image-save-settings';
            const heading = documentRef.createElement('h3');
            heading.className = 'node-parameter-heading'; heading.id = `${node.id}-save-settings-heading`; heading.textContent = '保存设置';
            settings.setAttribute('aria-labelledby', heading.id);
            settings.append(heading);
            const warning = body.querySelector(`[id="${node.id}-path-warning"]`);
            const filename = body.querySelector(`[id="${node.id}-filename"]`)?.closest('.node-field');
            if (filename) settings.append(filename);
            if (warning) settings.append(warning);
            form.append(settings);
            const actions = body.querySelector('.save-btn-group');
            if (actions) form.append(actions);
        }
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, model, references, inputs, urlFields, cameraOpen, cameraPrompt, selectFile,
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
        if (node.type === 'ColorReset') {
            const reset = controls.querySelector('.color-reset-toolbar');
            if (reset) controls.append(reset);
        }
        controls.dataset.parameterGroup = 'settings';
        form.append(controls);
        installUniversalInput(node);
        const inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, onChange: () => refreshNode(node.id) });
        inputs.element.dataset.parameterGroup = 'input'; inputs.element.hidden = true;
        form.append(inputs.element);
        const bar = documentRef.createElement('div'); bar.className = 'image-parameter-setting-bar';
        for (const [name, label] of [['settings', node.type === 'ImageResize' ? '缩放设置' : '颜色设置'], ['input', '输入']]) {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
            button.dataset.nodeReadAction = 'true'; button.dataset.parameterGroupToggle = name; button.setAttribute('aria-expanded', String(name === 'settings'));
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
    function installCommerce(node) {
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content';
        form.dataset.nodeId = node.id;
        installUniversalInput(node);
        const inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, onChange: () => refreshNode(node.id) });
        const references = documentRef.createElement('section');
        references.className = 'commerce-image-set-references';
        const referenceTitle = documentRef.createElement('h3');
        referenceTitle.className = 'node-parameter-heading';
        referenceTitle.textContent = '商品参考图';
        references.append(referenceTitle);
        const overview = node.el.querySelector('.image-reference-overview');
        if (overview) {
            overview.querySelector('.node-section-label')?.remove();
            references.append(overview);
        }
        const referenceDetails = documentRef.createElement('details');
        referenceDetails.className = 'commerce-image-set-reference-details';
        const referenceSummary = documentRef.createElement('summary');
        referenceSummary.textContent = '连接明细';
        referenceDetails.append(referenceSummary, inputs.element);
        references.append(referenceDetails);
        const commerce = createCommerceImageSetView({
            node, state, documentRef, openResultPreview, openShotError, bindReferencePrompt, readReferenceAsset, referenceImageCatalog, pickCommerceStyleReference,
            openModelSettings, focusReferenceSource, productReferences: references,
            connectReference: () => node.el.querySelector('.universal-input')?.click(),
            showReferenceDetails: () => {
                referenceDetails.closest('.commerce-image-set-configuration').open = true;
                referenceDetails.open = true;
                referenceSummary.focus({ preventScroll: true });
                referenceSummary.scrollIntoView({ block: 'nearest' });
            },
            run: (commerceAction, commerceShotId, { commerceCandidateKey, commerceCandidateCount, commerceDetailDirection } = {}) =>
                runCurrentNode(node.id, { commerceAction, commerceShotId, commerceCandidateKey, commerceCandidateCount, commerceDetailDirection }),
            cancel: commerceShotId => cancelCommerceImageSet(node.id, commerceShotId),
            removeScene: shotId => removeCommerceScene(node.id, shotId),
            onChange: change => onSettingsChanged(node.id, change)
        });
        (node.el._cleanupFns ||= []).push(commerce.destroy);
        form.append(commerce.element, commerce.actions);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections: [], inputs, commerce, referenceDetails,
            footerTools: commerce.actions }, []);
    }
    function installVisualStyle(node) {
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content';
        form.dataset.nodeId = node.id;
        form.append(node.el.querySelector('.visual-style-settings'));
        node.el.classList.add('image-first-media');
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections: [] }, []);
    }
    function installTextChat(node) {
        const body = node.el.querySelector('.node-body');
        const result = body.querySelector('.node-chat-result-section');
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content';
        form.dataset.nodeId = node.id;
        // Keep the original inputs, listeners and IDs when parking the form.
        form.append(...Array.from(body.children).filter(element => element !== result));
        const runFeedback = documentRef.createElement('div');
        runFeedback.className = 'image-parameter-run-feedback';
        runFeedback.append(node.el.querySelector('.node-failure-summary'));
        form.append(runFeedback);
        const answer = form.querySelector('.node-chat-answer-section');
        const heading = answer.querySelector('.node-parameter-heading');
        const disclosure = documentRef.createElement('details');
        disclosure.className = 'node-chat-answer-settings';
        const summary = documentRef.createElement('summary');
        summary.id = heading.id;
        summary.textContent = heading.textContent;
        heading.remove();
        answer.before(disclosure);
        disclosure.append(summary, answer);
        const parametersButton = documentRef.createElement('button');
        parametersButton.type = 'button';
        parametersButton.className = 'node-chat-parameter-button';
        parametersButton.dataset.nodeReadAction = '';
        parametersButton.title = '打开节点参数';
        parametersButton.setAttribute('aria-label', '打开智能对话参数');
        parametersButton.setAttribute('aria-controls', panel.id);
        const chatEmptyTitle = documentRef.createElement('span');
        chatEmptyTitle.className = 'image-first-empty-title';
        const parametersLabel = documentRef.createElement('span');
        parametersLabel.className = 'node-chat-parameter-label';
        parametersLabel.textContent = '参数';
        parametersButton.append(chatEmptyTitle, parametersLabel);
        result.querySelector('.node-chat-response-actions').prepend(parametersButton);
        parametersButton.addEventListener('click', () => {
            select(node);
            returnFocusElement = parametersButton;
            const prompt = documentRef.getElementById(`${node.id}-prompt`);
            (prompt.disabled ? panel : prompt).focus({ preventScroll: true });
        });
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections: [], chatEmptyTitle }, []);
    }
    function installProductRetouch(node) {
        const form = documentRef.createElement('div');
        form.className = 'node-body image-first-parameter-content';
        form.dataset.nodeId = node.id;
        installUniversalInput(node);
        const inputs = createImageInputDetail({ state, node, documentRef, updateInputConnection, openReferencePreview,
            onChange: () => refreshNode(node.id) });
        const retouch = createProductRetouchView({ node, state, documentRef, inputDetails: inputs.element,
            run: runCurrentNode, waitForNodeRun, uploadReference: uploadRetouchReference,
            openReferencePreview, openModelSettings, openNodeFailureLog, onNativeClipboardWrite });
        form.append(retouch.element, retouch.actions);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections: [], inputs, retouch,
            footerTools: retouch.actions }, []);
    }
    documentRef.addEventListener('cainflow:commerce-image-set-updated', event => {
        const nodeId = event.detail?.nodeId || event.target?.id;
        if (nodeId) refreshNode(nodeId);
    });
    function install(nodeId) {
        sweep();
        const node = state.nodes.get(nodeId);
        if (node?.type === 'TextChat' && !views.has(node)) { installTextChat(node); return; }
        if (!isImageFirstCardNode(node) || views.has(node)) return;
        if (node.type === 'ECommerceImageSet') { installCommerce(node); return; }
        if (node.type === 'ProductRetouch') { installProductRetouch(node); return; }
        if (node.type === 'VisualStyle') { installVisualStyle(node); return; }
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
        const referenceOverview = form.querySelector('.image-reference-overview');
        if (referenceOverview) {
            referenceOverview.querySelector('.node-section-label')?.remove();
            form.prepend(referenceOverview);
        }
        group(form.querySelector(':scope > .node-model-settings'), 'model');
        const countField = form.querySelector(`[id="${nodeId}-generation-count"]`)?.closest('.node-field');
        if (countField) {
            form.append(countField); countField.hidden = true;
            countField.classList.add('image-parameter-count-control');
            // Parking this field hides presentation, not the generation capability.
            countField.dataset.parameterGroup = 'count';
            const label = countField.querySelector('label');
            if (label) label.textContent = '次数';
        }
        group(form.querySelector(':scope > .node-parameter-grid'), 'size');
        const advanced = form.querySelector('.node-advanced-parameters');
        const quality = form.querySelector(`[id="${nodeId}-quality-field"]`);
        if (quality) advanced.querySelector('.image-parameter-output-options').prepend(quality);
        group(advanced, 'advanced');
        const groupButtons = new Map();
        for (const [name, label] of [['model','模型 / 供应商'],['size','尺寸'],['more','更多设置']]) {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
            button.dataset.nodeReadAction = 'true'; button.dataset.parameterGroupToggle = name; button.setAttribute('aria-expanded', 'false');
            button.addEventListener('click', event => {
                const view = views.get(node);
                if (view?.group === name && view.settingsPopup?.matches(':popover-open')) view.settingsPopup.hidePopover();
                else setGroup(node, name, { focus: event.detail === 0 });
            });
            groupButtons.set(name, button);
        }
        const promptField = form.querySelector('.image-node-prompt-field');
        const promptActions = promptField?.querySelector('.image-prompt-actions');
        promptActions?.remove();
        promptField?.querySelector('label')?.remove();
        promptField?.querySelector('textarea')?.setAttribute('aria-label', '提示词');
        const moreEntry = groupButtons.get('more');
        moreEntry.className = 'image-parameter-more-entry';
        moreEntry.setAttribute('aria-label', '更多设置');
        moreEntry.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
        const modelEntry = groupButtons.get('model');
        modelEntry.classList.add('image-parameter-model-entry');
        const modelLabel = documentRef.createElement('span');
        modelLabel.className = 'image-parameter-entry-label';
        modelLabel.textContent = modelEntry.textContent;
        modelEntry.replaceChildren(modelLabel);
        const settingsPopup = documentRef.createElement('div');
        settingsPopup.className = 'image-parameter-settings-popup';
        settingsPopup.id = `${node.id}-parameter-settings`;
        // The coordinator owns outside-click/Escape dismissal. Native auto
        // dismissal would close before the trigger's click handler can toggle.
        settingsPopup.setAttribute('popover', 'manual');
        settingsPopup.setAttribute('aria-label', '生成参数');
        settingsPopup.append(...sections);
        const settingsEntry = groupButtons.get('size');
        settingsEntry.className = 'image-parameter-settings-entry';
        settingsEntry.dataset.compactLabel = '尺寸';
        const settingsLabel = documentRef.createElement('span');
        settingsLabel.className = 'image-parameter-entry-label';
        settingsLabel.textContent = '尺寸';
        settingsEntry.replaceChildren(settingsLabel);
        for (const button of groupButtons.values()) button.setAttribute('aria-controls', settingsPopup.id);
        settingsPopup.addEventListener('toggle', () => {
            const visible = settingsPopup.matches(':popover-open');
            for (const [name, button] of groupButtons) button.setAttribute('aria-expanded', String(visible && views.get(node)?.group === name));
            if (!visible) surfaces?.forgetPopover?.(settingsPopup.id);
        });
        const footerTools = documentRef.createElement('div');
        footerTools.className = 'image-parameter-footer-tools';
        footerTools.append(settingsEntry, modelEntry, moreEntry);
        form.append(settingsPopup, footerTools);
        const placeholder = documentRef.createElement('div'); placeholder.className = 'image-first-placeholder';
        const runState = body.querySelector('.image-node-run-actions');
        const progress = body.querySelector('.node-generation-progress-field');
        if (runState && progress) runState.append(progress);
        const runFeedback = documentRef.createElement('div'); runFeedback.className = 'image-parameter-run-feedback';
        runFeedback.setAttribute('aria-label', '本轮生成状态');
        if (runState) runFeedback.append(runState);
        const failureSummary = node.el.querySelector('.node-failure-summary');
        if (failureSummary) runFeedback.append(failureSummary);
        const failureDetails = documentRef.createElement('button'); failureDetails.type = 'button';
        failureDetails.dataset.imageRunAction = 'details'; failureDetails.textContent = '查看详情'; failureDetails.hidden = true;
        failureDetails.addEventListener('click', event => { event.stopPropagation(); failureSummary?.click(); });
        runFeedback.append(failureDetails);
        const batch = createImageGenerationBatchView({
            node, documentRef,
            retryImage: (imageRetryIndex, imageRetryBatchId) => runCurrentNode(node.id, { imageRetryIndex, imageRetryBatchId }),
            openPreview: openResultPreview,
            openError: openShotError,
            openRunError: () => openNodeFailureLog(node.id)
        });
        const cancel = node.el.querySelector('.node-run-cancel-btn');
        if (cancel) node.el.append(cancel);
        const fullError = body.querySelector(`[id="${nodeId}-error"]`);
        if (fullError) { fullError.tabIndex = 0; fullError.setAttribute('aria-label', '完整运行错误'); form.append(fullError); }
        body.append(placeholder, result);
        form.append(runFeedback, batch.element);
        registerView(node, { form, fragment: documentRef.createDocumentFragment(), sections, placeholder, result, countField, groupButtons, settingsPopup, settingsEntry, footerTools, batch, group: null }, [result, progress]);
    }
    updateMode();
    for (const type of ['input', 'change']) countSlot.addEventListener(type, () => {
        if (current) { refreshNode(current.id); onSettingsChanged(current.id); }
    });
    surfaces?.registerModeless?.(panel, { close: () => close(), isOpen: () => !panel.hidden, opener: () => returnFocusElement });
    panelManager?.registerAuxiliary?.('parameters', { close: () => close({ remember: false }) });
    closeButton.addEventListener('click', () => {
        if (surfaces?.closeModeless) surfaces.closeModeless(panel); else close();
    });
    expandButton.addEventListener('click', () => {
        if (expandButton.disabled) return;
        finishGesture(true); expanded = !expanded; expandedRect = null; updateMode(); position(); surfaces?.bringToFront?.(panel);
    });
    const toolbar = documentRef.getElementById('toolbar');
    if (toolbar) {
        for (const event of ['focusin', 'focusout', 'pointerenter', 'pointerleave', 'transitionend']) toolbar.addEventListener(event, schedulePosition);
        new windowRef.MutationObserver(schedulePosition).observe(toolbar, { attributes: true, subtree: true, attributeFilter: ['class', 'aria-expanded', 'open', 'hidden'] });
        new windowRef.MutationObserver(schedulePosition).observe(documentRef.body, { attributes: true, attributeFilter: ['class'] });
    }
    function sidebarChanged() {
        schedulePosition();
        documentRef.dispatchEvent(new windowRef.Event('cainflow:canvas-sidebar-changed'));
    }
    const workflowSidebar = documentRef.getElementById('workflow-sidebar');
    for (const sidebar of [agent, workflowSidebar]) {
        if (!sidebar) continue;
        new windowRef.MutationObserver(sidebarChanged).observe(sidebar, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
        if (windowRef.ResizeObserver) new windowRef.ResizeObserver(sidebarChanged).observe(sidebar);
        sidebar.addEventListener('transitionend', sidebarChanged);
    }
    // The workflow drawer can slide without resizing or mutating another attribute.
    const trackWorkflowSidebar = event => {
        if (event.target !== workflowSidebar || event.propertyName !== 'left') return;
        workflowSidebarMoving = event.type === 'transitionrun';
        schedulePosition();
    };
    for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
        workflowSidebar?.addEventListener(type, trackWorkflowSidebar);
    }
    canvasContainer?.addEventListener('scroll', schedulePosition, { passive: true });
    if (windowRef.ResizeObserver) {
        const observePanelBounds = new windowRef.ResizeObserver(() => {
            if (!expanded && !isDocked()) schedulePosition();
        });
        for (const element of [panel, toolbar, canvasContainer,
            documentRef.getElementById('canvas-navigation'), documentRef.getElementById('prompt-agent-form')]) {
            if (element) observePanelBounds.observe(element);
        }
    }
    if (windowRef.ResizeObserver) new windowRef.ResizeObserver(() => {
        if (isDocked()) schedulePosition();
    }).observe(dock);
    generate.addEventListener('click', () => {
        if (!current) return;
        if (generate.disabled) return;
        if (current.type === 'VisualStyle') { void current.extractVisualStyle?.(); return; }
        if (current.type === 'CameraControl') { views.get(current)?.cameraOpen?.click(); return; }
        runCurrentNode(current.id);
    });
    panel.addEventListener('mousedown', event => event.stopPropagation());
    for (const type of ['pointerdown', 'click', 'keydown', 'input']) {
        panel.addEventListener(type, event => {
            // Freeze only while editing. Execution/result layout must finish
            // settling before it becomes the anchor for the next edit.
            preserveOrdinaryAnchor = !event.target.closest('[data-parameter-action], [data-parameter-resize], [data-image-batch-retry], [data-image-batch-toggle]');
        }, true);
    }
    function finishGesture(cancelled = false) {
        const previous = gesture;
        if (!previous) return;
        gesture = null; panel.classList.remove('is-dragging', 'is-resizing');
        if (cancelled || previous.dockType && (panel.closest('[inert]')
            || dockResizeBoundsChanged(previous.dockBounds, dockWidthBounds()))) {
            preferredWidth = previous.preferredWidth;
            importPreferredWidth = previous.importPreferredWidth;
            if (previous.dockType) dockWidthPreferences.set(previous.dockType, previous.dockPreferredWidth);
            expandedRect = previous.expandedRect;
        } else if (previous.changed && previous.dockType) {
            persistDockWidth(previous.dockType);
        } else if (!expanded && previous.changed) persistWidthPreference();
        if (previous.handle.hasPointerCapture?.(previous.id)) previous.handle.releasePointerCapture(previous.id);
        position();
    }
    for (const [handle, kind] of [[dragHandle, 'drag'], [widthHandle, 'width'], [heightHandle, 'height'], [cornerHandle, 'both']]) {
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || panel.hidden || handle.hidden || handle.getAttribute('aria-disabled') === 'true' || (!expanded && kind !== 'width')) return;
            event.preventDefault(); event.stopPropagation(); finishGesture(true);
            const rect = panel.getBoundingClientRect();
            const dockType = isDocked() ? current.type : null;
            gesture = { kind, id: event.pointerId, handle, x: event.clientX, y: event.clientY,
                rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                preferredWidth, importPreferredWidth, dockType, dockPreferredWidth: dockWidthPreferences.get(dockType),
                dockBounds: dockType ? dockWidthBounds() : null,
                expandedRect: expandedRect ? { ...expandedRect } : null, changed: false };
            panel.classList.add(kind === 'drag' ? 'is-dragging' : 'is-resizing'); handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('lostpointercapture', event => { if (gesture?.id === event.pointerId) finishGesture(true); });
        handle.addEventListener('keydown', event => {
            if (handle.hidden) return;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            if (!expanded && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); finishGesture(true);
            if (isDocked()) {
                const { min, max } = dockWidthBounds();
                const width = Math.round(panel.getBoundingClientRect().width);
                const step = event.key === 'ArrowLeft' ? 10 : -10;
                const requested = event.key === 'Home' ? min : event.key === 'End' ? max : width + step;
                const next = clamp(requested, min, max);
                if (next !== width) {
                    dockWidthPreferences.set(current.type, next);
                    persistDockWidth(current.type);
                    positionDock();
                }
                return;
            }
            const rect = panel.getBoundingClientRect(), bounds = available();
            const dx = event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
            const dy = event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0;
            if (!expanded) {
                setWidthPreference(clamp(event.key === 'Home' ? 280 : event.key === 'End' ? 960 : rect.width + dx, 280, 960));
                persistWidthPreference();
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
        const { rect, kind } = gesture, dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (gesture.dockType) {
            if (panel.closest('[inert]')) { finishGesture(true); return; }
            const { min, max } = dockWidthBounds();
            const startWidth = Math.round(rect.width);
            const next = clamp(Math.round(startWidth - dx), min, max);
            gesture.changed = next !== startWidth;
            dockWidthPreferences.set(gesture.dockType, gesture.changed ? next : gesture.dockPreferredWidth);
            positionDock();
            return;
        }
        const bounds = available();
        gesture.changed ||= Math.abs(dx) + Math.abs(dy) > 0;
        if (!expanded) setWidthPreference(clamp(rect.width + dx, 280, 960));
        else if (kind === 'drag') {
            expandedRect.left = clamp(rect.left + dx, 12, Math.max(12, windowRef.innerWidth - rect.width - 12));
            expandedRect.top = clamp(rect.top + dy, bounds.top, Math.max(bounds.top, windowRef.innerHeight - rect.height - 12));
        } else {
            if (kind !== 'height') expandedRect.width = clamp(rect.width + dx, Math.min(280, bounds.width), Math.max(1, windowRef.innerWidth - rect.left - 12));
            if (kind !== 'width') expandedRect.height = clamp(rect.height + dy, Math.min(160, bounds.height), Math.max(1, windowRef.innerHeight - rect.top - 12));
        }
        position();
    });
    windowRef.addEventListener('pointerup', event => {
        if (gesture?.id === event.pointerId) finishGesture();
    });
    windowRef.addEventListener('pointercancel', event => { if (gesture?.id === event.pointerId) finishGesture(true); });
    windowRef.addEventListener('blur', () => { cancelDeferredRetouchDock(); finishGesture(true); });
    windowRef.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        cancelDeferredRetouchDock();
        if (!gesture?.dockType) return;
        if (panel.closest('[inert]')) { finishGesture(true); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        finishGesture(true);
    }, true);
    documentRef.addEventListener('cainflow:canvas-transform', () => {
        if (!isDocked()) schedulePosition();
    });
    // The canvas transform has already been applied in this animation frame.
    documentRef.addEventListener('cainflow:canvas-pan-frame', positionDuringCanvasPan);
    windowRef.addEventListener('resize', () => { schedulePosition(); });
    return { install, selectionChanged, close, refreshNode, openNodeSettings,
        refreshSource: sourceId => {
            const targets = new Set(state.connections.filter(edge => edge.from.nodeId === sourceId).map(edge => edge.to.nodeId));
            targets.add(sourceId); targets.forEach(refreshNode);
        },
        refresh: () => { sweep(); for (const node of views.keys()) if (state.nodes.get(node.id) === node) refreshNode(node.id); } };
}
