/**
 * 负责把节点 DOM 与交互行为绑定起来，包括拖拽、输入监听、按钮操作和端口事件。
 */
import {
    VIDEO_ASPECT_OPTIONS,
    DOUBAO_VIDEO_RATIO_OPTIONS,
    DOUBAO_VIDEO_RESOLUTION_OPTIONS,
    getEffectiveProtocol,
    getImageResolutionOptionsForModel,
    getModelProviders,
    getResolvedProviderForModel,
    getResolvedProviderIdForModel,
    getVideoProtocolOptionMeta,
    normalizeImageResolutionForModel,
    validateOpenAiImageSize
} from '../features/execution/provider-request-utils.js';
import { collectConnectionSnapshotsForNodes } from '../canvas/connection-copy-utils.js';
import { splitTextForTextSplitNode } from '../core/common-utils.js';

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
    cancelRunningNode = null,
    finishConnection,
    resumeVideoGeneration = async () => {},
    resumeImageGeneration = async () => {},
    setupImageImport,
    setupImageResize,
    setupImageSave,
    setupImagePreview,
    setupImageCompare,
    setupCameraControlNode,
    copyToClipboard,
    showToast,
    scheduleSave,
    debounce,
    fitNodeToContent = () => {},
    enforceNodeContentMinimum = () => null,
    getNodeMinimumSizeFromLifecycle = null,
    updateAllConnections = () => {},
    updatePortStyles = () => {},
    onConnectionsChanged = () => {},
    documentRef = document
}) {
    const NODE_RESIZABLE_MEDIA_SELECTOR = '.file-drop-zone, .preview-container, .save-preview-container, .image-compare-container';
    const ZOOM_SETTLE_GUARD_MS = 220;
    const NODE_CANCEL_HOLD_MS = 2000;
    const NODE_CANCEL_DRAG_THRESHOLD = 8;

    function postponeZoomSettle() {
        state.zoomSettleBlockedUntil = Date.now() + ZOOM_SETTLE_GUARD_MS;
    }

    function lockZoomSettleForControl(control) {
        postponeZoomSettle();
        if (control?.tagName === 'SELECT') {
            state.zoomSettleControlLock = true;
        }
    }

    function flushPendingZoomVisualRefresh() {
        state.zoomSettleControlLock = false;
        if (!state.pendingZoomVisualRefresh) return;
        state.pendingZoomVisualRefresh = false;
        state.isInteracting = false;
        canvasContainer.classList.remove('is-zooming');
        documentRef.body.classList.remove('is-interacting');
        documentRef.getElementById('connections-group').classList.remove('is-interacting');
        viewportApi.updateCanvasTransform();
        const requestFrame = documentRef.defaultView?.requestAnimationFrame;
        if (typeof requestFrame === 'function') {
            requestFrame(() => viewportApi.refreshNodeTextRendering());
        } else {
            viewportApi.refreshNodeTextRendering();
        }
    }

    function hasPortConnection(nodeId, portName, direction) {
        if (!nodeId || !portName || !direction) return false;
        if (direction === 'input') {
            return state.connections.some((connection) => (
                connection.to.nodeId === nodeId &&
                connection.to.port === portName
            ));
        }
        if (direction === 'output') {
            return state.connections.some((connection) => (
                connection.from.nodeId === nodeId &&
                connection.from.port === portName
            ));
        }
        return false;
    }

    function syncCollapsedUnusedPorts(nodeId) {
        const node = state.nodes.get(nodeId);
        const ports = node?.el?.querySelectorAll?.('.node-port');
        if (!ports?.length) return;

        const isCollapsed = node.collapsed === true || node.el.classList.contains('collapsed');
        ports.forEach((portEl) => {
            const direction = portEl.dataset.direction || '';
            const portName = portEl.dataset.port || '';
            const shouldHideForCollapse = isCollapsed && !hasPortConnection(nodeId, portName, direction);
            portEl.classList.toggle('is-hidden-by-collapse', shouldHideForCollapse);
            portEl.setAttribute('aria-hidden', shouldHideForCollapse ? 'true' : 'false');
        });
    }

    function syncAllCollapsedUnusedPorts() {
        state.nodes.forEach((_, nodeId) => syncCollapsedUnusedPorts(nodeId));
    }

    function syncTextNodeData(id) {
        const node = state.nodes.get(id);
        const textarea = documentRef.getElementById(`${id}-text`);
        if (!node || !textarea) return;
        node.data = node.data || {};
        if (Array.isArray(node.data.texts) && node.data.texts.length > 0) {
            const index = Math.max(0, Math.min(node.data.texts.length - 1, parseInt(node.textPreviewIndex || '0', 10) || 0));
            node.textPreviewIndex = index;
            node.data.texts[index] = textarea.value;
            node.data.text = textarea.value;
            return;
        }
        node.data.text = textarea.value;
    }

    function normalizeTextList(value) {
        if (Array.isArray(value)) {
            return value.filter((item) => typeof item === 'string');
        }
        return typeof value === 'string' ? [value] : [];
    }

    function getTextPreviewIndex(node, texts) {
        if (!texts.length) return 0;
        const rawIndex = Number.isFinite(node?.textPreviewIndex) ? node.textPreviewIndex : 0;
        return Math.max(0, Math.min(texts.length - 1, rawIndex));
    }

    function renderTextMultiPreview(id) {
        const node = state.nodes.get(id);
        const textarea = documentRef.getElementById(`${id}-text`);
        const nav = documentRef.getElementById(`${id}-text-nav`);
        const counter = documentRef.getElementById(`${id}-text-counter`);
        if (!node || !textarea) return;

        const texts = normalizeTextList(node.data?.texts);
        if (texts.length <= 1) {
            nav?.classList.add('hidden');
            if (counter) counter.textContent = '';
            if (texts.length === 1 && textarea.value !== texts[0]) textarea.value = texts[0];
            return;
        }

        const index = getTextPreviewIndex(node, texts);
        node.textPreviewIndex = index;
        if (textarea.value !== texts[index]) textarea.value = texts[index];
        nav?.classList.remove('hidden');
        if (counter) counter.textContent = `${index + 1}/${texts.length}`;
    }

    function stepTextPreview(id, delta) {
        const node = state.nodes.get(id);
        if (!node) return;
        const texts = normalizeTextList(node.data?.texts);
        if (texts.length <= 1) return;
        node.textPreviewIndex = (getTextPreviewIndex(node, texts) + delta + texts.length) % texts.length;
        renderTextMultiPreview(id);
        scheduleSave();
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderImageImportUrlPreviewContent(imageUrl, message = '') {
        if (imageUrl) {
            return `
                <img src="${escapeHtml(imageUrl)}" alt="URL 图片预览" draggable="false" style="pointer-events: none;" loading="eager" decoding="async" fetchpriority="high" referrerpolicy="no-referrer" />
                <button type="button" class="image-import-url-refresh" title="重新加载预览" aria-label="重新加载 URL 图片预览">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
                </button>
            `;
        }
        return `<div class="drop-text">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            ${escapeHtml(message || '输入 URL 后自动显示预览')}
        </div>`;
    }

    function normalizeTextSplitOutputCountValue(value) {
        const parsed = parseInt(value ?? '1', 10);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
    }

    function sanitizeTextSplitOutputCountValue(value) {
        return String(value ?? '').replace(/\D/g, '');
    }

    function getTextSplitOutputCount(id) {
        const outputCountInput = documentRef.getElementById(`${id}-output-count`);
        const node = state.nodes.get(id);
        return normalizeTextSplitOutputCountValue(outputCountInput?.value ?? node?.data?.outputCount ?? 1);
    }

    function isTextSplitMergeOutputEnabled(id) {
        const mergeOutputInput = documentRef.getElementById(`${id}-merge-output-enabled`);
        const node = state.nodes.get(id);
        return mergeOutputInput ? mergeOutputInput.checked === true : node?.data?.mergeOutputEnabled === true;
    }

    function syncTextSplitOutputCountControlState(id, mergeOutputEnabled = isTextSplitMergeOutputEnabled(id)) {
        const outputCountInput = documentRef.getElementById(`${id}-output-count`);
        if (!outputCountInput) return;

        if (mergeOutputEnabled) {
            outputCountInput.value = '0';
        }
        outputCountInput.disabled = mergeOutputEnabled;
        const container = outputCountInput.closest('.text-split-output-count-control');
        container?.querySelectorAll('.text-split-output-count-btn').forEach((button) => {
            button.disabled = mergeOutputEnabled;
        });
    }

    function limitTextSplitParts(parts, outputCount) {
        return outputCount === 0 ? parts : parts.slice(0, Math.max(1, outputCount));
    }

    function getTextSplitRenderedOutputCount(parts, outputCount) {
        return outputCount === 0 ? Math.max(1, parts.length) : Math.max(1, outputCount);
    }

    function getCurrentTextSplitRenderedOutputCount(id) {
        const outputCount = getTextSplitOutputCount(id);
        if (outputCount > 0) return outputCount;
        const node = state.nodes.get(id);
        const parts = Array.isArray(node?.data?.parts) ? node.data.parts : [];
        return Math.max(1, parts.length);
    }

    function renderTextSplitOutputPort(id, index) {
        const portName = `part_${index + 1}`;
        return `<div class="node-port output" data-node-id="${id}" data-port="${portName}" data-type="text" data-direction="output">
                <span class="port-label">片段 ${index + 1}</span>
                <div class="port-dot type-text"></div>
            </div>`;
    }

    function renderTextSplitMergedOutputPort(id) {
        return `<div class="node-port output" data-node-id="${id}" data-port="text" data-type="text" data-direction="output">
                <span class="port-label">多文本输出</span>
                <div class="port-dot type-text"></div>
            </div>`;
    }

    function renderImageMergeInputPort(id, index) {
        const portName = `image_${index + 1}`;
        return `<div class="node-port input" data-node-id="${id}" data-port="${portName}" data-type="image" data-direction="input">
                <div class="port-dot type-image"></div>
                <span class="port-label">图片 ${index + 1}</span>
            </div>`;
    }

    function renderTextMergeInputPort(id, index) {
        const portName = `text_${index + 1}`;
        return `<div class="node-port input" data-node-id="${id}" data-port="${portName}" data-type="text" data-direction="input">
                <div class="port-dot type-text"></div>
                <span class="port-label">文本 ${index + 1}</span>
            </div>`;
    }

    function bindPortInteraction(portEl) {
        if (!portEl || portEl.dataset.bound === '1') return;
        portEl.dataset.bound = '1';
        const dot = portEl.querySelector('.port-dot');
        if (!dot) return;

        dot.addEventListener('mousedown', (e) => {
            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;
            e.stopPropagation();
            e.preventDefault();
            const nodeId = portEl.dataset.nodeId;
            if (blockRunningNodeMutation(nodeId, e, '节点正在运行，暂不能修改连线')) return;

            const tgt = {
                nodeId: portEl.dataset.nodeId,
                port: portEl.dataset.port,
                type: portEl.dataset.type,
                dir: portEl.dataset.direction
            };

            if (state.connecting) {
                state.connecting.lastAttemptedTarget = `${tgt.nodeId}:${tgt.port}:${tgt.dir}`;
                if (finishConnection(state.connecting, tgt)) {
                    state.connecting = null;
                    tempConnection.setAttribute('d', '');
                }
                return;
            }

            const existingInputConnection = portEl.dataset.direction === 'input'
                ? state.connections.find((connection) => (
                    connection.to.nodeId === portEl.dataset.nodeId &&
                    connection.to.port === portEl.dataset.port
                ))
                : null;

            if (existingInputConnection) {
                if (isNodeRunning(existingInputConnection.from.nodeId)) {
                    showToast('节点正在运行，暂不能修改连线', 'warning');
                    return;
                }

                const sourcePosition = getPortPosition(
                    existingInputConnection.from.nodeId,
                    existingInputConnection.from.port,
                    'output'
                );

                pushHistory();
                state.connections = state.connections.filter((connection) => connection.id !== existingInputConnection.id);
                syncAllCollapsedUnusedPorts();
                updateAllConnections();
                updatePortStyles();
                scheduleSave();
                onConnectionsChanged();

                state.connecting = {
                    nodeId: existingInputConnection.from.nodeId,
                    portName: existingInputConnection.from.port,
                    dataType: existingInputConnection.type || portEl.dataset.type,
                    isOutput: true,
                    startX: sourcePosition.x,
                    startY: sourcePosition.y,
                    screenX: e.clientX,
                    screenY: e.clientY,
                    dragged: false,
                    historyPushed: true,
                    rewiredFromConnection: {
                        id: existingInputConnection.id,
                        from: existingInputConnection.from,
                        to: existingInputConnection.to,
                        type: existingInputConnection.type
                    }
                };
                documentRef.body.classList.add('is-interacting');
                documentRef.getElementById('connections-group').classList.add('is-interacting');
                return;
            }

            const startPosition = getPortPosition(
                portEl.dataset.nodeId,
                portEl.dataset.port,
                portEl.dataset.direction
            );
            state.connecting = {
                nodeId: portEl.dataset.nodeId,
                portName: portEl.dataset.port,
                dataType: portEl.dataset.type,
                isOutput: portEl.dataset.direction === 'output',
                startX: startPosition.x,
                startY: startPosition.y,
                screenX: e.clientX,
                screenY: e.clientY,
                dragged: false
            };
            documentRef.body.classList.add('is-interacting');
        });

        dot.addEventListener('mouseup', (e) => {
            if (!state.connecting) return;
            e.stopPropagation();
            const nodeId = portEl.dataset.nodeId;
            if (blockRunningNodeMutation(nodeId, e, '节点正在运行，暂不能修改连线')) {
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
            const attemptedTarget = `${tgt.nodeId}:${tgt.port}:${tgt.dir}`;

            if (src.lastAttemptedTarget === attemptedTarget) {
                delete src.lastAttemptedTarget;
                return;
            }

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
    }

    function syncVideoGenerateProtocolFields(id) {
        const modelSelect = documentRef.getElementById(`${id}-apiconfig`);
        const providerSelect = documentRef.getElementById(`${id}-provider`);
        const aspectSelect = documentRef.getElementById(`${id}-aspect`);
        const sizeParamToggle = documentRef.getElementById(`${id}-use-size-param-toggle`);
        const enhanceField = documentRef.getElementById(`${id}-enhance-prompt-field`);
        const upsampleField = documentRef.getElementById(`${id}-enable-upsample-field`);
        const enhanceInput = documentRef.getElementById(`${id}-enhance-prompt`);
        const upsampleInput = documentRef.getElementById(`${id}-enable-upsample`);
        const doubaoResolutionField = documentRef.getElementById(`${id}-doubao-resolution-field`);
        const doubaoResolutionHint = documentRef.getElementById(`${id}-doubao-resolution-hint`);
        const doubaoDurationField = documentRef.getElementById(`${id}-doubao-duration-field`);
        const doubaoCameraFixedField = documentRef.getElementById(`${id}-doubao-camera-fixed-field`);
        const doubaoGenerateAudioField = documentRef.getElementById(`${id}-doubao-generate-audio-field`);
        const doubaoWatermarkField = documentRef.getElementById(`${id}-doubao-watermark-field`);
        const doubaoSeedField = documentRef.getElementById(`${id}-doubao-seed-field`);
        const doubaoNoteField = documentRef.getElementById(`${id}-doubao-note-field`);
        const doubaoResolutionInput = documentRef.getElementById(`${id}-doubao-resolution`);
        const doubaoDurationInput = documentRef.getElementById(`${id}-doubao-duration`);
        const doubaoDurationHint = documentRef.getElementById(`${id}-doubao-duration-hint`);
        const doubaoCameraFixedInput = documentRef.getElementById(`${id}-doubao-camera-fixed`);
        const doubaoGenerateAudioInput = documentRef.getElementById(`${id}-doubao-generate-audio`);
        const doubaoWatermarkInput = documentRef.getElementById(`${id}-doubao-watermark`);
        const doubaoSeedInput = documentRef.getElementById(`${id}-doubao-seed`);
        if (!modelSelect) return;
        const model = state.models.find((item) => item.id === modelSelect.value);
        const provider = model ? getResolvedProviderForModel(model, state.providers, providerSelect?.value || '') : null;
        const protocol = getEffectiveProtocol(model, provider);
        const meta = getVideoProtocolOptionMeta(protocol);
        const isDoubaoProtocol = protocol === 'doubao-video';
        const supportsSizeParamToggle = protocol === 'veo-unified' || protocol === 'veo-openai';
        const modelId = String(model?.modelId || '').toLowerCase();
        const supportsGenerateAudio = modelId.includes('seedance-1-5-pro');
        const referenceImageCount = state.connections.filter((item) => (
            item.to.nodeId === id && /^image_\d+$/.test(item.to.port)
        )).length;
        const isReferenceMode = referenceImageCount >= 1 || /^image_/i.test(modelId) || modelId.includes('i2v');
        const durationMin = modelId.includes('seedance-1-5-pro') ? 4 : 2;
        const durationMax = 12;

        if (sizeParamToggle) sizeParamToggle.classList.toggle('hidden', !supportsSizeParamToggle);
        if (enhanceField) enhanceField.classList.toggle('hidden', !meta.supportsEnhancePrompt);
        if (upsampleField) upsampleField.classList.toggle('hidden', !meta.supportsUpsample);
        if (doubaoResolutionField) doubaoResolutionField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoDurationField) doubaoDurationField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoCameraFixedField) doubaoCameraFixedField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoGenerateAudioField) doubaoGenerateAudioField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoWatermarkField) doubaoWatermarkField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoSeedField) doubaoSeedField.classList.toggle('hidden', !isDoubaoProtocol);
        if (doubaoNoteField) doubaoNoteField.classList.toggle('hidden', !isDoubaoProtocol);
        if (!meta.supportsEnhancePrompt && enhanceInput) enhanceInput.checked = false;
        if (!meta.supportsUpsample && upsampleInput) upsampleInput.checked = false;
        if (isDoubaoProtocol && aspectSelect) {
            const ratioOptions = DOUBAO_VIDEO_RATIO_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');
            const currentAspect = aspectSelect.value;
            aspectSelect.innerHTML = ratioOptions;
            aspectSelect.value = DOUBAO_VIDEO_RATIO_OPTIONS.some((option) => option.value === currentAspect) ? currentAspect : '16:9';
        } else if (aspectSelect) {
            const defaultOptions = VIDEO_ASPECT_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');
            const currentAspect = aspectSelect.value;
            aspectSelect.innerHTML = defaultOptions;
            aspectSelect.value = VIDEO_ASPECT_OPTIONS.some((option) => option.value === currentAspect) ? currentAspect : '16:9';
        }
        if (isDoubaoProtocol && doubaoResolutionInput) {
            doubaoResolutionInput.innerHTML = DOUBAO_VIDEO_RESOLUTION_OPTIONS
                .map((option) => `<option value="${option.value}">${option.label}</option>`)
                .join('');
            const currentResolution = doubaoResolutionInput.value;
            if (!DOUBAO_VIDEO_RESOLUTION_OPTIONS.some((option) => option.value === currentResolution)) {
                doubaoResolutionInput.value = modelId.includes('seedance-1-0-pro') || modelId.includes('seedance-1-0-pro-fast')
                    ? '1080p'
                    : '720p';
            }
            if (isReferenceMode && doubaoResolutionInput.value === '1080p') {
                doubaoResolutionInput.value = '720p';
            }
            if (doubaoResolutionHint) {
                doubaoResolutionHint.textContent = isReferenceMode
                    ? '当前是参考图场景，1080p 不可用，已限制为 480p / 720p'
                    : '当前模型可选 480p / 720p / 1080p';
            }
        } else if (doubaoResolutionHint) {
            doubaoResolutionHint.textContent = '';
        }
        if (isDoubaoProtocol && doubaoDurationInput) {
            doubaoDurationInput.min = String(durationMin);
            doubaoDurationInput.max = String(durationMax);
            let duration = parseInt(doubaoDurationInput.value || '5', 10);
            if (!Number.isFinite(duration)) duration = 5;
            duration = Math.max(durationMin, Math.min(durationMax, duration));
            doubaoDurationInput.value = String(duration);
            if (doubaoDurationHint) {
                doubaoDurationHint.textContent = `当前模型时长限制：${durationMin}-${durationMax} 秒`;
            }
        } else if (doubaoDurationHint) {
            doubaoDurationHint.textContent = '';
        }
        if (doubaoGenerateAudioInput) {
            doubaoGenerateAudioInput.disabled = !isDoubaoProtocol || !supportsGenerateAudio;
            if (isDoubaoProtocol && supportsGenerateAudio && !doubaoGenerateAudioInput.dataset.userTouched) {
                doubaoGenerateAudioInput.checked = true;
            }
            if (!supportsGenerateAudio) doubaoGenerateAudioInput.checked = false;
        }
        if (!isDoubaoProtocol && doubaoCameraFixedInput) doubaoCameraFixedInput.checked = false;
        if (!isDoubaoProtocol && doubaoGenerateAudioInput) doubaoGenerateAudioInput.checked = false;
        if (!isDoubaoProtocol && doubaoWatermarkInput) doubaoWatermarkInput.checked = false;
        if (!isDoubaoProtocol && doubaoSeedInput) doubaoSeedInput.value = '';
    }

    function bindNodePorts(container) {
        container?.querySelectorAll('.node-port').forEach((portEl) => bindPortInteraction(portEl));
    }

    function bindZoomSettleGuard(container) {
        if (!container) return;
        container.querySelectorAll('select, input, textarea, [contenteditable="true"]').forEach((control) => {
            if (!control || control.dataset.zoomSettleGuardBound === '1') return;
            control.dataset.zoomSettleGuardBound = '1';

            ['pointerdown', 'mousedown', 'touchstart', 'focus'].forEach((eventName) => {
                control.addEventListener(eventName, () => lockZoomSettleForControl(control), true);
            });
            ['change', 'blur'].forEach((eventName) => {
                control.addEventListener(eventName, flushPendingZoomVisualRefresh, true);
            });
        });
    }

    function closeNodeSelectDropdowns(exceptWrapper = null) {
        documentRef.querySelectorAll('.node-select').forEach((wrapper) => {
            if (exceptWrapper && wrapper === exceptWrapper) return;
            wrapper.classList.remove('open');
            wrapper.querySelector('.node-select-trigger')?.setAttribute('aria-expanded', 'false');
            wrapper.querySelector('.node-select-panel')?.classList.add('hidden');
        });
    }

    function renderCustomSelectOptions(selectEl, wrapper) {
        const trigger = wrapper.querySelector('.node-select-trigger');
        const panel = wrapper.querySelector('.node-select-panel');
        if (!trigger || !panel) return;

        const selectedOption = selectEl.selectedOptions?.[0] || selectEl.options?.[0] || null;
        trigger.querySelector('.node-select-trigger-label').textContent = selectedOption?.textContent || selectEl.value || '--';
        panel.innerHTML = Array.from(selectEl.options || []).map((option) => `
            <button
                type="button"
                class="node-select-option${option.selected ? ' selected' : ''}"
                data-value="${escapeHtml(option.value)}"
                ${option.disabled ? 'disabled' : ''}
            >${escapeHtml(option.textContent || option.value || '')}</button>
        `).join('');

        panel.querySelectorAll('.node-select-option').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (button.disabled) return;
                const nextValue = button.dataset.value || '';
                closeNodeSelectDropdowns();
                if (selectEl.value !== nextValue) {
                    selectEl.value = nextValue;
                    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }

    function ensureCustomNodeSelect(selectEl) {
        if (!selectEl || selectEl.dataset.customNodeSelectBound === '1') return;
        selectEl.dataset.customNodeSelectBound = '1';
        selectEl.classList.add('node-select-native');

        const wrapper = documentRef.createElement('div');
        wrapper.className = 'node-select';
        wrapper.innerHTML = `
            <button type="button" class="node-select-trigger" aria-expanded="false">
                <span class="node-select-trigger-label"></span>
                <span class="node-select-trigger-caret">▾</span>
            </button>
            <div class="node-select-panel hidden"></div>
        `;
        selectEl.insertAdjacentElement('afterend', wrapper);

        const trigger = wrapper.querySelector('.node-select-trigger');
        const panel = wrapper.querySelector('.node-select-panel');

        trigger?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const willOpen = panel?.classList.contains('hidden');
            closeNodeSelectDropdowns(willOpen ? wrapper : null);
            if (!panel) return;
            panel.classList.toggle('hidden', !willOpen);
            wrapper.classList.toggle('open', willOpen);
            trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });

        panel?.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });
        panel?.addEventListener('click', (event) => {
            event.stopPropagation();
        });
        panel?.addEventListener('wheel', (event) => {
            event.stopPropagation();
        }, { passive: true });

        selectEl.addEventListener('change', () => renderCustomSelectOptions(selectEl, wrapper));

        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => renderCustomSelectOptions(selectEl, wrapper));
            observer.observe(selectEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled', 'label', 'value'] });
            if (!Array.isArray(selectEl._cleanupFns)) {
                selectEl._cleanupFns = [];
            }
            selectEl._cleanupFns.push(() => observer.disconnect());
        }

        renderCustomSelectOptions(selectEl, wrapper);
    }

    function bindCustomNodeSelects(container) {
        if (!container) return;
        container.querySelectorAll('.node-field select').forEach((selectEl) => ensureCustomNodeSelect(selectEl));
        if (documentRef.body?.dataset.nodeSelectCloseBound !== '1') {
            documentRef.body.dataset.nodeSelectCloseBound = '1';
            documentRef.addEventListener('click', (event) => {
                if (event.target.closest('.node-select')) return;
                closeNodeSelectDropdowns();
            });
        }
    }

    function clonePlainValue(value) {
        if (value === undefined) return undefined;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }

    function getNodeControlSuffix(control, nodeId) {
        if (!control?.id || !control.id.startsWith(`${nodeId}-`)) return '';
        return control.id.slice(`${nodeId}-`.length);
    }

    function escapeCssIdent(value) {
        const cssRef = documentRef.defaultView?.CSS || globalThis.CSS;
        return cssRef?.escape ? cssRef.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    }

    function syncCloneNodeFromSource(cloneNode, sourceNode) {
        if (!cloneNode?.el || !sourceNode?.el) return;
        sourceNode.el.querySelectorAll('input[id], select[id], textarea[id]').forEach((sourceControl) => {
            const suffix = getNodeControlSuffix(sourceControl, sourceNode.id);
            if (!suffix) return;
            const cloneControl = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-${escapeCssIdent(suffix)}`);
            if (!cloneControl) return;
            if (sourceControl.type === 'checkbox') {
                cloneControl.checked = sourceControl.checked;
            } else {
                cloneControl.value = sourceControl.value;
            }
            const customWrapper = cloneControl.nextElementSibling?.classList?.contains('node-select')
                ? cloneControl.nextElementSibling
                : null;
            if (customWrapper) renderCustomSelectOptions(cloneControl, customWrapper);
        });

        cloneNode.providerId = sourceNode.providerId || '';
        cloneNode.customTitle = sourceNode.customTitle || '';
        const cloneTitle = cloneNode.el.querySelector('.node-title');
        const sourceTitle = sourceNode.el.querySelector('.node-title');
        if (cloneTitle && sourceTitle) cloneTitle.textContent = sourceTitle.textContent || cloneTitle.textContent;

        if (cloneNode.type === 'ImageImport') {
            cloneNode.importMode = sourceNode.importMode || 'upload';
            cloneNode.imageUrl = sourceNode.imageUrl || '';
            cloneNode.imageData = sourceNode.imageData || null;
            cloneNode.data = clonePlainValue(cloneNode.data || {});
            if (cloneNode.importMode === 'url') {
                cloneNode.data.image = cloneNode.imageUrl || '';
            } else if (cloneNode.imageData) {
                cloneNode.data.image = cloneNode.imageData;
            } else {
                delete cloneNode.data.image;
            }
        }

        if (cloneNode.type === 'Text') {
            cloneNode.data = clonePlainValue(cloneNode.data || {});
            cloneNode.data.text = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-text`)?.value || '';
        }

        if (cloneNode.type === 'TextSplit') {
            cloneNode.data = clonePlainValue(cloneNode.data || {});
            cloneNode.data.delimiter = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-delimiter`)?.value || '';
            const mergeOutputEnabled = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-merge-output-enabled`)?.checked === true;
            cloneNode.data.outputCount = normalizeTextSplitOutputCountValue(
                mergeOutputEnabled
                    ? 0
                    : (cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-output-count`)?.value ?? cloneNode.data.outputCount ?? 1)
            );
            cloneNode.data.removeEmptyLines = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-remove-empty-lines`)?.checked === true;
            cloneNode.data.previewEnabled = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-preview-enabled`)?.checked === true;
            cloneNode.data.mergeOutputEnabled = mergeOutputEnabled;
        }

        if (cloneNode.type === 'CameraControl') {
            cloneNode.data = clonePlainValue(cloneNode.data || {});
            cloneNode.data.pitch = Number(sourceNode.data?.pitch ?? cloneNode.data.pitch ?? 12);
            cloneNode.data.yaw = Number(sourceNode.data?.yaw ?? cloneNode.data.yaw ?? 28);
            cloneNode.data.distance = Number(sourceNode.data?.distance ?? cloneNode.data.distance ?? 6.5);
            cloneNode.data.fov = Number(sourceNode.data?.fov ?? cloneNode.data.fov ?? 50);
            cloneNode.data.roll = Number(sourceNode.data?.roll ?? cloneNode.data.roll ?? 0);
            cloneNode.data.text = String(sourceNode.data?.text ?? cloneNode.data.text ?? '');
            cloneNode.data.cameraPrompt = String(sourceNode.data?.cameraPrompt ?? cloneNode.data.text ?? '');
            cloneNode.data.cameraViewMode = sourceNode.data?.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
        }

        if (cloneNode.type === 'ImageImport') {
            const modeInput = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-import-mode`);
            const mode = cloneNode.importMode === 'url' ? 'url' : 'upload';
            if (modeInput) modeInput.value = mode;
            cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-upload-section`)?.classList.toggle('hidden', mode !== 'upload');
            cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-url-section`)?.classList.toggle('hidden', mode !== 'url');
            const drop = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-drop`);
            if (drop && mode === 'upload' && cloneNode.imageData) {
                drop.classList.add('has-image');
                drop.innerHTML = `<img src="${cloneNode.imageData}" alt="已导入图片" draggable="false" style="pointer-events: none;" />`;
            } else if (drop) {
                drop.classList.remove('has-image');
                drop.innerHTML = `<div class="drop-text">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    拖拽图片到此处
                </div>`;
            }
            const urlPreview = cloneNode.el.querySelector(`#${escapeCssIdent(cloneNode.id)}-url-preview`);
            if (urlPreview && mode === 'url' && cloneNode.imageUrl) {
                urlPreview.classList.add('has-image');
                urlPreview.innerHTML = renderImageImportUrlPreviewContent(cloneNode.imageUrl);
            } else if (urlPreview) {
                urlPreview.classList.remove('has-image');
                urlPreview.innerHTML = renderImageImportUrlPreviewContent('');
            }
        }
        if (cloneNode.type === 'Text') renderTextMultiPreview(cloneNode.id);
        if (cloneNode.type === 'TextSplit') syncTextSplitNodeData(cloneNode.id);
    }

    function syncClonesFromSource(sourceNodeId) {
        const sourceNode = state.nodes.get(sourceNodeId);
        if (!sourceNode || sourceNode.isClone) return;
        state.nodes.forEach((node) => {
            if (node?.isClone === true && node.cloneSourceId === sourceNodeId && node.type === sourceNode.type) {
                syncCloneNodeFromSource(node, sourceNode);
            }
        });
        updateAllConnections();
    }

    function lockCloneNodeEditing(id, el) {
        const node = state.nodes.get(id);
        if (!node?.isClone) return;
        el.querySelectorAll('.node-body input, .node-body select, .node-body textarea, .node-body button, .node-select-trigger').forEach((control) => {
            control.dataset.cloneLocked = '1';
            control.classList.add('clone-locked-control');
            if (control.tagName === 'TEXTAREA' || control.tagName === 'INPUT') {
                control.readOnly = true;
            }
            if (control.tagName === 'INPUT' || control.tagName === 'TEXTAREA' || control.tagName === 'SELECT' || control.tagName === 'BUTTON') {
                control.disabled = true;
            }
        });
        el.querySelectorAll('.node-body .toggle-switch').forEach((control) => {
            control.classList.add('clone-locked-control');
        });
    }

    function scrollToCloneSource(id) {
        const node = state.nodes.get(id);
        const source = node?.cloneSourceId ? state.nodes.get(node.cloneSourceId) : null;
        if (!source?.el) {
            showToast('源节点不存在，右键可将此克隆节点独立化', 'warning');
            return;
        }
        state.selectedNodes.forEach((nid) => {
            const selectedNode = state.nodes.get(nid);
            selectedNode?.el?.classList.remove('selected');
        });
        state.selectedNodes.clear();
        state.selectedNodes.add(source.id);
        source.el.classList.add('selected', 'clone-source-highlight');
        const containerRect = canvasContainer.getBoundingClientRect();
        const zoom = state.canvas.zoom || 1;
        const width = source.el.offsetWidth || source.width || 180;
        const height = source.el.offsetHeight || source.height || 120;
        state.canvas.x = (containerRect.width / 2) - ((source.x + width / 2) * zoom);
        state.canvas.y = (containerRect.height / 2) - ((source.y + height / 2) * zoom);
        viewportApi.updateCanvasTransform();
        setTimeout(() => source.el?.classList.remove('clone-source-highlight'), 1200);
        updateAllConnections();
    }

    function refreshTextSplitOutputPorts(nodeId, nextCount = getCurrentTextSplitRenderedOutputCount(nodeId)) {
        const node = state.nodes.get(nodeId);
        if (!node?.el) return;
        const outputsSection = node.el.querySelector('.node-outputs-section');
        if (!outputsSection) return;

        const currentPorts = Array.from(outputsSection.querySelectorAll('.node-port.output')).map((port) => port.dataset.port);
        const mergeOutputEnabled = isTextSplitMergeOutputEnabled(nodeId);
        const nextPorts = mergeOutputEnabled
            ? ['text']
            : Array.from({ length: nextCount }, (_, index) => `part_${index + 1}`);
        const unchanged = currentPorts.length === nextPorts.length && currentPorts.every((port, index) => port === nextPorts[index]);
        if (unchanged) return;

        outputsSection.innerHTML = mergeOutputEnabled
            ? renderTextSplitMergedOutputPort(nodeId)
            : nextPorts.map((_, index) => renderTextSplitOutputPort(nodeId, index)).join('');
        bindNodePorts(outputsSection);
        bindZoomSettleGuard(outputsSection);

        const validPortSet = new Set(nextPorts);
        const beforeConnectionCount = state.connections.length;
        state.connections = state.connections.filter((connection) => (
            connection.from.nodeId !== nodeId || validPortSet.has(connection.from.port)
        ));
        const removedConnections = beforeConnectionCount !== state.connections.length;
        syncCollapsedUnusedPorts(nodeId);
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        scheduleSave();
    }

    function getImageMergeConnectedInputCount(nodeId) {
        const indices = state.connections
            .filter((connection) => connection.to.nodeId === nodeId && /^image_\d+$/.test(connection.to.port))
            .map((connection) => parseInt(connection.to.port.replace('image_', ''), 10))
            .filter((index) => Number.isFinite(index) && index > 0);
        return indices.length > 0 ? Math.max(...indices) : 0;
    }

    function getTextMergeConnectedInputCount(nodeId) {
        const indices = state.connections
            .filter((connection) => connection.to.nodeId === nodeId && /^text_\d+$/.test(connection.to.port))
            .map((connection) => parseInt(connection.to.port.replace('text_', ''), 10))
            .filter((index) => Number.isFinite(index) && index > 0);
        return indices.length > 0 ? Math.max(...indices) : 0;
    }

    function refreshImageMergeInputPorts(nodeId, nextCount = getImageMergeConnectedInputCount(nodeId) + 1) {
        const node = state.nodes.get(nodeId);
        if (!node?.el || node.type !== 'ImageMerge') return;
        const inputsSection = node.el.querySelector('.node-inputs-section');
        if (!inputsSection) return;

        const nextPorts = Array.from({ length: Math.max(1, nextCount) }, (_, index) => `image_${index + 1}`);
        node.data = node.data || {};
        node.data.inputCount = nextPorts.length;

        const summary = documentRef.getElementById(`${nodeId}-merge-summary`);
        const connectedCount = state.connections.filter((connection) => (
            connection.to.nodeId === nodeId &&
            nextPorts.includes(connection.to.port)
        )).length;
        if (summary) {
            summary.textContent = connectedCount > 0
                ? `已接入 ${connectedCount} 路图片，输出为 ${connectedCount} 路合并后的多图数据`
                : '连接多个图片输入后，输出合并后的多图数据';
        }

        const currentPorts = Array.from(inputsSection.querySelectorAll('.node-port.input')).map((port) => port.dataset.port);
        const unchanged = currentPorts.length === nextPorts.length && currentPorts.every((port, index) => port === nextPorts[index]);
        if (unchanged) return;

        inputsSection.innerHTML = nextPorts.map((_, index) => renderImageMergeInputPort(nodeId, index)).join('');
        bindNodePorts(inputsSection);
        bindZoomSettleGuard(inputsSection);

        const validPortSet = new Set(nextPorts);
        const beforeConnectionCount = state.connections.length;
        state.connections = state.connections.filter((connection) => (
            connection.to.nodeId !== nodeId || validPortSet.has(connection.to.port)
        ));
        const removedConnections = beforeConnectionCount !== state.connections.length;
        syncCollapsedUnusedPorts(nodeId);
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        scheduleSave();
    }

    function refreshTextMergeInputPorts(nodeId, nextCount = getTextMergeConnectedInputCount(nodeId) + 1) {
        const node = state.nodes.get(nodeId);
        if (!node?.el || node.type !== 'TextMerge') return;
        const inputsSection = node.el.querySelector('.node-inputs-section');
        if (!inputsSection) return;

        const nextPorts = Array.from({ length: Math.max(1, nextCount) }, (_, index) => `text_${index + 1}`);
        node.data = node.data || {};
        node.data.inputCount = nextPorts.length;

        const summary = documentRef.getElementById(`${nodeId}-merge-summary`);
        const connectedCount = state.connections.filter((connection) => (
            connection.to.nodeId === nodeId &&
            nextPorts.includes(connection.to.port)
        )).length;
        if (summary) {
            summary.textContent = connectedCount > 0
                ? `已接入 ${connectedCount} 路文本，输出为 ${connectedCount} 路合并后的多文本数据`
                : '连接多个文本输入后，输出合并后的多文本数据';
        }

        const currentPorts = Array.from(inputsSection.querySelectorAll('.node-port.input')).map((port) => port.dataset.port);
        const unchanged = currentPorts.length === nextPorts.length && currentPorts.every((port, index) => port === nextPorts[index]);
        if (unchanged) return;

        inputsSection.innerHTML = nextPorts.map((_, index) => renderTextMergeInputPort(nodeId, index)).join('');
        bindNodePorts(inputsSection);
        bindZoomSettleGuard(inputsSection);

        const validPortSet = new Set(nextPorts);
        const beforeConnectionCount = state.connections.length;
        state.connections = state.connections.filter((connection) => (
            connection.to.nodeId !== nodeId || validPortSet.has(connection.to.port)
        ));
        const removedConnections = beforeConnectionCount !== state.connections.length;
        syncCollapsedUnusedPorts(nodeId);
        updateAllConnections();
        updatePortStyles();
        if (removedConnections) onConnectionsChanged();
        scheduleSave();
    }

    function syncImageMergeNodes() {
        state.nodes.forEach((node, nodeId) => {
            if (node.type === 'ImageMerge') refreshImageMergeInputPorts(nodeId);
            if (node.type === 'TextMerge') refreshTextMergeInputPorts(nodeId);
        });
    }

    function toggleNodeCollapsed(id) {
        const node = state.nodes.get(id);
        if (!node?.el) return;
        if (isNodeRunning(id)) {
            showToast('节点正在运行，暂不能折叠或展开', 'warning');
            return;
        }

        const body = node.el.querySelector('.node-body');
        if (!body) return;

        const currentHeight = node.el.offsetHeight || Number(node.height) || 0;
        const nextCollapsed = !node.collapsed;
        if (!nextCollapsed && Number.isFinite(node.collapsedExpandedHeight) && node.collapsedExpandedHeight > 0) {
            node.el.style.height = `${Math.round(node.collapsedExpandedHeight)}px`;
            node.height = Math.round(node.collapsedExpandedHeight);
            node.observedHeight = Math.round(node.collapsedExpandedHeight);
        } else if (currentHeight > 0) {
            node.collapsedExpandedHeight = currentHeight;
        }

        node.collapsed = nextCollapsed;
        node.el.classList.toggle('collapsed', nextCollapsed);
        body.classList.toggle('is-collapsed', nextCollapsed);
        syncCollapsedUnusedPorts(id);
        const collapseButton = node.el.querySelector('.node-collapse-btn');
        if (collapseButton) {
            collapseButton.classList.toggle('is-collapsed', nextCollapsed);
            collapseButton.title = nextCollapsed ? '展开节点' : '折叠节点';
            collapseButton.setAttribute('aria-label', nextCollapsed ? '展开节点' : '折叠节点');
            collapseButton.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
        }

        const minimum = typeof getNodeMinimumSizeFromLifecycle === 'function'
            ? getNodeMinimumSizeFromLifecycle(node)
            : {
                minWidth: Number(node?.defaultWidth) || 180,
                minHeight: Number(node?.defaultHeight) || 120
            };
        const currentWidth = node.el.offsetWidth || Number(node.width) || minimum.minWidth;
        const currentMeasuredHeight = node.el.offsetHeight || Number(node.height) || minimum.minHeight;
        const nextHeight = nextCollapsed
            ? minimum.minHeight
            : Math.max(currentMeasuredHeight, minimum.minHeight);

        node.el.style.height = `${Math.round(nextHeight)}px`;
        node.width = Math.round(currentWidth);
        node.height = Math.round(nextHeight);
        node.observedWidth = Math.round(currentWidth);
        node.observedHeight = Math.round(nextHeight);

        updateAllConnections();
        updatePortStyles();
        const requestFrame = documentRef.defaultView?.requestAnimationFrame;
        if (typeof requestFrame === 'function') {
            requestFrame(() => {
                syncCollapsedUnusedPorts(id);
                updateAllConnections();
                updatePortStyles();
            });
        }
        scheduleSave();
    }

    function syncTextSplitNodeData(id, options = {}) {
        const { refreshPorts = true } = options;
        const node = state.nodes.get(id);
        const delimiterInput = documentRef.getElementById(`${id}-delimiter`);
        const outputCountInput = documentRef.getElementById(`${id}-output-count`);
        const removeEmptyLinesInput = documentRef.getElementById(`${id}-remove-empty-lines`);
        const previewEnabledInput = documentRef.getElementById(`${id}-preview-enabled`);
        const mergeOutputEnabledInput = documentRef.getElementById(`${id}-merge-output-enabled`);
        if (!node || !delimiterInput) return;

        const outputCount = getTextSplitOutputCount(id);
        if (outputCountInput) {
            outputCountInput.value = String(outputCount);
        }
        const removeEmptyLines = removeEmptyLinesInput?.checked === true;
        const previewEnabled = previewEnabledInput?.checked === true;
        const mergeOutputEnabled = mergeOutputEnabledInput?.checked === true;
        syncTextSplitOutputCountControlState(id, mergeOutputEnabled);
        const effectiveOutputCount = mergeOutputEnabled ? 0 : outputCount;
        if (outputCountInput) {
            outputCountInput.value = String(effectiveOutputCount);
        }
        const rawParts = splitTextForTextSplitNode(node.data?.text || '', delimiterInput.value, { removeEmptyLines });
        const parts = limitTextSplitParts(rawParts, effectiveOutputCount);
        const renderedOutputCount = getTextSplitRenderedOutputCount(parts, effectiveOutputCount);
        node.data.delimiter = delimiterInput.value;
        node.data.outputCount = effectiveOutputCount;
        node.data.removeEmptyLines = removeEmptyLines;
        node.data.previewEnabled = previewEnabled;
        node.data.mergeOutputEnabled = mergeOutputEnabled;
        node.data.parts = parts;
        node.data.texts = mergeOutputEnabled ? parts.slice() : [];
        if (!mergeOutputEnabled) delete node.data.texts;
        Object.keys(node.data).forEach((key) => {
            if (/^part_\d+$/.test(key)) delete node.data[key];
        });
        parts.forEach((part, index) => {
            node.data[`part_${index + 1}`] = part;
        });

        const summary = documentRef.getElementById(`${id}-split-summary`);
        if (summary) {
            const delimiterText = delimiterInput.value
                ? `按 ${JSON.stringify(delimiterInput.value)} 分割`
                : '未设置分隔字符串，整段作为一个输出';
            const emptyLineText = removeEmptyLines ? '，已删除空行' : '';
            const outputText = effectiveOutputCount === 0
                ? `，自动生成 ${renderedOutputCount} 个输出端口`
                : `，当前配置 ${effectiveOutputCount} 个输出端口`;
            const mergeText = mergeOutputEnabled ? '，多合一输出为 1 个端口' : outputText;
            summary.textContent = `${delimiterText}${emptyLineText}${mergeText}`;
        }

        const preview = documentRef.getElementById(`${id}-split-preview`);
        if (preview) {
            preview.classList.toggle('hidden', !previewEnabled);
            preview.innerHTML = parts.length > 0
                ? parts.map((part, index) => `
                    <div class="text-split-preview-item">
                        <div class="text-split-preview-label">片段 ${index + 1}</div>
                        <pre class="text-split-preview-text">${escapeHtml(part)}</pre>
                    </div>
                `).join('')
                : '<div class="text-split-preview-empty">运行后显示分割结果</div>';
        }

        if (refreshPorts) {
            refreshTextSplitOutputPorts(id, renderedOutputCount);
        }

        const requestFrame = documentRef.defaultView?.requestAnimationFrame;
        const scheduleFit = () => {
            if (state.resizing?.nodeId === id) return;
            fitNodeToContent(id);
        };
        if (typeof requestFrame === 'function') {
            requestFrame(() => {
                scheduleFit();
                documentRef.defaultView?.setTimeout(scheduleFit, 80);
            });
        } else {
            scheduleFit();
        }
    }

    function getRememberedNodeDefault(type) {
        if (type !== 'ImageGenerate' && type !== 'VideoGenerate' && type !== 'TextChat' && type !== 'CameraControl') return null;
        if (!state.nodeDefaults || typeof state.nodeDefaults !== 'object') {
            state.nodeDefaults = {};
        }
        if (!state.nodeDefaults[type] || typeof state.nodeDefaults[type] !== 'object') {
            state.nodeDefaults[type] = type === 'CameraControl'
                ? { pitch: 12, yaw: 28, distance: 6.5, fov: 50, roll: 0, cameraViewMode: 'firstPerson' }
                : { apiConfigId: '', providerId: '' };
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
            providerField.classList.toggle('hidden', modelProviders.length === 0);
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
        if (type === 'CameraControl') {
            const node = state.nodes.get(id);
            defaults.pitch = Number(node?.data?.pitch ?? defaults.pitch ?? 12);
            defaults.yaw = Number(node?.data?.yaw ?? defaults.yaw ?? 28);
            defaults.distance = Number(node?.data?.distance ?? defaults.distance ?? 6.5);
            defaults.fov = Number(node?.data?.fov ?? defaults.fov ?? 50);
            defaults.roll = Number(node?.data?.roll ?? defaults.roll ?? 0);
            defaults.cameraViewMode = node?.data?.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
            return;
        }
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

    function bindNodeRunCancelButton(id, el) {
        const button = el.querySelector('.node-run-cancel-btn');
        if (!button || button.dataset.bound === '1') return;
        button.dataset.bound = '1';

        let holdTimer = null;
        let activePointerId = null;
        let startX = 0;
        let startY = 0;
        let didTriggerCancel = false;

        const clearHoldTimer = () => {
            if (holdTimer !== null) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
        };

        const releasePointer = () => {
            const pointerId = activePointerId;
            activePointerId = null;
            if (pointerId !== null && button.hasPointerCapture?.(pointerId)) {
                button.releasePointerCapture(pointerId);
            }
        };

        const resetHold = ({ keepCanceling = false } = {}) => {
            clearHoldTimer();
            button.classList.remove('is-holding');
            if (!keepCanceling) button.classList.remove('is-canceling');
            releasePointer();
        };

        button.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            if (!isNodeRunning(id)) return;

            event.preventDefault();
            event.stopPropagation();

            clearHoldTimer();
            activePointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            didTriggerCancel = false;

            button.classList.remove('is-canceling', 'is-holding');
            void button.offsetWidth;
            button.classList.add('is-holding');
            button.setPointerCapture?.(event.pointerId);

            holdTimer = setTimeout(() => {
                holdTimer = null;
                if (!isNodeRunning(id)) {
                    resetHold();
                    return;
                }
                didTriggerCancel = true;
                button.classList.remove('is-holding');
                button.classList.add('is-canceling');

                const handled = typeof cancelRunningNode === 'function'
                    ? cancelRunningNode(id)
                    : false;
                if (!handled) {
                    button.classList.remove('is-canceling');
                    showToast('这个节点当前没有可取消的运行任务', 'warning');
                }
            }, NODE_CANCEL_HOLD_MS);
        });

        button.addEventListener('pointermove', (event) => {
            if (activePointerId === null || event.pointerId !== activePointerId || didTriggerCancel) return;
            const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
            if (distance > NODE_CANCEL_DRAG_THRESHOLD) {
                resetHold();
            }
        });

        const endPointerHold = (event) => {
            if (activePointerId !== null && event.pointerId !== activePointerId) return;
            event.preventDefault();
            event.stopPropagation();
            resetHold({ keepCanceling: didTriggerCancel });
        };

        button.addEventListener('pointerup', endPointerHold);
        button.addEventListener('pointercancel', endPointerHold);
        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        button.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
    }

    function bindExpandableElementResize(nodeId, element) {
        if (!element || typeof ResizeObserver === 'undefined') return;
        const node = state.nodes.get(nodeId);
        if (node?.type === 'Text' || node?.type === 'TextSplit') return;

        let frameId = null;
        const scheduleFit = () => {
            if (state.resizing?.nodeId === nodeId) return;
            if (frameId !== null) return;
            frameId = requestAnimationFrame(() => {
                frameId = null;
                if (state.resizing?.nodeId === nodeId) return;
                fitNodeToContent(nodeId, { reason: 'element-resize' });
            });
        };

        const observer = new ResizeObserver(() => scheduleFit());
        observer.observe(element);

        if (!Array.isArray(element._cleanupFns)) {
            element._cleanupFns = [];
        }
        element._cleanupFns.push(() => {
            observer.disconnect();
            if (frameId !== null) cancelAnimationFrame(frameId);
        });

        setTimeout(scheduleFit, 0);
    }

    function bindTextareaHeightPersistence(element) {
        if (!element || element.dataset.heightPersistenceBound === '1' || typeof ResizeObserver === 'undefined') return;
        element.dataset.heightPersistenceBound = '1';

        let observedHeight = Math.round(element.offsetHeight || 0);
        let frameId = null;
        const observer = new ResizeObserver(() => {
            const nextHeight = Math.round(element.offsetHeight || 0);
            if (!nextHeight || Math.abs(nextHeight - observedHeight) <= 1) return;
            observedHeight = nextHeight;
            const nodeEl = element.closest('.node');
            const nodeId = nodeEl?.dataset?.id;
            if (nodeId && state.resizing?.nodeId === nodeId) return;
            if (frameId !== null) return;
            frameId = requestAnimationFrame(() => {
                frameId = null;
                if (nodeId && state.resizing?.nodeId === nodeId) return;
                if (nodeId) fitNodeToContent(nodeId, { reason: 'textarea-resize' });
                scheduleSave();
            });
        });
        observer.observe(element);

        if (!Array.isArray(element._cleanupFns)) {
            element._cleanupFns = [];
        }
        element._cleanupFns.push(() => {
            observer.disconnect();
            if (frameId !== null) cancelAnimationFrame(frameId);
        });
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
        const protocol = getEffectiveProtocol(model, provider);
        const isOpenAiModel = protocol === 'openai';
        const isNewApiAsyncImage = protocol === 'newapi-image-async';
        updateImageGenerateAspectVisibility(id, isOpenAiModel, isNewApiAsyncImage);
        updateImageGenerateQualityVisibility(id, isOpenAiModel, isNewApiAsyncImage);
        updateImageGenerateOpenAiExtraVisibility(id, isOpenAiModel, isNewApiAsyncImage);
        updateImageGenerateMaskPortVisibility(id, isOpenAiModel && !isNewApiAsyncImage);
        updateImageGenerateResolutionParamNote(id, isOpenAiModel);
        updateImageGenerateAsyncFieldsVisibility(id, isNewApiAsyncImage, isOpenAiModel);
        updateImageGenerateCustomResolutionVisibility(id);
    }

    function updateImageGenerateAspectVisibility(id, isOpenAiModel, isNewApiAsyncImage = false) {
        const aspectField = documentRef.getElementById(`${id}-aspect-field`);
        if (!aspectField) return;
        aspectField.classList.toggle('hidden', isOpenAiModel && !isNewApiAsyncImage);
    }

    function updateImageGenerateQualityVisibility(id, isOpenAiModel, isNewApiAsyncImage = false) {
        const qualityField = documentRef.getElementById(`${id}-quality-field`);
        if (!qualityField) return;
        qualityField.classList.toggle('hidden', !isOpenAiModel || isNewApiAsyncImage);
    }

    function updateImageGenerateOpenAiExtraVisibility(id, isOpenAiModel, isNewApiAsyncImage = false) {
        [
            `${id}-moderation-field`,
            `${id}-background-field`
        ].forEach((fieldId) => {
            const field = documentRef.getElementById(fieldId);
            if (field) field.classList.toggle('hidden', !isOpenAiModel || isNewApiAsyncImage);
        });
    }

    function updateImageGenerateMaskPortVisibility(id, shouldShow) {
        const maskPort = documentRef.querySelector(`.node-port[data-node-id="${id}"][data-port="mask"][data-direction="input"]`);
        if (!maskPort) return;
        const wasHidden = maskPort.classList.contains('hidden');
        maskPort.classList.toggle('hidden', !shouldShow);
        maskPort.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
        if (wasHidden !== !shouldShow) {
            updateAllConnections();
            updatePortStyles();
        }
    }

    function updateImageGenerateResolutionParamNote(id, isOpenAiModel) {
        const note = documentRef.getElementById(`${id}-resolution-param-note`);
        if (!note) return;
        note.classList.toggle('hidden', !isOpenAiModel);
    }

    function updateImageGenerateAsyncFieldsVisibility(id, isNewApiAsyncImage, isOpenAiModel = false) {
        [
            `${id}-image-async-result-field`,
            `${id}-resume-image-id-field`,
            `${id}-resume-image-field`
        ].forEach((fieldId) => {
            const field = documentRef.getElementById(fieldId);
            if (field) field.classList.toggle('hidden', !isNewApiAsyncImage);
        });
        const searchField = documentRef.getElementById(`${id}-search-field`);
        if (searchField) searchField.classList.toggle('hidden', isOpenAiModel || isNewApiAsyncImage);
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
        const count = normalizeImageGenerateCountValue(input.value);
        input.value = String(count);

        const node = state.nodes.get(id);
        if (node) {
            node.generationCount = count;
            node.data.generationCount = count;
        }

        const progressEl = documentRef.getElementById(`${id}-generation-progress`);
        if (progressEl) {
            const completedCount = Math.max(0, parseInt(node?.generationCompletedCount || '0', 10) || 0);
            progressEl.textContent = `${Math.min(completedCount, count)}/${count}`;
            progressEl.classList.remove('hidden');
        }
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

    function collectNodeTextareaResizeTargets(el) {
        const body = el?.querySelector?.('.node-body');
        if (!body) return [];
        return Array.from(body.querySelectorAll('textarea'))
            .filter(isVisibleElement)
            .map((textarea) => {
                const style = getComputedStyle(textarea);
                const minHeight = getPx(style, 'min-height');
                const measuredHeight = textarea.getBoundingClientRect?.().height ||
                    textarea.offsetHeight ||
                    parseFloat(textarea.style.height || '0') ||
                    minHeight;
                const startHeight = Math.max(minHeight, measuredHeight || 0);
                return {
                    el: textarea,
                    startHeight,
                    minHeight,
                    weight: Math.max(1, startHeight)
                };
            })
            .filter((target) => target.startHeight > 0);
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

        if (el.classList.contains('text-split-preview')) {
            return Math.ceil(minHeight + marginY);
        }

        if (el.classList.contains('chat-response-wrapper') || el.classList.contains('chat-response-area')) {
            return Math.ceil(minHeight + marginY);
        }

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

    function bindNodeInteractions({ id, type, el }) {
        el.addEventListener('mousedown', (e) => {
            const target = e.target;

            if (target.closest('.node-delete, .node-bypass-btn')) return;

            const interactiveSelector = 'input, textarea, select, button, .node-select, .port, .node-resize-handle, [contenteditable="true"], .chat-response-area, .preview-controls, .workflow-action-btn, .preview-container, .save-preview-container, .file-drop-zone';
            const isInteractive = target.closest(interactiveSelector);

            const dragAreaSelector = '.node-header, .node-glass-bg';
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
            const {
                internalConnections,
                externalConnections
            } = collectConnectionSnapshotsForNodes(state, nodesToDrag);

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
                cloned: false,
                internalConnections,
                externalConnections
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

        el.querySelector('.node-header')?.addEventListener('dblclick', (e) => {
            if (e.target.closest('.node-delete, .node-bypass-btn, .node-collapse-btn')) return;
            e.preventDefault();
            e.stopPropagation();
            toggleNodeCollapsed(id);
        });

        el.querySelector('.node-collapse-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleNodeCollapsed(id);
        });

        el.querySelector('.node-clone-badge')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            scrollToCloneSource(id);
        });

        el.querySelector('.node-resize-handle').addEventListener('mousedown', (e) => {
            const isPanAction = e.button === 1 || (e.button === 0 && e.altKey);
            if (isPanAction) return;
            e.stopPropagation();
            e.preventDefault();
            if (blockRunningNodeMutation(id, e, '节点正在运行，暂不能调整大小')) return;
            const node = state.nodes.get(id);
            const defaultMinimum = typeof getNodeMinimumSizeFromLifecycle === 'function'
                ? getNodeMinimumSizeFromLifecycle(node)
                : {
                    minWidth: Number(node?.defaultWidth) || 180,
                    minHeight: Number(node?.defaultHeight) || 120
                };
            const currentWidth = el.offsetWidth || Number(node?.width) || defaultMinimum.minWidth;
            const currentHeight = el.offsetHeight || Number(node?.height) || defaultMinimum.minHeight;

            state.resizing = {
                nodeId: id,
                startX: e.clientX,
                startY: e.clientY,
                startWidth: currentWidth,
                startHeight: currentHeight,
                minWidth: defaultMinimum.minWidth,
                minHeight: defaultMinimum.minHeight,
                maxHeight: node?.maxHeight || null,
                textareaResizeTargets: collectNodeTextareaResizeTargets(el)
            };

            pushHistory();
            el.classList.add('is-interacting');
            documentRef.body.classList.add('is-interacting');
            documentRef.getElementById('connections-group').classList.add('is-interacting');
        });

        el.querySelector('.node-resize-handle').addEventListener('mouseup', () => {
            if (state.resizing?.nodeId === id) return;
            enforceNodeContentMinimum(id, { save: false, updateConnections: true });
        });

        bindNodeRunCancelButton(id, el);
        bindNodePorts(el);
        bindZoomSettleGuard(el);
        bindCustomNodeSelects(el);
        lockCloneNodeEditing(id, el);
        syncCollapsedUnusedPorts(id);

        if (type === 'ImageImport') setupImageImport(id, el);
        else if (type === 'Text') {
            renderTextMultiPreview(id);
            el.querySelectorAll('.text-multi-nav-btn').forEach((button) => {
                button.addEventListener('click', (event) => {
                    event.stopPropagation();
                    stepTextPreview(id, parseInt(button.dataset.direction || '0', 10) || 0);
                });
            });
        }
        else if (type === 'ImageGenerate') {
            syncImageGenerateResolutionOptions(id);
            const modelSelect = el.querySelector(`#${id}-apiconfig`);
            modelSelect?.addEventListener('change', () => {
                syncImageGenerateResolutionOptions(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id);
            });
            const providerSelect = el.querySelector(`#${id}-provider`);
            providerSelect?.addEventListener('change', () => {
                syncImageGenerateResolutionOptions(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id);
            });
            const resolutionSelect = el.querySelector(`#${id}-resolution`);
            resolutionSelect?.addEventListener('change', () => {
                updateImageGenerateCustomResolutionVisibility(id);
                fitNodeToContent(id);
            });
            const customWidthInput = el.querySelector(`#${id}-custom-resolution-width`);
            const customHeightInput = el.querySelector(`#${id}-custom-resolution-height`);
            const syncCustomResolutionValidation = () => {
                updateImageGenerateCustomResolutionValidation(id);
                fitNodeToContent(id);
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
            const resumeIdInput = el.querySelector(`#${id}-resume-image-id`);
            const resumeBtn = el.querySelector(`#${id}-resume-image`);
            const syncResumeButtonState = () => {
                if (!resumeBtn) return;
                const value = String(resumeIdInput?.value || '').trim();
                resumeBtn.disabled = !value;
            };
            resumeIdInput?.addEventListener('input', () => {
                const node = state.nodes.get(id);
                if (node) {
                    node.data = node.data || {};
                    node.data.imageTaskId = String(resumeIdInput.value || '').trim();
                }
                syncResumeButtonState();
            });
            resumeIdInput?.addEventListener('change', () => {
                const node = state.nodes.get(id);
                if (node) {
                    node.data = node.data || {};
                    node.data.imageTaskId = String(resumeIdInput.value || '').trim();
                }
                syncResumeButtonState();
                scheduleSave();
            });
            resumeBtn?.addEventListener('click', async () => {
                const node = state.nodes.get(id);
                const imageTaskId = String(resumeIdInput?.value || node?.data?.imageTaskId || '').trim();
                if (!imageTaskId) {
                    showToast('当前节点没有可恢复的任务 ID', 'warning');
                    return;
                }
                if (node) {
                    node.data = node.data || {};
                    node.data.imageTaskId = imageTaskId;
                }
                try {
                    resumeBtn.disabled = true;
                    await resumeImageGeneration(id);
                } catch (error) {
                    showToast(error?.message || '恢复图片进度失败', 'error');
                } finally {
                    syncResumeButtonState();
                }
            });
            syncResumeButtonState();
            syncImageGenerateCount(id);
            fitNodeToContent(id);
        }
        else if (type === 'VideoGenerate') {
            syncNodeProviderOptions(id, type);
            syncVideoGenerateProtocolFields(id);
            const modelSelect = el.querySelector(`#${id}-apiconfig`);
            modelSelect?.addEventListener('change', () => {
                syncNodeProviderOptions(id, type);
                syncVideoGenerateProtocolFields(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id);
            });
            const providerSelect = el.querySelector(`#${id}-provider`);
            providerSelect?.addEventListener('change', () => {
                syncNodeProviderOptions(id, type);
                syncVideoGenerateProtocolFields(id);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id);
            });
            const generationCountInput = el.querySelector(`#${id}-generation-count`);
            const doubaoDurationInput = el.querySelector(`#${id}-doubao-duration`);
            const doubaoGenerateAudioInput = el.querySelector(`#${id}-doubao-generate-audio`);
            const doubaoResolutionInput = el.querySelector(`#${id}-doubao-resolution`);
            const syncGenerationCount = () => syncImageGenerateCount(id);
            generationCountInput?.addEventListener('input', () => {
                if (generationCountInput.value !== '' && normalizeImageGenerateCountValue(generationCountInput.value) !== Number(generationCountInput.value)) {
                    syncImageGenerateCount(id);
                }
            });
            generationCountInput?.addEventListener('change', syncGenerationCount);
            generationCountInput?.addEventListener('blur', syncGenerationCount);
            const normalizeDoubaoDuration = () => {
                if (!doubaoDurationInput) return;
                const min = parseInt(doubaoDurationInput.min || '2', 10) || 2;
                const max = parseInt(doubaoDurationInput.max || '12', 10) || 12;
                if (doubaoDurationInput.value === '') {
                    doubaoDurationInput.value = String(min);
                } else {
                    const value = parseInt(doubaoDurationInput.value, 10);
                    const normalizedValue = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
                    doubaoDurationInput.value = String(normalizedValue);
                }
                syncVideoGenerateProtocolFields(id);
                fitNodeToContent(id);
            };
            doubaoDurationInput?.addEventListener('change', normalizeDoubaoDuration);
            doubaoDurationInput?.addEventListener('blur', normalizeDoubaoDuration);
            doubaoGenerateAudioInput?.addEventListener('change', () => {
                doubaoGenerateAudioInput.dataset.userTouched = '1';
            });
            doubaoResolutionInput?.addEventListener('change', () => {
                syncVideoGenerateProtocolFields(id);
                fitNodeToContent(id);
            });
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
            const downloadBtn = el.querySelector(`#${id}-download-video`);
            const resumeIdInput = el.querySelector(`#${id}-resume-video-id`);
            const resumeBtn = el.querySelector(`#${id}-resume-video`);
            const syncResumeButtonState = () => {
                if (!resumeBtn) return;
                const value = String(resumeIdInput?.value || '').trim();
                resumeBtn.disabled = !value;
            };
            downloadBtn?.addEventListener('click', () => {
                const node = state.nodes.get(id);
                const url = node?.data?.videoUrl || '';
                if (!url) {
                    showToast('当前还没有可下载的视频结果', 'warning');
                    return;
                }
                documentRef.defaultView?.open(url, '_blank', 'noopener,noreferrer');
            });
            resumeIdInput?.addEventListener('input', () => {
                const node = state.nodes.get(id);
                if (node) {
                    node.data = node.data || {};
                    node.data.videoId = String(resumeIdInput.value || '').trim();
                }
                syncResumeButtonState();
            });
            resumeIdInput?.addEventListener('change', () => {
                const node = state.nodes.get(id);
                if (node) {
                    node.data = node.data || {};
                    node.data.videoId = String(resumeIdInput.value || '').trim();
                }
                syncResumeButtonState();
                scheduleSave();
            });
            resumeBtn?.addEventListener('click', async () => {
                const node = state.nodes.get(id);
                const videoId = String(resumeIdInput?.value || node?.data?.videoId || '').trim();
                if (!videoId) {
                    showToast('当前节点没有可恢复的任务 ID', 'warning');
                    return;
                }
                if (node) {
                    node.data = node.data || {};
                    node.data.videoId = videoId;
                }
                try {
                    resumeBtn.disabled = true;
                    await resumeVideoGeneration(id);
                } catch (error) {
                    showToast(error?.message || '恢复视频进度失败', 'error');
                } finally {
                    syncResumeButtonState();
                }
            });
            syncResumeButtonState();
            syncImageGenerateCount(id);
            fitNodeToContent(id);
        }
        else if (type === 'ImageResize') setupImageResize(id, el);
        else if (type === 'ImageSave') setupImageSave(id, el);
        else if (type === 'ImagePreview') setupImagePreview(id, el);
        else if (type === 'ImageMerge') {
            refreshImageMergeInputPorts(id);
            fitNodeToContent(id);
        }
        else if (type === 'TextMerge') {
            refreshTextMergeInputPorts(id);
            fitNodeToContent(id);
        }
        else if (type === 'ImageCompare') setupImageCompare(id, el);
        else if (type === 'CustomParams') {
            const list = el.querySelector(`#${id}-params-list`);
            const addButton = el.querySelector(`#${id}-add-param`);
            const renumberRows = () => {
                list?.querySelectorAll('[data-param-row]').forEach((row, index) => {
                    const keyInput = row.querySelector('.custom-param-key');
                    const valueInput = row.querySelector('.custom-param-value');
                    if (keyInput) keyInput.id = `${id}-param-key-${index}`;
                    if (valueInput) valueInput.id = `${id}-param-value-${index}`;
                });
            };
            const bindRow = (row) => {
                row.querySelector('.custom-param-remove')?.addEventListener('click', () => {
                    if (!list) return;
                    const rows = list.querySelectorAll('[data-param-row]');
                    if (rows.length <= 1) {
                        row.querySelector('.custom-param-key').value = '';
                        row.querySelector('.custom-param-value').value = '';
                    } else {
                        row.remove();
                    }
                    renumberRows();
                    fitNodeToContent(id);
                });
            };
            list?.querySelectorAll('[data-param-row]').forEach(bindRow);
            addButton?.addEventListener('click', () => {
                if (!list) return;
                const index = list.querySelectorAll('[data-param-row]').length;
                const row = documentRef.createElement('div');
                row.className = 'custom-param-row';
                row.dataset.paramRow = '';
                row.innerHTML = `
                    <input type="text" class="custom-param-key" id="${id}-param-key-${index}" placeholder="参数名" />
                    <span class="custom-param-separator">:</span>
                    <input type="text" class="custom-param-value" id="${id}-param-value-${index}" placeholder="参数值" />
                    <button type="button" class="custom-param-remove" title="删除这一行" aria-label="删除这一行">−</button>
                `;
                list.appendChild(row);
                bindRow(row);
                fitNodeToContent(id);
                row.querySelector('.custom-param-key')?.focus();
            });
            fitNodeToContent(id);
        }
        else if (type === 'CameraControl') {
            setupCameraControlNode?.(id, el);
            persistNodeModelSelection(id, type);
            fitNodeToContent(id);
        }
        else if (type === 'TextChat') {
            syncNodeProviderOptions(id, type);
            const modelSelect = el.querySelector(`#${id}-apiconfig`);
            modelSelect?.addEventListener('change', () => {
                syncNodeProviderOptions(id, type);
                persistNodeModelSelection(id, type);
                fitNodeToContent(id);
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
        } else if (type === 'TextSplit') {
            const outputCountInput = el.querySelector(`#${id}-output-count`);
            outputCountInput?.addEventListener('input', () => {
                const sanitized = sanitizeTextSplitOutputCountValue(outputCountInput.value);
                if (outputCountInput.value !== sanitized) {
                    outputCountInput.value = sanitized;
                }
            });
            outputCountInput?.addEventListener('beforeinput', (event) => {
                if (event.inputType?.startsWith('delete')) return;
                if (event.data && /\D/.test(event.data)) event.preventDefault();
            });
            el.querySelectorAll('.text-split-output-count-btn').forEach((button) => {
                button.addEventListener('click', () => {
                    if (!outputCountInput) return;
                    if (button.disabled || outputCountInput.disabled) return;
                    const delta = parseInt(button.dataset.delta || '0', 10) || 0;
                    const currentValue = normalizeTextSplitOutputCountValue(outputCountInput.value);
                    outputCountInput.value = String(Math.max(0, currentValue + delta));
                    outputCountInput.dispatchEvent(new Event('input', { bubbles: true }));
                    outputCountInput.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
            syncTextSplitOutputCountControlState(id);
            syncTextSplitNodeData(id);
        }

        el.querySelectorAll('input, select, textarea').forEach((input) => {
            input.addEventListener('change', () => {
                if (!state.nodes.get(id)?.isClone) syncClonesFromSource(id);
                scheduleSave();
            });
            input.addEventListener('input', debounce(() => {
                if (!state.nodes.get(id)?.isClone) syncClonesFromSource(id);
                scheduleSave();
            }, 500));

            if (type === 'Text' && input.id === `${id}-text`) {
                input.addEventListener('input', () => syncTextNodeData(id));
                input.addEventListener('change', () => syncTextNodeData(id));
            }
            if (type === 'TextSplit' && (input.id === `${id}-delimiter` || input.id === `${id}-output-count` || input.id === `${id}-remove-empty-lines` || input.id === `${id}-preview-enabled` || input.id === `${id}-merge-output-enabled`)) {
                input.addEventListener('input', () => syncTextSplitNodeData(id));
                input.addEventListener('change', () => syncTextSplitNodeData(id));
            }
            if (type === 'CameraControl' && /^.+-(pitch|yaw|distance|fov|roll)$/.test(input.id)) {
                input.addEventListener('input', () => persistNodeModelSelection(id, type));
                input.addEventListener('change', () => persistNodeModelSelection(id, type));
            }

            const isExpandable = input.closest('.node-field-expand');
            if (input.tagName === 'TEXTAREA' && isExpandable) {
                bindExpandableElementResize(id, input);
            }
            if (input.tagName === 'TEXTAREA') {
                bindTextareaHeightPersistence(input);
            }
        });

        if (state.nodes.get(id)?.isClone) {
            const sourceNode = state.nodes.get(state.nodes.get(id)?.cloneSourceId);
            if (sourceNode) syncCloneNodeFromSource(state.nodes.get(id), sourceNode);
        }
    }

    return {
        bindNodeInteractions,
        syncTextSplitNodeData,
        syncImageMergeNodes,
        syncClonesFromSource
    };
}
