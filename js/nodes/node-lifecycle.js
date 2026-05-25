/**
 * 管理节点的创建、删除、选择、启停与尺寸自适应等生命周期行为。
 */
import { NODE_DEFAULT_TYPES } from '../core/state.js';
import { cleanupElementResources, splitTextForTextSplitNode } from '../core/common-utils.js';
import { getReferenceImageCount } from './reference-image-ports.js';

export function createNodeLifecycleApi({
    state,
    nodeConfigs,
    createNodeMarkup,
    nodesLayer,
    generateId,
    getImageAsset,
    getImageAssetList = async () => [],
    saveImageAsset,
    showResolutionBadge,
    restoreImageResizePreview,
    bindNodeInteractions,
    serializeOneNode = null,
    pushHistory,
    scheduleSave,
    showToast,
    updateAllConnections,
    updatePortStyles,
    onConnectionsChanged = () => {},
    getCacheSidebarActive,
    updateCacheUsage,
    documentRef = document
}) {
    const view = documentRef.defaultView || window;
    let pendingNodeSizeConnectionRefresh = null;
    const NODE_RESIZABLE_MEDIA_SELECTOR = '.file-drop-zone, .preview-container, .save-preview-container, .image-compare-container, .camera-control-node-preview';
    const NODE_SCROLL_CONTENT_SELECTOR = '.chat-response-area, .text-display-box, .node-error-msg';
    const NODE_SCROLLABLE_RESULT_SELECTOR = `${NODE_SCROLL_CONTENT_SELECTOR}, .text-split-preview`;
    const FALLBACK_DEFAULT_NODE_WIDTH = 180;
    const FALLBACK_DEFAULT_NODE_HEIGHT = 120;

    function scheduleNodeSizeConnectionRefresh() {
        if (pendingNodeSizeConnectionRefresh !== null) return;
        const requestFrame = view.requestAnimationFrame || ((callback) => view.setTimeout(callback, 16));
        pendingNodeSizeConnectionRefresh = requestFrame(() => {
            pendingNodeSizeConnectionRefresh = null;
            updateAllConnections();
        });
    }

    function readObservedNodeSize(entry, el) {
        const borderSize = Array.isArray(entry.borderBoxSize)
            ? entry.borderBoxSize[0]
            : entry.borderBoxSize;
        const width = borderSize?.inlineSize || el.offsetWidth || entry.contentRect?.width || 0;
        const height = borderSize?.blockSize || el.offsetHeight || entry.contentRect?.height || 0;
        return {
            width: Math.round(width),
            height: Math.round(height)
        };
    }

    function bindNodeSizeObserver(nodeData) {
        const ResizeObserverCtor = view.ResizeObserver;
        if (!ResizeObserverCtor || !nodeData?.el) return;

        nodeData.observedWidth = nodeData.el.offsetWidth || Number(nodeData.width) || 0;
        nodeData.observedHeight = nodeData.el.offsetHeight || Number(nodeData.height) || 0;

        const observer = new ResizeObserverCtor((entries) => {
            const entry = entries[0];
            if (!entry || !state.nodes.has(nodeData.id)) return;

            const { width, height } = readObservedNodeSize(entry, nodeData.el);
            const widthChanged = Math.abs(width - (nodeData.observedWidth || 0)) > 1;
            const heightChanged = Math.abs(height - (nodeData.observedHeight || 0)) > 1;
            if (!widthChanged && !heightChanged) return;

            nodeData.observedWidth = width;
            nodeData.observedHeight = height;
            if (width > 0) nodeData.width = width;
            if (height > 0) nodeData.height = height;
            scheduleNodeSizeConnectionRefresh();
        });

        try {
            observer.observe(nodeData.el, { box: 'border-box' });
        } catch {
            observer.observe(nodeData.el);
        }
        nodeData.sizeObserver = observer;
    }

    function disconnectNodeSizeObserver(nodeData) {
        if (nodeData?.sizeObserver) {
            nodeData.sizeObserver.disconnect();
            nodeData.sizeObserver = null;
        }
    }

    function isRemoteImageUrl(value) {
        return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function clampNodeHeight(height, config, options = {}) {
        if (!Number.isFinite(height) || height <= 0) return null;
        const { isRestore = false } = options;
        if (isRestore) {
            const restoreHeightCap = Number(config?.restoreHeightCap);
            if (Number.isFinite(restoreHeightCap) && restoreHeightCap > 0 && height > restoreHeightCap) {
                const restoreHeightFallback = Number(config?.restoreHeightFallback);
                if (Number.isFinite(restoreHeightFallback) && restoreHeightFallback > 0) {
                    return restoreHeightFallback;
                }
                return restoreHeightCap;
            }
        }
        const maxHeight = Number(config?.maxHeight);
        if (Number.isFinite(maxHeight) && maxHeight > 0) {
            return Math.min(height, maxHeight);
        }
        return height;
    }

    function getDefaultNodeWidth(config) {
        const width = Number(config?.defaultWidth);
        return Number.isFinite(width) && width > 0 ? width : FALLBACK_DEFAULT_NODE_WIDTH;
    }

    function getDefaultNodeHeight(config) {
        const height = Number(config?.defaultHeight);
        return Number.isFinite(height) && height > 0 ? height : FALLBACK_DEFAULT_NODE_HEIGHT;
    }

    function getConfiguredMinimumHeight(config) {
        const height = Number(config?.minHeight);
        return Number.isFinite(height) && height > 0 ? height : getDefaultNodeHeight(config);
    }

    function clampNodeWidthToDefault(width, config) {
        const defaultWidth = getDefaultNodeWidth(config);
        const numericWidth = Number(width);
        return Number.isFinite(numericWidth) && numericWidth > 0
            ? Math.max(numericWidth, defaultWidth)
            : defaultWidth;
    }

    function getPx(style, property) {
        const value = parseFloat(style?.getPropertyValue?.(property) || '0');
        return Number.isFinite(value) ? value : 0;
    }

    function getOuterExtras(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'margin-left') + getPx(style, 'margin-right');
        }
        return getPx(style, 'margin-top') + getPx(style, 'margin-bottom');
    }

    function getBoxExtras(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'padding-left') + getPx(style, 'padding-right') +
                getPx(style, 'border-left-width') + getPx(style, 'border-right-width');
        }
        return getPx(style, 'padding-top') + getPx(style, 'padding-bottom') +
            getPx(style, 'border-top-width') + getPx(style, 'border-bottom-width');
    }

    function getLayoutGap(style, axis) {
        if (axis === 'x') {
            return getPx(style, 'column-gap') || getPx(style, 'gap') || 0;
        }
        return getPx(style, 'row-gap') || getPx(style, 'gap') || 0;
    }

    function getRenderedHeightFloor(el, style, minHeight, marginY) {
        return Math.ceil(Math.max(
            minHeight,
            el.offsetHeight || 0,
            el.scrollHeight || 0
        ) + marginY);
    }

    function isVisibleElement(el) {
        if (!el) return false;
        if (el.classList?.contains('node-select-native') || el.classList?.contains('node-select-panel')) {
            return false;
        }
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'collapse' && el.offsetParent !== null;
    }

    function isResizableMediaElement(el) {
        return Boolean(el?.matches?.(NODE_RESIZABLE_MEDIA_SELECTOR));
    }

    function hasScrollableResultContent(el) {
        return Boolean(
            el?.matches?.(NODE_SCROLLABLE_RESULT_SELECTOR) ||
            el?.querySelector?.(NODE_SCROLLABLE_RESULT_SELECTOR)
        );
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
        const minWidth = getPx(style, 'min-width');

        if (control.tagName === 'SELECT') {
            const selectedOption = control.selectedOptions?.[0];
            const optionWidth = Array.from(control.options || []).reduce((max, option) => {
                return Math.max(max, measureTextWidth(option.textContent || option.value || '', font));
            }, measureTextWidth(selectedOption?.textContent || control.value || '', font));
            return Math.ceil(Math.max(minWidth, optionWidth + horizontalPadding + horizontalBorder + 18));
        }

        if (control.tagName === 'BUTTON') {
            const text = String(control.textContent || '').replace(/\s+/g, ' ').trim();
            const children = Array.from(control.children).filter(isVisibleElement);
            const childrenWidth = children.reduce((total, child) => total + (child.offsetWidth || 0), 0);
            const gap = getLayoutGap(style, 'x') * Math.max(0, children.length + (text ? 1 : 0) - 1);
            return Math.ceil(Math.max(minWidth, measureTextWidth(text, font) + childrenWidth + gap + horizontalPadding + horizontalBorder));
        }

        if (control.tagName === 'TEXTAREA') {
            return Math.ceil(Math.max(minWidth, horizontalPadding + horizontalBorder + 32));
        }

        const text = control.value || control.placeholder || '';
        return Math.ceil(Math.max(minWidth, measureTextWidth(text, font) + horizontalPadding + horizontalBorder));
    }

    function getElementMinimumSize(el) {
        if (!isVisibleElement(el)) {
            return { width: 0, height: 0 };
        }

        const style = getComputedStyle(el);
        const marginX = getOuterExtras(style, 'x');
        const marginY = getOuterExtras(style, 'y');
        const minWidth = getPx(style, 'min-width');
        const minHeight = getPx(style, 'min-height');

        if (el.classList.contains('text-split-preview')) {
            return {
                width: Math.ceil(minWidth + marginX),
                height: Math.ceil(minHeight + marginY)
            };
        }

        if (isResizableMediaElement(el)) {
            return {
                width: Math.ceil(minWidth + marginX),
                height: Math.ceil(minHeight + marginY)
            };
        }

        if (el.matches?.(NODE_SCROLL_CONTENT_SELECTOR)) {
            const explicitHeightValue = String(el.style?.height || '');
            const explicitHeight = /px$/i.test(explicitHeightValue) ? parseFloat(explicitHeightValue) : NaN;
            const contentHeight = el.classList.contains('chat-response-area')
                ? minHeight
                : (Number.isFinite(explicitHeight) && explicitHeight > 0 ? explicitHeight : minHeight);
            return {
                width: Math.ceil(minWidth + getBoxExtras(style, 'x') + marginX),
                height: Math.ceil(Math.max(minHeight, contentHeight) + marginY)
            };
        }

        if (el.classList.contains('camera-control-summary-grid')) {
            const children = Array.from(el.children).filter(isVisibleElement);
            const childSizes = children.map((child) => getElementMinimumSize(child));
            const columnsText = String(style.gridTemplateColumns || '').trim();
            let parsedColumns = 0;
            let depth = 0;
            let tokenStarted = false;
            for (const char of columnsText) {
                if (char === '(') {
                    depth += 1;
                    tokenStarted = true;
                    continue;
                }
                if (char === ')') {
                    depth = Math.max(0, depth - 1);
                    tokenStarted = true;
                    continue;
                }
                if (/\s/.test(char) && depth === 0) {
                    if (tokenStarted) {
                        parsedColumns += 1;
                        tokenStarted = false;
                    }
                    continue;
                }
                tokenStarted = true;
            }
            if (tokenStarted) parsedColumns += 1;
            const columns = Math.max(
                1,
                parsedColumns || 1,
                children.length > 0 ? 1 : 0
            );
            const rows = Math.max(1, Math.ceil((children.length || 1) / columns));
            const rowHeights = Array.from({ length: rows }, (_, rowIndex) => {
                const start = rowIndex * columns;
                const rowChildren = childSizes.slice(start, start + columns);
                return rowChildren.length ? Math.max(...rowChildren.map((size) => size.height)) : 0;
            });
            const widestChild = childSizes.length ? Math.max(...childSizes.map((size) => size.width)) : minWidth;
            return {
                width: Math.ceil(Math.max(
                    minWidth,
                    columns * widestChild + Math.max(0, columns - 1) * getLayoutGap(style, 'x') + getBoxExtras(style, 'x')
                ) + marginX),
                height: Math.ceil(Math.max(
                    minHeight,
                    rowHeights.reduce((total, size) => total + size, 0) + Math.max(0, rows - 1) * getLayoutGap(style, 'y') + getBoxExtras(style, 'y')
                ) + marginY)
            };
        }

        if (el.matches?.('input, select, textarea, button')) {
            const explicitHeightValue = String(el.style?.height || '');
            const explicitHeight = /px$/i.test(explicitHeightValue) ? parseFloat(explicitHeightValue) : NaN;
            const controlHeight = el.tagName === 'TEXTAREA'
                ? (Number.isFinite(explicitHeight) && explicitHeight > 0 ? explicitHeight : minHeight)
                : el.offsetHeight || 0;
            return {
                width: Math.ceil(Math.max(minWidth, getControlContentWidth(el)) + marginX),
                height: Math.ceil(Math.max(minHeight, controlHeight) + marginY)
            };
        }

        const children = Array.from(el.children).filter(isVisibleElement);
        if (!children.length) {
            const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            const isInlineText = ['LABEL', 'SPAN'].includes(el.tagName) || style.display === 'inline' || style.display === 'inline-flex';
            const textWidth = text && isInlineText
                ? measureTextWidth(text, style.font || `${style.fontSize} ${style.fontFamily}`) + getBoxExtras(style, 'x')
                : 0;
            return {
                width: Math.ceil(Math.max(minWidth, textWidth) + marginX),
                height: Math.ceil(Math.max(minHeight, el.offsetHeight || 0) + marginY)
            };
        }

        const display = style.display || '';
        const flexDirection = style.flexDirection || 'row';
        const isRowLayout = (display.includes('flex') && !flexDirection.startsWith('column')) ||
            display.includes('grid') ||
            el.classList.contains('save-btn-group') ||
            el.classList.contains('image-resize-mode-group') ||
            el.classList.contains('generation-count-control') ||
            el.classList.contains('text-split-output-count-control');
        const childSizes = children.map((child) => getElementMinimumSize(child));
        const gapX = getLayoutGap(style, 'x');
        const gapY = getLayoutGap(style, 'y');
        const contentWidth = isRowLayout
            ? childSizes.reduce((total, size) => total + size.width, 0) + Math.max(0, childSizes.length - 1) * gapX
            : Math.max(0, ...childSizes.map((size) => size.width));
        const contentHeight = isRowLayout
            ? Math.max(0, ...childSizes.map((size) => size.height))
            : childSizes.reduce((total, size) => total + size.height, 0) + Math.max(0, childSizes.length - 1) * gapY;

        const calculatedHeight = Math.ceil(Math.max(minHeight, contentHeight + getBoxExtras(style, 'y')) + marginY);
        const shouldUseRenderedHeightFloor = !hasScrollableResultContent(el);
        return {
            width: Math.ceil(Math.max(minWidth, contentWidth + getBoxExtras(style, 'x')) + marginX),
            height: shouldUseRenderedHeightFloor
                ? Math.max(calculatedHeight, getRenderedHeightFloor(el, style, minHeight, marginY))
                : calculatedHeight
        };
    }

    function getHeaderMinimumWidth(header, fallbackWidth) {
        if (!header) return fallbackWidth;
        const style = getComputedStyle(header);
        const paddingX = getPx(style, 'padding-left') + getPx(style, 'padding-right');
        const leftSize = getElementMinimumSize(header.querySelector('.header-left'));
        const rightSize = getElementMinimumSize(header.querySelector('.header-right'));
        const gap = getPx(style, 'column-gap') || getPx(style, 'gap') || 12;
        return Math.ceil(Math.max(fallbackWidth, paddingX + leftSize.width + rightSize.width + gap));
    }

    function getHeaderMeasuredHeight(header) {
        if (!header) return 0;
        const style = getComputedStyle(header);
        return Math.ceil(
            Math.max(
                getPx(style, 'min-height'),
                header.offsetHeight || 0,
                header.scrollHeight || 0
            )
        );
    }

    function getMeasuredNodeMinimumSize(el, config = null) {
        if (!el) {
            return {
                minWidth: getDefaultNodeWidth(config),
                minHeight: getConfiguredMinimumHeight(config)
            };
        }

        const header = el.querySelector('.node-header');
        const portsRow = el.querySelector('.node-ports-row');
        const body = el.querySelector('.node-body');
        const isCollapsed = el.classList.contains('collapsed') || body?.classList.contains('is-collapsed');
        const originalElHeight = el.style.height;
        const originalBodyFlex = body?.style.flex || '';
        const originalBodyMinHeight = body?.style.minHeight || '';
        const originalBodyOverflowY = body?.style.overflowY || '';
        const originalBodyOverflowX = body?.style.overflowX || '';
        const originalBodyMaxHeight = body?.style.maxHeight || '';
        const originalBodyDisplay = body?.style.display || '';

        el.style.height = 'auto';
        if (body && !isCollapsed) {
            body.style.flex = '0 0 auto';
            body.style.minHeight = 'auto';
            body.style.overflowY = 'visible';
            body.style.overflowX = 'visible';
            body.style.maxHeight = 'none';
        }

        const headerWidth = getHeaderMinimumWidth(header, getDefaultNodeWidth(config));
        const headerHeight = getHeaderMeasuredHeight(header);
        const portsRowSize = portsRow ? getElementMinimumSize(portsRow) : { width: 0, height: 0 };
        if (body && isCollapsed) {
            body.style.display = 'none';
        }
        const bodySize = body && !isCollapsed ? getElementMinimumSize(body) : { width: 0, height: 0 };
        const bodyRenderedHeight = body && !isCollapsed && !hasScrollableResultContent(body)
            ? Math.max(body.offsetHeight || 0, body.scrollHeight || 0)
            : 0;

        el.style.height = originalElHeight;
        if (body) {
            body.style.flex = originalBodyFlex;
            body.style.minHeight = originalBodyMinHeight;
            body.style.overflowY = originalBodyOverflowY;
            body.style.overflowX = originalBodyOverflowX;
            body.style.maxHeight = originalBodyMaxHeight;
            body.style.display = originalBodyDisplay;
        }

        const contentMinHeight = Math.ceil(headerHeight + portsRowSize.height + Math.max(bodySize.height, bodyRenderedHeight));
        return {
            minWidth: Math.max(getDefaultNodeWidth(config), headerWidth, portsRowSize.width, bodySize.width),
            minHeight: isCollapsed
                ? contentMinHeight
                : Math.max(getConfiguredMinimumHeight(config), contentMinHeight)
        };
    }

    function getNodeMinimumSize(nodeOrId, options = {}) {
        const node = typeof nodeOrId === 'string' ? state.nodes.get(nodeOrId) : nodeOrId;
        if (!node) {
            return {
                minWidth: FALLBACK_DEFAULT_NODE_WIDTH,
                minHeight: FALLBACK_DEFAULT_NODE_HEIGHT
            };
        }
        const config = nodeConfigs[node.type] || null;
        const measureWidth = Number(options.width);
        const shouldMeasureAtWidth = node.el && Number.isFinite(measureWidth) && measureWidth > 0;
        const originalWidth = shouldMeasureAtWidth ? node.el.style.width : '';
        let measured;
        try {
            if (shouldMeasureAtWidth) {
                node.el.style.width = `${Math.round(measureWidth)}px`;
            }
            measured = getMeasuredNodeMinimumSize(node.el, config);
        } finally {
            if (shouldMeasureAtWidth) {
                node.el.style.width = originalWidth;
            }
        }
        const configuredMinWidth = Number(config?.minWidth);
        const configuredMinHeight = Number(config?.minHeight);
        const isCollapsed = node.collapsed === true || node.el?.classList.contains('collapsed');
        const collapsedMinHeight = isCollapsed ? measured.minHeight : 0;
        return {
            minWidth: Math.max(
                getDefaultNodeWidth(config),
                Number.isFinite(configuredMinWidth) ? configuredMinWidth : 0,
                Number(node.minWidth) || 0,
                measured.minWidth
            ),
            minHeight: isCollapsed
                ? Math.max(
                    collapsedMinHeight,
                    Number(node.minHeight) || 0
                )
                : Math.max(
                    getConfiguredMinimumHeight(config),
                    Number.isFinite(configuredMinHeight) ? configuredMinHeight : 0,
                    Number(node.minHeight) || 0,
                    measured.minHeight
                )
        };
    }

    function applyNodeSize(node, width, height, options = {}) {
        if (!node?.el) return false;
        const currentWidth = node.el.offsetWidth || Number(node.width) || 0;
        const currentHeight = node.el.offsetHeight || Number(node.height) || 0;
        const nextWidth = Math.round(width);
        const nextHeight = Math.round(height);
        const widthChanged = Number.isFinite(nextWidth) && nextWidth > 0 && Math.abs(nextWidth - currentWidth) > 1;
        const heightChanged = Number.isFinite(nextHeight) && nextHeight > 0 && Math.abs(nextHeight - currentHeight) > 1;
        if (!widthChanged && !heightChanged) return false;

        if (widthChanged) {
            node.el.style.width = `${nextWidth}px`;
            node.width = nextWidth;
            node.observedWidth = nextWidth;
        }
        if (heightChanged) {
            node.el.style.height = `${nextHeight}px`;
            node.height = nextHeight;
            node.observedHeight = nextHeight;
        }

        if (options.updateConnections !== false) updateAllConnections();
        if (options.save !== false) scheduleSave();
        return true;
    }

    function fitNodeToContent(nodeId, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node || !node.el) return;
        const { allowShrink = false, reason = '' } = options;
        const minimum = getNodeMinimumSize(node);
        const currentWidth = node.el.offsetWidth || Number(node.width) || minimum.minWidth;
        const currentHeight = node.el.offsetHeight || Number(node.height) || minimum.minHeight;
        const shouldShrink = allowShrink && reason === 'element-resize';
        const respectsUserWidth = node.userResized === true && currentWidth >= minimum.minWidth;
        const respectsUserHeight = node.userResized === true && currentHeight >= minimum.minHeight;
        const nextWidth = shouldShrink
            ? minimum.minWidth
            : (respectsUserWidth ? currentWidth : Math.max(currentWidth, minimum.minWidth));
        const nextHeight = shouldShrink
            ? minimum.minHeight
            : (respectsUserHeight ? currentHeight : Math.max(currentHeight, minimum.minHeight));
        applyNodeSize(node, nextWidth, nextHeight, options);
    }

    function ensureNodeContentVisible(nodeId, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node || !node.el) return;
        const minimum = getNodeMinimumSize(node);
        const currentWidth = node.el.offsetWidth || Number(node.width) || minimum.minWidth;
        const currentHeight = node.el.offsetHeight || Number(node.height) || minimum.minHeight;
        applyNodeSize(
            node,
            Math.max(currentWidth, minimum.minWidth),
            Math.max(currentHeight, minimum.minHeight),
            options
        );
    }

    function scheduleEnsureNodeContentVisible(nodeId, options = {}) {
        const requestFrame = view.requestAnimationFrame || ((callback) => view.setTimeout(callback, 16));
        requestFrame(() => {
            ensureNodeContentVisible(nodeId, options);
        });
    }

    function scheduleNodeContentVisibleChecks(nodeId, options = {}) {
        scheduleEnsureNodeContentVisible(nodeId, options);
        const delays = Array.isArray(options.delays) ? options.delays : [50, 150];
        delays.forEach((delay) => {
            view.setTimeout(() => {
                ensureNodeContentVisible(nodeId, options);
            }, delay);
        });
    }

    function normalizeNodeType(type) {
        if (type === 'TextInput' || type === 'TextDisplay') return 'Text';
        return type;
    }

    function getNodeDefaultRestoreData(type) {
        if (!NODE_DEFAULT_TYPES.includes(type)) return null;
        const defaults = state.nodeDefaults?.[type];
        if (!defaults) return null;
        if (type === 'CameraControl') {
            return {
                pitch: defaults.pitch ?? 12,
                yaw: defaults.yaw ?? 28,
                distance: defaults.distance ?? 6.5,
                fov: defaults.fov ?? 50,
                roll: defaults.roll ?? 0,
                cameraViewMode: defaults.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson'
            };
        }
        if (!defaults.apiConfigId && !defaults.providerId) return null;
        return {
            apiConfigId: defaults.apiConfigId || '',
            providerId: defaults.providerId || ''
        };
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList.contains('running');
    }

    function normalizeCustomNodeTitle(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function getNodeDefaultTitle(nodeData) {
        return nodeData?.defaultTitle || nodeConfigs[nodeData?.type]?.title || nodeData?.type || '节点';
    }

    function applyNodeTitle(nodeData) {
        if (!nodeData?.el) return;
        const defaultTitle = getNodeDefaultTitle(nodeData);
        const displayTitle = nodeData.customTitle || defaultTitle;
        const titleEl = nodeData.el.querySelector('.node-title');
        if (titleEl) {
            titleEl.textContent = displayTitle;
            titleEl.title = nodeData.customTitle ? displayTitle : '';
        }
        nodeData.el.dataset.nodeTitle = displayTitle;
    }

    function clonePlainValue(value) {
        if (value === undefined) return undefined;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }

    function addNode(type, x, y, restoreData, silent = false) {
        if (!silent) pushHistory();
        const normalizedType = normalizeNodeType(type);
        const config = nodeConfigs[normalizedType];
        if (!config) {
            if (!silent) showToast(`未注册的节点类型：${normalizedType}`, 'error', 5000);
            return null;
        }
        const effectiveRestoreData = restoreData || getNodeDefaultRestoreData(normalizedType);
        const id = effectiveRestoreData?.id ? effectiveRestoreData.id : generateId();
        const el = documentRef.createElement('div');
        el.className = `node ${config.cssClass}`;
        el.id = id;
        if (effectiveRestoreData?.isClone === true && effectiveRestoreData?.cloneSourceId) {
            el.classList.add('node-clone');
            el.dataset.cloneSourceId = effectiveRestoreData.cloneSourceId;
        }
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        const initialWidth = clampNodeWidthToDefault(effectiveRestoreData?.width, config);
        el.style.width = initialWidth + 'px';

        const clampedInitialHeight = clampNodeHeight(
            Math.max(Number(effectiveRestoreData?.height) || 0, getDefaultNodeHeight(config)),
            config,
            { isRestore: Boolean(effectiveRestoreData?.height) }
        );
        const initialHeight = Math.max(clampedInitialHeight || 0, getDefaultNodeHeight(config));
        if (initialHeight) el.style.height = initialHeight + 'px';

        try {
            el.innerHTML = createNodeMarkup({ type: normalizedType, id, config, restoreData: effectiveRestoreData, state });
        } catch (error) {
            if (!silent) showToast(`创建节点失败：${error.message || error}`, 'error', 5000);
            return null;
        }
        nodesLayer.appendChild(el);

        if (effectiveRestoreData && effectiveRestoreData.height) {
            el.querySelectorAll('.preview-container, .save-preview-container, .file-drop-zone').forEach((container) => {
                container.style.maxHeight = 'none';
            });
        }

        const nodeData = {
            id,
            type: normalizedType,
            x,
            y,
            el,
            data: {},
            imageData: null,
            compareImageA: null,
            compareImageB: null,
            importMode: effectiveRestoreData?.importMode === 'url' ? 'url' : 'upload',
            imageUrl: effectiveRestoreData?.imageUrl || '',
            previewZoom: 1,
            resizePreviewData: null,
            resizePreviewMeta: null,
            resizePreviewToken: 0,
            providerId: effectiveRestoreData?.providerId || '',
            width: initialWidth,
            height: initialHeight,
            defaultWidth: getDefaultNodeWidth(config),
            defaultHeight: getDefaultNodeHeight(config),
            userResized: effectiveRestoreData?.userResized === true,
            collapsed: effectiveRestoreData?.collapsed === true,
            maxHeight: config.maxHeight || null,
            dirHandle: null,
            enabled: effectiveRestoreData?.enabled !== false,
            isSucceeded: effectiveRestoreData?.isSucceeded || false,
            lastDuration: effectiveRestoreData?.lastDuration || null,
            lastResponse: effectiveRestoreData?.lastResponse || '',
            originalWidth: effectiveRestoreData?.originalWidth || 0,
            originalHeight: effectiveRestoreData?.originalHeight || 0,
            outputWidth: effectiveRestoreData?.outputWidth || 0,
            outputHeight: effectiveRestoreData?.outputHeight || 0,
            outputFormat: effectiveRestoreData?.outputFormat || '',
            outputQuality: effectiveRestoreData?.outputQuality || null,
            estimatedBytes: effectiveRestoreData?.estimatedBytes || null,
            defaultTitle: config.title,
            customTitle: normalizeCustomNodeTitle(effectiveRestoreData?.customTitle || ''),
            isClone: effectiveRestoreData?.isClone === true && typeof effectiveRestoreData?.cloneSourceId === 'string' && !!effectiveRestoreData.cloneSourceId,
            cloneSourceId: typeof effectiveRestoreData?.cloneSourceId === 'string' ? effectiveRestoreData.cloneSourceId : ''
        };
        if (normalizedType === 'ImageGenerate' || normalizedType === 'TextChat') {
            nodeData.referenceImageCount = getReferenceImageCount(effectiveRestoreData);
            nodeData.data.referenceImageCount = nodeData.referenceImageCount;
        }
        if (!nodeData.isClone) {
            nodeData.cloneSourceId = '';
        }
        applyNodeTitle(nodeData);
        if (nodeData.lastDuration) {
            const timeBadge = el.querySelector(`#${id}-time`);
            const timeContainer = el.querySelector(`#${id}-time-container`);
            if (timeBadge && timeContainer) {
                timeBadge.textContent = `${nodeData.lastDuration}s`;
                timeContainer.style.display = 'flex';
            }
        }
        if (effectiveRestoreData?.lastText) {
            nodeData.data.text = effectiveRestoreData.lastText;
        }
        if (normalizedType === 'Text') {
            if (Array.isArray(effectiveRestoreData?.texts) && effectiveRestoreData.texts.length > 0) {
                nodeData.data.texts = effectiveRestoreData.texts.filter((item) => typeof item === 'string');
                nodeData.textPreviewIndex = Math.max(0, Math.min(
                    nodeData.data.texts.length - 1,
                    parseInt(effectiveRestoreData?.textPreviewIndex || '0', 10) || 0
                ));
                nodeData.data.text = nodeData.data.texts[nodeData.textPreviewIndex] || '';
            } else {
                nodeData.data.text = effectiveRestoreData?.text || effectiveRestoreData?.lastText || '';
                nodeData.textPreviewIndex = 0;
            }
        }
        const restoredImages = Array.isArray(effectiveRestoreData?.images)
            ? effectiveRestoreData.images.filter((item) => typeof item === 'string' && item.trim())
            : [];
        if (restoredImages.length > 1) {
            nodeData.data.images = restoredImages.slice();
            nodeData.imageDataList = restoredImages.slice();
            if (normalizedType === 'ImagePreview' || normalizedType === 'ImageSave') {
                nodeData.imagePreviewIndex = Math.max(0, Math.min(
                    restoredImages.length - 1,
                    parseInt(effectiveRestoreData?.imagePreviewIndex || '0', 10) || 0
                ));
                nodeData.data.image = restoredImages[nodeData.imagePreviewIndex] || restoredImages[0];
            } else {
                nodeData.data.image = restoredImages[restoredImages.length - 1];
            }
            nodeData.imageData = nodeData.data.image;
        } else if (normalizedType === 'ImagePreview' || normalizedType === 'ImageSave') {
            nodeData.imagePreviewIndex = 0;
        }
        if (normalizedType === 'CameraControl') {
            nodeData.data.pitch = Number.isFinite(Number(effectiveRestoreData?.pitch)) ? Number(effectiveRestoreData.pitch) : 12;
            nodeData.data.yaw = Number.isFinite(Number(effectiveRestoreData?.yaw)) ? Number(effectiveRestoreData.yaw) : 28;
            nodeData.data.distance = Number.isFinite(Number(effectiveRestoreData?.distance)) ? Number(effectiveRestoreData.distance) : 6.5;
            nodeData.data.fov = Number.isFinite(Number(effectiveRestoreData?.fov)) ? Number(effectiveRestoreData.fov) : 50;
            nodeData.data.roll = Number.isFinite(Number(effectiveRestoreData?.roll)) ? Number(effectiveRestoreData.roll) : 0;
            nodeData.data.cameraViewMode = effectiveRestoreData?.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
            nodeData.data.text = effectiveRestoreData?.cameraPrompt || effectiveRestoreData?.text || '';
            nodeData.data.cameraPrompt = nodeData.data.text;
            nodeData.data.cameraPreviewImage = effectiveRestoreData?.cameraPreviewImage || '';
        }
        if (normalizedType === 'TextSplit') {
            nodeData.data.text = effectiveRestoreData?.text || effectiveRestoreData?.lastText || '';
            nodeData.data.delimiter = effectiveRestoreData?.delimiter || '';
            const restoredParts = Array.isArray(effectiveRestoreData?.parts) ? effectiveRestoreData.parts.slice() : [];
            const fallbackOutputCount = Math.max(1, restoredParts.length || splitTextForTextSplitNode(
                nodeData.data.text,
                effectiveRestoreData?.delimiter !== undefined ? effectiveRestoreData.delimiter : '\n\n',
                { removeEmptyLines: effectiveRestoreData?.removeEmptyLines === true }
            ).length);
            if (effectiveRestoreData?.mergeOutputEnabled === true) {
                nodeData.data.outputCount = 0;
            } else if (effectiveRestoreData?.outputCount !== undefined && effectiveRestoreData.outputCount !== '') {
                const parsedOutputCount = parseInt(effectiveRestoreData.outputCount, 10);
                nodeData.data.outputCount = Number.isFinite(parsedOutputCount) ? Math.max(0, parsedOutputCount) : 1;
            } else {
                nodeData.data.outputCount = fallbackOutputCount;
            }
            nodeData.data.removeEmptyLines = effectiveRestoreData?.removeEmptyLines === true;
            nodeData.data.previewEnabled = effectiveRestoreData?.previewEnabled === true;
            nodeData.data.mergeOutputEnabled = effectiveRestoreData?.mergeOutputEnabled === true;
            nodeData.data.parts = nodeData.data.outputCount === 0
                ? restoredParts
                : restoredParts.slice(0, nodeData.data.outputCount);
            if (nodeData.data.mergeOutputEnabled) {
                nodeData.data.texts = nodeData.data.parts.slice();
            }
            nodeData.data.parts.forEach((part, index) => {
                nodeData.data[`part_${index + 1}`] = part;
            });
        }
        if (normalizedType === 'CustomParams') {
            const restoredParams = Array.isArray(effectiveRestoreData?.params)
                ? effectiveRestoreData.params
                : (Array.isArray(effectiveRestoreData?.customParams) ? effectiveRestoreData.customParams : []);
            nodeData.data.params = restoredParams
                .map((row) => ({
                    key: typeof row?.key === 'string' ? row.key.trim() : '',
                    value: row?.value === undefined || row?.value === null ? '' : String(row.value)
                }))
                .filter((row) => row.key);
        }
        if (nodeData.isSucceeded) el.classList.add('completed');
        if (!nodeData.enabled) el.classList.add('disabled');
        if (nodeData.collapsed) el.classList.add('collapsed');
        state.nodes.set(id, nodeData);
        if (nodeData.collapsed) {
            const collapsedMinimum = getNodeMinimumSize(nodeData);
            if (collapsedMinimum?.minHeight) {
                el.style.height = `${Math.round(collapsedMinimum.minHeight)}px`;
                nodeData.height = Math.round(collapsedMinimum.minHeight);
                nodeData.observedHeight = Math.round(collapsedMinimum.minHeight);
            }
        }
        el.addEventListener('load', (event) => {
            if (event.target?.tagName === 'IMG') {
                scheduleEnsureNodeContentVisible(id);
            }
        }, true);
        bindNodeSizeObserver(nodeData);

        if (normalizedType === 'ImageImport' || normalizedType === 'ImagePreview' || normalizedType === 'ImageSave' || normalizedType === 'ImageResize' || normalizedType === 'ImageCompare' || normalizedType === 'ImageGenerate') {
            (async () => {
                const isImportUrlMode = normalizedType === 'ImageImport' && nodeData.importMode === 'url';
                const hasInitialData = !!(effectiveRestoreData && effectiveRestoreData.imageData);
                const storedImages = isImportUrlMode || hasInitialData ? [] : await getImageAssetList(id);
                if (storedImages.length > 1) {
                    nodeData.data.images = storedImages.slice();
                    nodeData.imageDataList = storedImages.slice();
                    if (normalizedType === 'ImagePreview' || normalizedType === 'ImageSave') {
                        nodeData.imagePreviewIndex = Math.max(0, Math.min(
                            storedImages.length - 1,
                            Number.isFinite(nodeData.imagePreviewIndex) ? nodeData.imagePreviewIndex : 0
                        ));
                        nodeData.data.image = storedImages[storedImages.length - 1];
                        nodeData.imageData = nodeData.data.image;
                    } else {
                        nodeData.data.image = storedImages[storedImages.length - 1];
                        nodeData.imageData = nodeData.data.image;
                    }
                }
                const data = isImportUrlMode
                    ? null
                    : (hasInitialData ? effectiveRestoreData.imageData : (storedImages[0] || await getImageAsset(id)));

                if (!state.nodes.has(id)) return;

                if (isImportUrlMode && nodeData.imageUrl) {
                    nodeData.imageData = null;
                    nodeData.data.image = nodeData.imageUrl;
                    const urlInput = el.querySelector(`#${id}-url-input`);
                    if (urlInput) urlInput.value = nodeData.imageUrl;
                    onConnectionsChanged();
                    scheduleNodeContentVisibleChecks(id);
                    return;
                }

                if (data) {
                    if (!(normalizedType === 'ImagePreview' || normalizedType === 'ImageSave') || !Array.isArray(nodeData.imageDataList) || nodeData.imageDataList.length <= 1) {
                        nodeData.imageData = data;
                        nodeData.data.image = data;
                    }

                    if (hasInitialData && !isRemoteImageUrl(data)) {
                        await saveImageAsset(id, data);
                    }

                    if (normalizedType === 'ImageImport') {
                        const dropZone = el.querySelector(`#${id}-drop`);
                        if (dropZone) {
                            dropZone.classList.add('has-image');
                            dropZone.innerHTML = `<img src="${data}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImagePreview' || normalizedType === 'ImageGenerate') {
                        const previewContainer = el.querySelector(`#${id}-preview`);
                        if (previewContainer) {
                            if (normalizedType === 'ImagePreview' && Array.isArray(nodeData.imageDataList) && nodeData.imageDataList.length > 1) {
                                const index = Math.max(0, Math.min(nodeData.imageDataList.length - 1, Number.isFinite(nodeData.imagePreviewIndex) ? nodeData.imagePreviewIndex : 0));
                                const currentImage = nodeData.imageDataList[index];
                                previewContainer.classList.add('has-multiple-images');
                                previewContainer.innerHTML = `
                                    <img src="${currentImage}" alt="预览 ${index + 1}/${nodeData.imageDataList.length}" draggable="false" style="pointer-events: none;" />
                                    <button type="button" class="image-save-preview-nav image-save-preview-prev" data-direction="-1" title="上一张" aria-label="上一张">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>
                                    </button>
                                    <button type="button" class="image-save-preview-nav image-save-preview-next" data-direction="1" title="下一张" aria-label="下一张">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
                                    </button>
                                    <div class="image-save-preview-counter">${index + 1}/${nodeData.imageDataList.length}</div>
                                `;
                            } else {
                                previewContainer.innerHTML = `<img src="${data}" alt="预览" draggable="false" style="pointer-events: none;" />`;
                            }
                        }
                        const controls = el.querySelector(`#${id}-controls`);
                        if (controls) controls.style.display = 'flex';
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageSave') {
                        const savePreview = el.querySelector(`#${id}-save-preview`);
                        if (savePreview) {
                            if (Array.isArray(nodeData.imageDataList) && nodeData.imageDataList.length > 1) {
                                const index = Math.max(0, Math.min(nodeData.imageDataList.length - 1, Number.isFinite(nodeData.imagePreviewIndex) ? nodeData.imagePreviewIndex : 0));
                                const currentImage = nodeData.imageDataList[index];
                                savePreview.classList.add('has-multiple-images');
                                savePreview.innerHTML = `
                                    <img src="${currentImage}" alt="待保存 ${index + 1}/${nodeData.imageDataList.length}" draggable="false" style="pointer-events: none;" />
                                    <button type="button" class="image-save-preview-nav image-save-preview-prev" data-direction="-1" title="上一张" aria-label="上一张">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"/></svg>
                                    </button>
                                    <button type="button" class="image-save-preview-nav image-save-preview-next" data-direction="1" title="下一张" aria-label="下一张">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
                                    </button>
                                    <div class="image-save-preview-counter">${index + 1}/${nodeData.imageDataList.length}</div>
                                `;
                            } else {
                                savePreview.innerHTML = `<img src="${data}" alt="待保存" draggable="false" style="pointer-events: none;" />`;
                            }
                        }
                        const manualSaveBtn = el.querySelector(`#${id}-manual-save`);
                        const viewFullBtn = el.querySelector(`#${id}-view-full`);
                        if (manualSaveBtn) manualSaveBtn.disabled = false;
                        if (viewFullBtn) viewFullBtn.disabled = false;
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageResize') {
                        restoreImageResizePreview(id, data, {
                            outputWidth: effectiveRestoreData?.outputWidth || 0,
                            outputHeight: effectiveRestoreData?.outputHeight || 0,
                            outputQuality: effectiveRestoreData?.outputQuality || null,
                            estimatedBytes: effectiveRestoreData?.estimatedBytes || null
                        });
                        onConnectionsChanged();
                    } else if (normalizedType === 'ImageCompare') {
                        nodeData.compareImageB = data;
                        const compareContainer = el.querySelector(`#${id}-compare`);
                        if (compareContainer) {
                            compareContainer.classList.add('has-images');
                            compareContainer.innerHTML = `<img class="image-compare-img image-compare-b" src="${data}" alt="B 输入图片" draggable="false" />`;
                        }
                        showResolutionBadge(id, data);
                        onConnectionsChanged();
                    }
                    scheduleNodeContentVisibleChecks(id);
                }
            })();
        }

        try {
            bindNodeInteractions({ id, type: normalizedType, el });
        } catch (error) {
            el.remove();
            state.nodes.delete(id);
            if (!silent) showToast(`初始化节点失败：${error.message || error}`, 'error', 5000);
            return null;
        }
        scheduleNodeContentVisibleChecks(id);

        if (!restoreData && !silent) showToast(`已添加「${config.title}」节点`, 'success');
        if (!restoreData) scheduleSave();
        return id;
    }

    function createConnectionId() {
        return 'c_' + Math.random().toString(36).substr(2, 9);
    }

    function getPortDataType(nodeId, portName, direction) {
        const node = state.nodes.get(nodeId);
        const port = node?.el?.querySelector(`.node-port[data-port="${portName}"][data-direction="${direction}"]`);
        return port?.dataset?.type || '';
    }

    function getConnectionDataType(connection) {
        return connection.type ||
            getPortDataType(connection.from.nodeId, connection.from.port, 'output') ||
            getPortDataType(connection.to.nodeId, connection.to.port, 'input') ||
            '';
    }

    function buildPreservedConnections(idsToRemove) {
        const removeSet = new Set(idsToRemove);
        const candidates = [];

        idsToRemove.forEach((nid) => {
            const incoming = state.connections.filter((connection) => (
                connection.to.nodeId === nid &&
                !removeSet.has(connection.from.nodeId)
            ));
            const outgoing = state.connections.filter((connection) => (
                connection.from.nodeId === nid &&
                !removeSet.has(connection.to.nodeId)
            ));

            incoming.forEach((inConn) => {
                const inputType = getConnectionDataType(inConn);
                outgoing.forEach((outConn) => {
                    const outputType = getConnectionDataType(outConn);
                    if (!inputType || inputType !== outputType) return;
                    if (inConn.from.nodeId === outConn.to.nodeId) return;

                    candidates.push({
                        from: { nodeId: inConn.from.nodeId, port: inConn.from.port },
                        to: { nodeId: outConn.to.nodeId, port: outConn.to.port },
                        type: inputType
                    });
                });
            });
        });

        return candidates;
    }

    function appendPreservedConnections(candidates) {
        let added = 0;
        candidates.forEach((candidate) => {
            const hasSameConnection = state.connections.some((connection) => (
                connection.from.nodeId === candidate.from.nodeId &&
                connection.from.port === candidate.from.port &&
                connection.to.nodeId === candidate.to.nodeId &&
                connection.to.port === candidate.to.port
            ));
            const hasInputConnection = state.connections.some((connection) => (
                connection.to.nodeId === candidate.to.nodeId &&
                connection.to.port === candidate.to.port
            ));
            if (hasSameConnection || hasInputConnection) return;

            state.connections.push({
                id: createConnectionId(),
                from: candidate.from,
                to: candidate.to,
                type: candidate.type
            });
            added += 1;
        });
        return added;
    }

    function detachNodesFromConnections(idsToDetach, options = {}) {
        const ids = Array.from(new Set(Array.isArray(idsToDetach) ? idsToDetach : [idsToDetach]))
            .filter((nid) => state.nodes.has(nid));
        if (!ids.length) return { changed: false, removedConnectionCount: 0, preservedConnectionCount: 0 };
        if (ids.some((nid) => isNodeRunning(nid))) {
            if (options.showToast !== false) {
                showToast('节点正在运行，暂不能修改连线', 'warning');
            }
            return { changed: false, removedConnectionCount: 0, preservedConnectionCount: 0 };
        }

        const detachSet = new Set(ids);
        const preservedConnectionCandidates = buildPreservedConnections(ids);
        const before = state.connections.length;
        state.connections = state.connections.filter((connection) => (
            !detachSet.has(connection.from.nodeId) &&
            !detachSet.has(connection.to.nodeId)
        ));

        const removedConnectionCount = before - state.connections.length;
        const preservedConnectionCount = appendPreservedConnections(preservedConnectionCandidates);
        const changed = removedConnectionCount > 0 || preservedConnectionCount > 0;

        if (!changed) return { changed: false, removedConnectionCount, preservedConnectionCount };

        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        if (options.save !== false) scheduleSave();
        if (options.showToast !== false) {
            showToast(preservedConnectionCount > 0
                ? `节点已摘取，已保留 ${preservedConnectionCount} 条连线`
                : '节点已从连线中摘取', 'info');
        }

        return { changed, removedConnectionCount, preservedConnectionCount };
    }

    function removeNode(id, options = {}) {
        const selectedIds = state.selectedNodes.has(id) ? Array.from(state.selectedNodes) : [id];
        const lockedIds = selectedIds.filter((nid) => isNodeRunning(nid));
        const idsToRemove = selectedIds.filter((nid) => !isNodeRunning(nid));
        if (lockedIds.length > 0) {
            showToast(lockedIds.length > 1 ? `有 ${lockedIds.length} 个节点正在运行，暂不能删除` : '节点正在运行，暂不能删除', 'warning');
        }
        if (idsToRemove.length === 0) return;
        pushHistory();
        const preservedConnectionCandidates = options.preserveConnections
            ? buildPreservedConnections(idsToRemove)
            : [];
        let removedConnections = false;
        idsToRemove.forEach((nid) => {
            const node = state.nodes.get(nid);
            if (!node) return;
            const before = state.connections.length;
            state.connections = state.connections.filter((connection) => connection.from.nodeId !== nid && connection.to.nodeId !== nid);
            if (state.connections.length !== before) removedConnections = true;
            cleanupElementResources(node.el);
            disconnectNodeSizeObserver(node);
            node.el.remove();
            state.nodes.delete(nid);
            state.selectedNodes.delete(nid);
        });
        const preservedConnectionCount = appendPreservedConnections(preservedConnectionCandidates);
        if (preservedConnectionCount > 0) removedConnections = true;
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        if (preservedConnectionCount > 0) {
            showToast(idsToRemove.length > 1
                ? `已删除 ${idsToRemove.length} 个节点，已保留 ${preservedConnectionCount} 条连线`
                : '节点已删除，连线已保留', 'info');
        } else {
            showToast(idsToRemove.length > 1 ? `已删除 ${idsToRemove.length} 个节点` : '节点已删除', 'info');
        }
        scheduleSave();
        if (getCacheSidebarActive()) {
            updateCacheUsage();
        }
    }

    function selectNode(id, isMulti) {
        if (!isMulti) {
            state.selectedNodes.forEach((nid) => {
                const node = state.nodes.get(nid);
                if (node) node.el.classList.remove('selected');
            });
            state.selectedNodes.clear();
        }

        if (state.selectedNodes.has(id)) {
            state.selectedNodes.delete(id);
            const node = state.nodes.get(id);
            if (node) node.el.classList.remove('selected');
        } else {
            state.selectedNodes.add(id);
            const node = state.nodes.get(id);
            if (node) node.el.classList.add('selected');
        }
        updateAllConnections();
    }

    function toggleNodesEnabled(nodeIds, referenceNodeId = null) {
        if (!nodeIds || nodeIds.length === 0) return;

        const lockedIds = nodeIds.filter((nid) => isNodeRunning(nid));
        const editableIds = nodeIds.filter((nid) => !isNodeRunning(nid));
        if (lockedIds.length > 0) {
            showToast(lockedIds.length > 1 ? `有 ${lockedIds.length} 个节点正在运行，暂不能启用或禁用` : '节点正在运行，暂不能启用或禁用', 'warning');
        }
        if (editableIds.length === 0) return;

        const refId = (referenceNodeId && !isNodeRunning(referenceNodeId)) ? referenceNodeId : editableIds[0];
        const refNode = state.nodes.get(refId);
        if (!refNode) return;

        const targetState = !refNode.enabled;

        editableIds.forEach((nid) => {
            const nodeData = state.nodes.get(nid);
            if (nodeData) {
                nodeData.enabled = targetState;
                nodeData.el.classList.toggle('disabled', !targetState);
                if (targetState) {
                    nodeData.el.classList.remove('completed', 'error', 'running');
                    const timeBadge = documentRef.getElementById(`${nid}-time`);
                    if (timeBadge && timeBadge.textContent === 'Skip') timeBadge.textContent = '';
                }
            }
        });

        showToast(targetState ? `已启用 ${editableIds.length} 个节点` : `已禁用 ${editableIds.length} 个节点`, 'info');
        updateAllConnections();
        updatePortStyles();
        onConnectionsChanged();
        scheduleSave();
    }

    function renameNode(nodeId, nextTitle) {
        const nodeData = state.nodes.get(nodeId);
        if (!nodeData) return false;
        if (nodeData.isClone) {
            showToast('克隆节点的参数与标题由源节点同步，请先独立化后再重命名', 'warning');
            return false;
        }
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能重命名', 'warning');
            return false;
        }

        const customTitle = normalizeCustomNodeTitle(nextTitle);
        if (customTitle === (nodeData.customTitle || '')) return false;

        pushHistory();
        if (customTitle) {
            nodeData.customTitle = customTitle;
            nodeData.data.customTitle = customTitle;
        } else {
            delete nodeData.customTitle;
            delete nodeData.data.customTitle;
        }
        applyNodeTitle(nodeData);
        state.nodes.forEach((candidate) => {
            if (candidate?.isClone === true && candidate.cloneSourceId === nodeId) {
                candidate.customTitle = nodeData.customTitle || '';
                applyNodeTitle(candidate);
            }
        });
        scheduleEnsureNodeContentVisible(nodeId, { save: false });
        updateAllConnections();
        scheduleSave();
        showToast(customTitle ? `节点已重命名为「${customTitle}」` : '节点名称已还原', 'success');
        return true;
    }

    function cloneNode(sourceNodeId) {
        const sourceNode = state.nodes.get(sourceNodeId);
        if (!sourceNode) return null;
        if (sourceNode.isClone) {
            showToast('请从源节点创建克隆，或先独立化这个克隆节点', 'warning');
            return null;
        }
        if (typeof serializeOneNode !== 'function') {
            showToast('当前无法读取节点参数，克隆失败', 'error');
            return null;
        }

        pushHistory();
        const snapshot = serializeOneNode(sourceNodeId);
        if (!snapshot) return null;
        const newId = addNode(sourceNode.type, sourceNode.x + 36, sourceNode.y + 36, {
            ...snapshot,
            id: null,
            x: sourceNode.x + 36,
            y: sourceNode.y + 36,
            isClone: true,
            cloneSourceId: sourceNodeId
        }, true);
        if (!newId) return null;

        state.selectedNodes.forEach((nid) => {
            const node = state.nodes.get(nid);
            if (node) node.el.classList.remove('selected');
        });
        state.selectedNodes.clear();
        state.selectedNodes.add(newId);
        state.nodes.get(newId)?.el.classList.add('selected');
        updateAllConnections();
        scheduleSave();
        showToast('已创建克隆节点', 'success');
        return newId;
    }

    function detachCloneNode(nodeId) {
        const nodeData = state.nodes.get(nodeId);
        if (!nodeData?.isClone) return false;
        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能独立化', 'warning');
            return false;
        }

        pushHistory();
        nodeData.isClone = false;
        nodeData.cloneSourceId = '';
        nodeData.data = clonePlainValue(nodeData.data || {});
        nodeData.el.classList.remove('node-clone');
        nodeData.el.removeAttribute('data-clone-source-id');
        nodeData.el.querySelector('.node-clone-badge')?.remove();
        nodeData.el.querySelectorAll('[data-clone-locked="1"]').forEach((control) => {
            control.removeAttribute('data-clone-locked');
            if (control.tagName === 'TEXTAREA' || control.tagName === 'INPUT') control.readOnly = false;
            if (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA' || control.tagName === 'SELECT' || control.tagName === 'BUTTON') control.disabled = false;
            control.classList.remove('clone-locked-control');
        });
        scheduleSave();
        showToast('克隆节点已独立化', 'success');
        return true;
    }

    return {
        fitNodeToContent,
        getNodeMinimumSize,
        addNode,
        removeNode,
        detachNodesFromConnections,
        selectNode,
        toggleNodesEnabled,
        renameNode,
        cloneNode,
        detachCloneNode
    };
}
