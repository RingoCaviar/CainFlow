/**
 * 负责把节点 DOM 与交互行为绑定起来，包括拖拽、输入监听、按钮操作和端口事件。
 */
import {
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelProviders,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    normalizeImageResolutionForModel,
    validateOpenAiImageSize
} from '../features/execution/provider-request-utils.js';

export function createNodeDomBindingsApi({
    state,
    canvasContainer,
    connectionsGroup,
    tempConnection,
    viewportApi,
    getPortPosition,
    pushHistory,
    removeNode,
    selectNode,
    toggleNodesEnabled,
    finishConnection,
    setupImageImport,
    setupImageResize,
    setupImageSave,
    setupImagePreview,
    setupImageCompare,
    copyToClipboard,
    showToast,
    scheduleSave,
    debounce,
    adjustTextareaHeight,
    fitNodeToContent = () => {},
    documentRef = document
}) {
    const NODE_RESIZABLE_MEDIA_SELECTOR = '.file-drop-zone, .preview-container, .save-preview-container, .image-compare-container';
    const FALLBACK_DEFAULT_NODE_WIDTH = 180;
    const FALLBACK_DEFAULT_NODE_HEIGHT = 120;

    function syncTextNodeData(id) {
        const node = state.nodes.get(id);
        const textarea = documentRef.getElementById(`${id}-text`);
        if (!node || !textarea) return;
        node.data.text = textarea.value;
    }

    function getRememberedNodeDefault(type) {
        if (type !== 'ImageGenerate' && type !== 'TextChat') return null;
        if (!state.nodeDefaults || typeof state.nodeDefaults !== 'object') {
            state.nodeDefaults = {};
        }
        if (!state.nodeDefaults[type] || typeof state.nodeDefaults[type] !== 'object') {
            state.nodeDefaults[type] = { apiConfigId: '', providerId: '' };
        }
        return state.nodeDefaults[type];
    }

    function syncNodeProviderOptions(id, type) {
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        const providerField = documentRef.getElementById(`${id}-provider-field`);
        const node = state.nodes.get(id);
        if (!modelSelect) {
            return { model: null, providerId: '' };
        }

        const selectedModel = state.models.find((candidate) => candidate.id === modelSelect.value) || null;
        const modelProviders = getModelProviders(selectedModel, state.providers);
        const currentProviderId = providerSelect?.value || node?.providerId || '';
        const resolvedProviderId = getResolvedProviderIdForModel(selectedModel, state.providers, currentProviderId);

        if (providerSelect) {
            providerSelect.innerHTML = modelProviders.length > 0
                ? modelProviders.map((provider) => `<option value="${provider.id}">${provider.name || provider.id}</option>`).join('')
                : '<option value="">-- 暂无可用供应商 --</option>';
            providerSelect.value = resolvedProviderId;
        }
        if (providerField) {
            providerField.classList.toggle('hidden', modelProviders.length <= 1);
        }
        if (node) {
            node.providerId = resolvedProviderId;
        }

        return {
            model: selectedModel,
            providerId: resolvedProviderId
        };
    }

    function persistNodeModelSelection(id, type) {
        const defaults = getRememberedNodeDefault(type);
        if (!defaults) return;
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        defaults.apiConfigId = modelSelect?.value || '';
        defaults.providerId = providerSelect?.value || state.nodes.get(id)?.providerId || '';
    }

    function isNodeRunning(id) {
        return state.runningNodeIds?.has(id) || state.nodes.get(id)?.el?.classList.contains('running');
    }

    function blockRunningNodeMutation(id, event, message = '节点正在运行，暂不能修改') {
        if (!isNodeRunning(id)) return false;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        showToast(message, 'warning');
        return true;
    }

    function bindExpandableTextareaResize(nodeId, textarea) {
        if (!textarea || typeof ResizeObserver === 'undefined') return;

        let frameId = null;
        const scheduleFit = () => {
            if (state.resizing?.nodeId === nodeId) return;
            if (frameId !== null) return;
            frameId = requestAnimationFrame(() => {
                frameId = null;
                if (state.resizing?.nodeId === nodeId) return;
                fitNodeToContent(nodeId, { allowShrink: true });
            });
        };

        const observer = new ResizeObserver(() => scheduleFit());
        observer.observe(textarea);

        textarea.addEventListener('mouseup', scheduleFit);
        textarea.addEventListener('touchend', scheduleFit);

        if (!Array.isArray(textarea._cleanupFns)) {
            textarea._cleanupFns = [];
        }
        textarea._cleanupFns.push(() => {
            observer.disconnect();
            textarea.removeEventListener('mouseup', scheduleFit);
            textarea.removeEventListener('touchend', scheduleFit);
            if (frameId !== null) cancelAnimationFrame(frameId);
        });

        setTimeout(scheduleFit, 0);
    }

    function syncImageGenerateResolutionOptions(id) {
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        const resolutionSelect = documentRef.getElementById(`${id}-resolution`);
        if (!modelSelect || !resolutionSelect) return;

        const { model, providerId: selectedProviderId } = syncNodeProviderOptions(id, 'ImageGenerate');
        const provider = getResolvedProviderForModel(model, state.providers, selectedProviderId);
        const previousValue = resolutionSelect.value;
        const normalizedValue = normalizeImageResolutionForModel(previousValue, model, state.providers, selectedProviderId);
        const options = getImageResolutionOptionsForModel(model, state.providers, selectedProviderId);
        resolutionSelect.innerHTML = options
            .map((option) => `<option value="${option.value}">${option.label}</option>`)
            .join('');
        resolutionSelect.value = normalizedValue;
        const isOpenAiModel = getEffectiveProtocol(model, provider) === 'openai';
        updateImageGenerateAspectVisibility(id, isOpenAiModel);
        updateImageGenerateResolutionParamNote(id, isOpenAiModel);
        updateImageGenerateCustomResolutionVisibility(id);
    }

    function updateImageGenerateAspectVisibility(id, isOpenAiModel) {
        const aspectField = documentRef.getElementById(`${id}-aspect-field`);
        if (!aspectField) return;
        aspectField.classList.toggle('hidden', isOpenAiModel);
    }

    function updateImageGenerateResolutionParamNote(id, isOpenAiModel) {
        const note = documentRef.getElementById(`${id}-resolution-param-note`);
        if (!note) return;
        note.classList.toggle('hidden', !isOpenAiModel);
    }

    function updateImageGenerateCustomResolutionVisibility(id) {
        const resolutionSelect = documentRef.getElementById(`${id}-resolution`);
        const customField = documentRef.getElementById(`${id}-custom-resolution-field`);
        if (!resolutionSelect || !customField) return;
        customField.classList.toggle('hidden', resolutionSelect.value !== 'custom');
        updateImageGenerateCustomResolutionValidation(id);
    }

    function updateImageGenerateCustomResolutionValidation(id) {
        const resolutionSelect = documentRef.getElementById(`${id}-resolution`);
        const widthInput = documentRef.getElementById(`${id}-custom-resolution-width`);
        const heightInput = documentRef.getElementById(`${id}-custom-resolution-height`);
        const hint = documentRef.getElementById(`${id}-custom-resolution-hint`);
        if (!resolutionSelect || !widthInput || !heightInput || !hint) return true;

        if (resolutionSelect.value !== 'custom') {
            hint.textContent = '';
            hint.style.display = 'none';
            widthInput.classList.remove('invalid');
            heightInput.classList.remove('invalid');
            return true;
        }

        const result = validateOpenAiImageSize(widthInput.value, heightInput.value);
        const isValid = result.valid;
        hint.textContent = isValid ? '' : result.errors.join(' ');
        hint.style.display = isValid ? 'none' : 'block';
        widthInput.classList.toggle('invalid', !isValid);
        heightInput.classList.toggle('invalid', !isValid);
        return isValid;
    }

    function normalizeImageGenerateCountValue(value) {
        return Math.max(1, parseInt(value || '1', 10) || 1);
    }

    function syncImageGenerateCount(id) {
        const input = documentRef.getElementById(`${id}-generation-count`);
        if (!input) return;
        input.value = String(normalizeImageGenerateCountValue(input.value));
    }

    function getPx(style, name) {
        const value = parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) ? value : 0;
    }

    function getBoxExtras(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'padding-left') + getPx(style, 'padding-right') +
                getPx(style, 'border-left-width') + getPx(style, 'border-right-width');
        }
        return getPx(style, 'padding-top') + getPx(style, 'padding-bottom') +
            getPx(style, 'border-top-width') + getPx(style, 'border-bottom-width');
    }

    function getOuterExtras(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'margin-left') + getPx(style, 'margin-right');
        }
        return getPx(style, 'margin-top') + getPx(style, 'margin-bottom');
    }

    function getLayoutGap(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'column-gap') || getPx(style, 'gap') || 0;
        }
        return getPx(style, 'row-gap') || getPx(style, 'gap') || 0;
    }

    function isVisibleElement(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'collapse' && el.offsetParent !== null;
    }

    function isResizableMediaElement(el) {
        return Boolean(el?.matches?.(NODE_RESIZABLE_MEDIA_SELECTOR));
    }

    function measureTextWidth(text, font) {
        if (!measureTextWidth.canvas) {
            measureTextWidth.canvas = documentRef.createElement('canvas');
        }
        const context = measureTextWidth.canvas.getContext('2d');
        if (!context) return String(text || '').length * 8;
        context.font = font;
        return context.measureText(String(text || '')).width;
    }

    function getControlContentWidth(control) {
        const style = getComputedStyle(control);
        const font = style.font || `${style.fontSize} ${style.fontFamily}`;
        const horizontalPadding = getPx(style, 'padding-left') + getPx(style, 'padding-right');
        const horizontalBorder = getPx(style, 'border-left-width') + getPx(style, 'border-right-width');
        const extraSelectSpace = control.tagName === 'SELECT' ? 14 : 0;
        const minWidth = getPx(style, 'min-width');

        if (control.tagName === 'SELECT') {
            const isModelSelect = control.id.endsWith('-apiconfig');
            const selectedOption = control.selectedOptions?.[0];
            const optionTextWidth = isModelSelect
                ? measureTextWidth(selectedOption?.textContent || control.value || '', font)
                : Array.from(control.options || []).reduce((max, option) => {
                    return Math.max(max, measureTextWidth(option.textContent || option.value || '', font));
                }, 0);
            const maxWidth = isModelSelect ? 236 : Infinity;
            return Math.ceil(Math.min(optionTextWidth + horizontalPadding + horizontalBorder + extraSelectSpace, maxWidth));
        }

        if (control.tagName === 'BUTTON') {
            const text = String(control.textContent || '').replace(/\s+/g, ' ').trim();
            const textWidth = text ? measureTextWidth(text, font) : 0;
            const children = Array.from(control.children).filter(isVisibleElement);
            const childrenWidth = children.reduce((total, child) => {
                return total + (child.getBoundingClientRect?.().width || child.offsetWidth || 0);
            }, 0);
            const gap = getLayoutGap(style, 'x') * Math.max(0, children.length + (text ? 1 : 0) - 1);
            return Math.ceil(Math.max(minWidth, textWidth + childrenWidth + gap + horizontalPadding + horizontalBorder));
        }

        if (control.tagName === 'TEXTAREA') {
            return Math.ceil(Math.max(minWidth, horizontalPadding + horizontalBorder + 32));
        }

        const text = control.value || control.placeholder || '';
        return Math.ceil(Math.max(minWidth, measureTextWidth(text, font) + horizontalPadding + horizontalBorder));
    }

    function getElementMinimumWidth(el) {
        if (!isVisibleElement(el)) return 0;
        const style = getComputedStyle(el);
        const minWidth = getPx(style, 'min-width');
        const marginX = getOuterExtras(style, 'x');

        if (isResizableMediaElement(el)) {
            return Math.ceil(minWidth + marginX);
        }

        if (el.matches?.('input, select, textarea, button')) {
            return Math.ceil(Math.max(minWidth, getControlContentWidth(el)) + marginX);
        }

        const children = Array.from(el.children).filter(isVisibleElement);
        if (!children.length) {
            return Math.ceil(minWidth + marginX);
        }

        const display = style.display || '';
        const flexDirection = style.flexDirection || 'row';
        const gap = getLayoutGap(style, 'x');
        const childWidths = children.map((child) => getElementMinimumWidth(child));
        const contentWidth = (display.includes('flex') && !flexDirection.startsWith('column')) ||
            display.includes('grid') ||
            el.classList.contains('save-btn-group') ||
            el.classList.contains('image-resize-mode-group')
            ? childWidths.reduce((total, width) => total + width, 0) + Math.max(0, childWidths.length - 1) * gap
            : Math.max(0, ...childWidths);

        return Math.ceil(Math.max(minWidth, contentWidth + getBoxExtras(style, 'x')) + marginX);
    }

    function getElementMinimumHeight(el) {
        if (!isVisibleElement(el)) return 0;
        const style = getComputedStyle(el);
        const minHeight = getPx(style, 'min-height');
        const marginY = getOuterExtras(style, 'y');

        if (isResizableMediaElement(el)) {
            return Math.ceil(minHeight + marginY);
        }

        if (el.matches?.('input, select, textarea, button')) {
            return Math.ceil(Math.max(minHeight, el.offsetHeight || 0) + marginY);
        }

        const children = Array.from(el.children).filter(isVisibleElement);
        if (!children.length) {
            return Math.ceil(Math.max(minHeight, el.offsetHeight || 0) + marginY);
        }

        const display = style.display || '';
        const flexDirection = style.flexDirection || 'row';
        const gap = getLayoutGap(style, 'y');
        const childHeights = children.map((child) => getElementMinimumHeight(child));
        const contentHeight = (display.includes('flex') && !flexDirection.startsWith('column')) ||
            display.includes('grid') ||
            el.classList.contains('save-btn-group') ||
            el.classList.contains('image-resize-mode-group')
            ? Math.max(0, ...childHeights)
            : childHeights.reduce((total, height) => total + height, 0) + Math.max(0, childHeights.length - 1) * gap;

        return Math.ceil(Math.max(minHeight, contentHeight + getBoxExtras(style, 'y')) + marginY);
    }

    function getFlexContentWidth(container) {
        if (!container) return 0;
        const style = getComputedStyle(container);
        const gap = getPx(style, 'column-gap') || getPx(style, 'gap') || 0;
        const children = Array.from(container.children).filter((child) => child.offsetParent !== null);
        const contentWidth = children.reduce((total, child) => {
            const childStyle = getComputedStyle(child);
            const marginX = getPx(childStyle, 'margin-left') + getPx(childStyle, 'margin-right');
            const childWidth = child.classList.contains('node-title')
                ? Math.min(child.scrollWidth || child.offsetWidth || 0, 96)
                : (child.offsetWidth || child.scrollWidth || 0);
            return total + Math.ceil(childWidth + marginX);
        }, 0);
        return contentWidth + Math.max(0, children.length - 1) * gap;
    }

    function getHeaderMinimumWidth(header, fallbackWidth) {
        if (!header) return fallbackWidth;
        const style = getComputedStyle(header);
        const paddingX = getPx(style, 'padding-left') + getPx(style, 'padding-right');
        const leftWidth = getFlexContentWidth(header.querySelector('.header-left'));
        const rightWidth = getFlexContentWidth(header.querySelector('.header-right'));
        const headerGap = getPx(style, 'column-gap') || getPx(style, 'gap') || 12;
        return Math.ceil(paddingX + leftWidth + rightWidth + headerGap);
    }

    function getNodeMinimumSize(el, headerFallbackWidth) {
        const header = el.querySelector('.node-header');
        const body = el.querySelector('.node-body');
        const bodyStyle = body ? getComputedStyle(body) : null;
        const bodyPaddingX = bodyStyle ? getPx(bodyStyle, 'padding-left') + getPx(bodyStyle, 'padding-right') : 0;
        const bodyPaddingY = bodyStyle ? getPx(bodyStyle, 'padding-top') + getPx(bodyStyle, 'padding-bottom') : 0;
        const headerWidth = getHeaderMinimumWidth(header, headerFallbackWidth);
        const headerHeight = header ? Math.ceil(header.getBoundingClientRect().height) : 0;
        const isCompactTextNode = el.classList.contains('node-text');
        const baseMinWidth = isCompactTextNode ? 120 : 180;
        const baseMinHeight = isCompactTextNode ? 88 : 120;
        let minContentWidth = 0;
        let minBodyHeight = bodyPaddingY;
        let minBodyViewportHeight = 0;

        el.querySelectorAll('.node-port .port-label').forEach((label) => {
            const port = label.closest('.node-port');
            const dot = port?.querySelector('.port-dot');
            const portStyle = port ? getComputedStyle(port) : null;
            const gap = portStyle ? getPx(portStyle, 'column-gap') || getPx(portStyle, 'gap') : 6;
            minContentWidth = Math.max(
                minContentWidth,
                Math.ceil(label.scrollWidth + (dot?.offsetWidth || 14) + gap)
            );
        });

        el.querySelectorAll('.node-field').forEach((field) => {
            const fieldStyle = getComputedStyle(field);
            const fieldGap = getPx(fieldStyle, 'row-gap') || getPx(fieldStyle, 'gap');
            let fieldMinWidth = 0;
            let fieldMinHeight = 0;

            field.querySelectorAll(':scope > label').forEach((label) => {
                fieldMinWidth = Math.max(fieldMinWidth, label.scrollWidth);
                fieldMinHeight += label.offsetHeight;
            });

            field.querySelectorAll('input, select, textarea, .toggle-switch, .generation-count-control, .chat-response-wrapper, .text-display-box').forEach((control) => {
                if (control.closest('.node-field') !== field) return;
                if (control.matches('input, select, textarea')) {
                    fieldMinWidth = Math.max(fieldMinWidth, getControlContentWidth(control));
                } else {
                    fieldMinWidth = Math.max(fieldMinWidth, control.scrollWidth || control.offsetWidth);
                }

                const controlStyle = getComputedStyle(control);
                const minHeight = getPx(controlStyle, 'min-height');
                fieldMinHeight += field.classList.contains('node-field-expand')
                    ? minHeight
                    : Math.max(minHeight, control.offsetHeight || 0);
            });

            if (field.classList.contains('node-field-row')) {
                const label = field.querySelector(':scope > label');
                const switchEl = field.querySelector('.toggle-switch');
                const gap = getPx(fieldStyle, 'column-gap') || getPx(fieldStyle, 'gap') || 12;
                fieldMinWidth = Math.max(fieldMinWidth, (label?.scrollWidth || 0) + (switchEl?.offsetWidth || 0) + gap);
                fieldMinHeight = Math.max(label?.offsetHeight || 0, switchEl?.offsetHeight || 0);
            }

            if (fieldMinWidth > 0) minContentWidth = Math.max(minContentWidth, Math.ceil(fieldMinWidth));
        });

        if (body) {
            Array.from(body.children).forEach((child) => {
                if (!isVisibleElement(child)) return;
                minContentWidth = Math.max(minContentWidth, getElementMinimumWidth(child));

                if (child.classList.contains('node-field')) {
                    const childStyle = getComputedStyle(child);
                    const label = child.querySelector(':scope > label');
                    const control = child.querySelector(':scope > input, :scope > select, :scope > textarea, :scope > .generation-count-control, :scope > .chat-response-wrapper, :scope > .text-display-box');
                    const fieldGap = getPx(childStyle, 'row-gap') || getPx(childStyle, 'gap');
                    const controlStyle = control ? getComputedStyle(control) : null;
                    const controlMinHeight = controlStyle ? getPx(controlStyle, 'min-height') : 0;
                    const controlHeight = control
                        ? child.classList.contains('node-field-expand')
                            ? controlMinHeight
                            : Math.max(controlMinHeight, control.offsetHeight || 0)
                        : 0;
                    minBodyViewportHeight = Math.max(
                        minBodyViewportHeight,
                        (label?.offsetHeight || 0) + (label && control ? fieldGap : 0) + controlHeight
                    );
                    return;
                }

                minBodyViewportHeight = Math.max(minBodyViewportHeight, getElementMinimumHeight(child));
            });

            minBodyHeight += minBodyViewportHeight;
        }

        return {
            minWidth: Math.max(baseMinWidth, Math.ceil(headerWidth), Math.ceil(minContentWidth + bodyPaddingX)),
            minHeight: Math.max(baseMinHeight, Math.ceil(headerHeight + minBodyHeight))
        };
    }

    function getConfiguredDefaultSize(node, el, headerFallbackWidth) {
        const defaultWidth = Number(node?.defaultWidth);
        const defaultHeight = Number(node?.defaultHeight);
        const hasDefaultWidth = Number.isFinite(defaultWidth) && defaultWidth > 0;
        const hasDefaultHeight = Number.isFinite(defaultHeight) && defaultHeight > 0;

        if (hasDefaultWidth && hasDefaultHeight) {
            return {
                minWidth: defaultWidth,
                minHeight: defaultHeight
            };
        }

        const measuredMinimum = getNodeMinimumSize(el, headerFallbackWidth);
        return {
            minWidth: hasDefaultWidth
                ? defaultWidth
                : Math.max(FALLBACK_DEFAULT_NODE_WIDTH, measuredMinimum.minWidth),
            minHeight: hasDefaultHeight
                ? defaultHeight
                : Math.max(FALLBACK_DEFAULT_NODE_HEIGHT, measuredMinimum.minHeight)
        };
    }

    function bindNodeInteractions({ id, type, el }) {
        el.addEventListener('mousedown', (e) => {
            const target = e.target;

            if (target.closest('.node-delete, .node-bypass-btn')) return;

            const interactiveSelector = 'input, textarea, select, button, .port, .node-resize-handle, [contenteditable="true"], .chat-response-area, .preview-controls, .workflow-action-btn';
            const isInteractive = target.closest(interactiveSelector);

            const dragAreaSelector = '.file-drop-zone, .preview-container, .save-preview-container, .node-header, .node-glass-bg';
            const isForceDrag = target.matches(dragAreaSelector) || (target.parentElement && target.parentElement.matches(dragAreaSelector));

            if (isInteractive && !isForceDrag) return;

            canvasContainer.focus();

            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;

            e.preventDefault();
            e.stopPropagation();

            const isCloneDrag = e.ctrlKey || e.metaKey;
            if (isNodeRunning(id) && !isCloneDrag) {
                showToast('节点正在运行，暂不能移动；按住 Ctrl 可克隆运行中的节点', 'warning');
                return;
            }

            const pos = viewportApi.screenToCanvas(e.clientX, e.clientY);
            const isMulti = isCloneDrag;

            if (!state.selectedNodes.has(id)) {
                selectNode(id, isMulti);
            }

            const nodesToDrag = Array.from(state.selectedNodes);
            if (!isCloneDrag && nodesToDrag.some((nodeId) => isNodeRunning(nodeId))) {
                showToast('选区中有节点正在运行，暂不能移动', 'warning');
                return;
            }
            const startPositions = new Map();
            const draggedNodeIds = new Set(nodesToDrag);

            nodesToDrag.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) {
                    startPositions.set(nid, { x: node.x, y: node.y });
                    node.el.classList.add('is-interacting');
                }
            });

            const portOffsets = new Map();
            const connectionsToUpdate = [];

            for (const conn of state.connections) {
                const isFromDragged = draggedNodeIds.has(conn.from.nodeId);
                const isToDragged = draggedNodeIds.has(conn.to.nodeId);
                if (isFromDragged || isToDragged) {
                    const pathEl = connectionsGroup.querySelector(`path[data-conn-id="${conn.id}"]`);
                    if (pathEl) {
                        connectionsToUpdate.push({ conn, pathEl });
                        [{ p: conn.from, d: 'output' }, { p: conn.to, d: 'input' }].forEach((item) => {
                            const key = `${item.p.nodeId}-${item.p.port}-${item.d}`;
                            if (!portOffsets.has(key)) {
                                const pos = getPortPosition(item.p.nodeId, item.p.port, item.d);
                                const node = state.nodes.get(item.p.nodeId);
                                if (node) portOffsets.set(key, { dx: pos.x - node.x, dy: pos.y - node.y });
                            }
                        });
                    }
                }
            }

            state.dragging = {
                nodes: nodesToDrag,
                startX: pos.x,
                startY: pos.y,
                startPositions,
                portOffsets,
                connectionsToUpdate,
                isCloneDrag: e.ctrlKey || e.metaKey,
                cloned: false
            };

            pushHistory();
            documentRef.body.classList.add('is-interacting');
            documentRef.getElementById('connections-group').classList.add('is-interacting');
        });

        el.querySelector('.node-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能删除')) return;
            removeNode(id, { preserveConnections: e.altKey });
        });

        el.querySelector('.node-bypass-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能启用或禁用')) return;
            const nodesToUpdate = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
            toggleNodesEnabled(nodesToUpdate, id);
        });

        el.querySelector('.node-resize-handle').addEventListener('mousedown', (e) => {
            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;
            e.stopPropagation();
            e.preventDefault();
            if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能调整大小')) return;
            const header = el.querySelector('.node-header');
            const headerMinWidth = header ? Math.ceil(header.getBoundingClientRect().width) : 180;
            const node = state.nodes.get(id);
            const defaultMinimum = getConfiguredDefaultSize(node, el, headerMinWidth);

            state.resizing = {
                nodeId: id,
                startX: e.clientX,
                startY: e.clientY,
                startWidth: el.offsetWidth,
                startHeight: el.offsetHeight,
                minWidth: defaultMinimum.minWidth,
                minHeight: defaultMinimum.minHeight,
                maxHeight: node?.maxHeight || null
            };

            pushHistory();
            el.classList.add('is-interacting');
            documentRef.body.classList.add('is-interacting');
            documentRef.getElementById('connections-group').classList.add('is-interacting');
        });

        el.querySelectorAll('.node-port').forEach((portEl) => {
            const dot = portEl.querySelector('.port-dot');
            dot.addEventListener('mousedown', (e) => {
                const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
                if (isPanAction) return;
                e.stopPropagation();
                e.preventDefault();
                if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能修改连线')) return;

                const tgt = {
                    nodeId: portEl.dataset.nodeId,
                    port: portEl.dataset.port,
                    type: portEl.dataset.type,
                    dir: portEl.dataset.direction
                };

                if (state.connecting) {
                    if (finishConnection(state.connecting, tgt)) {
                        state.connecting = null;
                        tempConnection.setAttribute('d', '');
                    }
                    return;
                }

                const dotRect = dot.getBoundingClientRect();
                const containerRect = canvasContainer.getBoundingClientRect();
                const { x: cx, y: cy, zoom } = state.canvas;
                state.connecting = {
                    nodeId: portEl.dataset.nodeId,
                    portName: portEl.dataset.port,
                    dataType: portEl.dataset.type,
                    isOutput: portEl.dataset.direction === 'output',
                    startX: (dotRect.left + dotRect.width / 2 - containerRect.left - cx) / zoom,
                    startY: (dotRect.top + dotRect.height / 2 - containerRect.top - cy) / zoom,
                    screenX: e.clientX,
                    screenY: e.clientY,
                    dragged: false
                };
                documentRef.body.classList.add('is-interacting');
            });

            dot.addEventListener('mouseup', (e) => {
                if (!state.connecting) return;
                e.stopPropagation();
                if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能修改连线')) {
                    tempConnection.setAttribute('d', '');
                    state.connecting = null;
                    return;
                }

                const src = state.connecting;
                const tgt = {
                    nodeId: portEl.dataset.nodeId,
                    port: portEl.dataset.port,
                    type: portEl.dataset.type,
                    dir: portEl.dataset.direction
                };

                if (src.nodeId !== tgt.nodeId || src.portName !== tgt.port) {
                    if (finishConnection(src, tgt)) {
                        state.connecting = null;
                        tempConnection.setAttribute('d', '');
                    }
                } else if (src.dragged) {
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                }
            });
        });

        if (type === 'ImageImport') setupImageImport(id, el);
        else if (type === 'ImageGenerate') {
            syncImageGenerateResolutionOptions(id);
            const modelSelect = el.querySelector(`#${id}-apiconfig`);
            modelSelect?.addEventListener('change', () => {
                syncImageGenerateResolutionOptions(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id, { allowShrink: true });
            });
            const providerSelect = el.querySelector(`#${id}-provider`);
            providerSelect?.addEventListener('change', () => {
                syncImageGenerateResolutionOptions(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id, { allowShrink: true });
            });
            const resolutionSelect = el.querySelector(`#${id}-resolution`);
            resolutionSelect?.addEventListener('change', () => {
                updateImageGenerateCustomResolutionVisibility(id);
                fitNodeToContent(id, { allowShrink: true });
            });
            const customWidthInput = el.querySelector(`#${id}-custom-resolution-width`);
            const customHeightInput = el.querySelector(`#${id}-custom-resolution-height`);
            const syncCustomResolutionValidation = () => {
                updateImageGenerateCustomResolutionValidation(id);
                fitNodeToContent(id, { allowShrink: true });
            };
            customWidthInput?.addEventListener('input', syncCustomResolutionValidation);
            customHeightInput?.addEventListener('input', syncCustomResolutionValidation);
            updateImageGenerateCustomResolutionValidation(id);

            const generationCountInput = el.querySelector(`#${id}-generation-count`);
            const syncGenerationCount = () => syncImageGenerateCount(id);
            generationCountInput?.addEventListener('input', () => {
                if (generationCountInput.value !== '' && normalizeImageGenerateCountValue(generationCountInput.value) !== Number(generationCountInput.value)) {
                    syncImageGenerateCount(id);
                }
            });
            generationCountInput?.addEventListener('change', syncGenerationCount);
            generationCountInput?.addEventListener('blur', syncGenerationCount);
            el.querySelectorAll('.generation-count-btn').forEach((button) => {
                button.addEventListener('click', () => {
                    if (!generationCountInput) return;
                    const delta = parseInt(button.dataset.delta || '0', 10) || 0;
                    const nextValue = normalizeImageGenerateCountValue(generationCountInput.value) + delta;
                    generationCountInput.value = String(Math.max(1, nextValue));
                    generationCountInput.dispatchEvent(new Event('input', { bubbles: true }));
                    generationCountInput.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
            syncImageGenerateCount(id);
        }
        else if (type === 'ImageResize') setupImageResize(id, el);
        else if (type === 'ImageSave') setupImageSave(id, el);
        else if (type === 'ImagePreview') setupImagePreview(id, el);
        else if (type === 'ImageCompare') setupImageCompare(id, el);
        else if (type === 'TextChat') {
            syncNodeProviderOptions(id, type);
            const modelSelect = el.querySelector(`#${id}-apiconfig`);
            modelSelect?.addEventListener('change', () => {
                syncNodeProviderOptions(id, type);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id, { allowShrink: true });
            });
            const providerSelect = el.querySelector(`#${id}-provider`);
            providerSelect?.addEventListener('change', () => {
                syncNodeProviderOptions(id, type);
                persistNodeModelSelection(id, type);
            });
            const copyBtn = el.querySelector(`#${id}-copy-btn`);
            if (copyBtn) {
                copyBtn.onclick = () => {
                    const area = el.querySelector(`#${id}-response`);
                    if (area && !area.querySelector('.chat-response-placeholder')) {
                        copyToClipboard(area.innerText);
                    } else {
                        showToast('暂无内容可复制', 'warning');
                    }
                };
            }
        } else if (type === 'Text') {
            syncTextNodeData(id);
        }

        el.querySelectorAll('input, select, textarea').forEach((input) => {
            input.addEventListener('change', () => scheduleSave());
            input.addEventListener('input', debounce(() => scheduleSave(), 500));

            if (type === 'Text' && input.id === `${id}-text`) {
                input.addEventListener('input', () => syncTextNodeData(id));
                input.addEventListener('change', () => syncTextNodeData(id));
            }

            const isExpandable = input.closest('.node-field-expand');
            if (input.tagName === 'TEXTAREA' && !isExpandable) {
                input.addEventListener('input', () => adjustTextareaHeight(input));
                setTimeout(() => adjustTextareaHeight(input), 0);
            } else if (input.tagName === 'TEXTAREA' && isExpandable && type !== 'Text') {
                bindExpandableTextareaResize(id, input);
            }
        });
    }

    return {
        bindNodeInteractions
    };
}
