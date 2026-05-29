import {
    DEFAULT_CAMERA_STATE,
    generateCameraPrompt,
    normalizeCameraState
} from './camera-prompt-utils.js';

const CAMERA_VIEW_MODES = Object.freeze({
    FIRST_PERSON: 'firstPerson',
    THIRD_PERSON: 'thirdPerson'
});

function normalizeCameraViewMode(value) {
    return value === CAMERA_VIEW_MODES.THIRD_PERSON
        ? CAMERA_VIEW_MODES.THIRD_PERSON
        : CAMERA_VIEW_MODES.FIRST_PERSON;
}

function getNodeImageOutput(node) {
    if (!node) return '';
    if (typeof node.imageData === 'string' && node.imageData) return node.imageData;
    if (typeof node.resizePreviewData === 'string' && node.resizePreviewData) return node.resizePreviewData;
    if (typeof node.imageUrl === 'string' && node.imageUrl) return node.imageUrl;
    if (typeof node.data?.image === 'string' && node.data.image) return node.data.image;
    return '';
}

export function createCameraControlNodeApi(options = {}) {
    const {
        state,
        fitNodeToContent = () => {},
        scheduleSave = () => {},
        showToast = () => {},
        documentRef = document
    } = options;

    let heavyApi = null;
    let heavyApiPromise = null;
    const pendingOpenEditors = new Map();

    async function getHeavyApi() {
        if (heavyApi) return heavyApi;
        if (!heavyApiPromise) {
            heavyApiPromise = import('./camera-control-node.js')
                .then((module) => {
                    heavyApi = module.createCameraControlNodeApi(options);
                    heavyApiPromise = null;
                    return heavyApi;
                })
                .catch((error) => {
                    heavyApiPromise = null;
                    throw error;
                });
        }
        return heavyApiPromise;
    }

    function getCameraDefaultsStore() {
        if (!state.nodeDefaults || typeof state.nodeDefaults !== 'object') {
            state.nodeDefaults = {};
        }
        if (!state.nodeDefaults.CameraControl || typeof state.nodeDefaults.CameraControl !== 'object') {
            state.nodeDefaults.CameraControl = { ...DEFAULT_CAMERA_STATE };
        }
        return state.nodeDefaults.CameraControl;
    }

    function getNodeCameraState(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) return normalizeCameraState(DEFAULT_CAMERA_STATE);
        return normalizeCameraState({
            pitch: node.data?.pitch ?? node.pitch ?? DEFAULT_CAMERA_STATE.pitch,
            yaw: node.data?.yaw ?? node.yaw ?? DEFAULT_CAMERA_STATE.yaw,
            distance: node.data?.distance ?? node.distance ?? DEFAULT_CAMERA_STATE.distance,
            fov: node.data?.fov ?? node.fov ?? DEFAULT_CAMERA_STATE.fov,
            roll: node.data?.roll ?? node.roll ?? DEFAULT_CAMERA_STATE.roll
        });
    }

    function updateNodeSummary(nodeId) {
        const node = state.nodes.get(nodeId);
        if (!node) return;
        const previewContainer = documentRef.getElementById(`${nodeId}-camera-preview`);
        if (!previewContainer) return;
        const previewImage = typeof node.data?.cameraPreviewImage === 'string' ? node.data.cameraPreviewImage.trim() : '';
        const hasReferenceImage = typeof node.data?.image === 'string' && node.data.image.trim() !== '';
        if (previewImage) {
            previewContainer.classList.add('has-image');
            previewContainer.innerHTML = '<img alt="视角预览图" draggable="false" />';
            const img = previewContainer.querySelector('img');
            if (img) img.src = previewImage;
            return;
        }
        previewContainer.classList.remove('has-image');
        previewContainer.innerHTML = `<div class="camera-control-node-preview-placeholder">${
            hasReferenceImage ? '点击“编辑视角”生成当前角度预览' : '等待参考图输入'
        }</div>`;
    }

    function syncNodeDefaults(cameraState) {
        const defaults = getCameraDefaultsStore();
        defaults.pitch = cameraState.pitch;
        defaults.yaw = cameraState.yaw;
        defaults.distance = cameraState.distance;
        defaults.fov = cameraState.fov;
        defaults.roll = cameraState.roll;
        defaults.cameraViewMode = normalizeCameraViewMode(defaults.cameraViewMode);
    }

    function syncNodeData(nodeId, cameraState, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node) return '';
        node.data = node.data || {};
        const normalized = normalizeCameraState(cameraState);
        const promptText = generateCameraPrompt(normalized);
        node.data.pitch = normalized.pitch;
        node.data.yaw = normalized.yaw;
        node.data.distance = normalized.distance;
        node.data.fov = normalized.fov;
        node.data.roll = normalized.roll;
        node.data.text = promptText;
        node.data.cameraPrompt = promptText;
        syncNodeDefaults(normalized);
        updateNodeSummary(nodeId);
        if (options.save !== false) {
            scheduleSave();
        }
        return promptText;
    }

    function findConnectedInputImage(nodeId) {
        const connection = state.connections.find((candidate) => (
            candidate.to.nodeId === nodeId &&
            candidate.to.port === 'image'
        ));
        if (!connection) return '';
        return getNodeImageOutput(state.nodes.get(connection.from.nodeId));
    }

    function refreshCameraControlPreview(nodeId, imageValue = null) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'CameraControl') return;
        node.data = node.data || {};
        const resolvedImage = imageValue !== null ? imageValue : findConnectedInputImage(nodeId);
        node.data.image = typeof resolvedImage === 'string' ? resolvedImage : '';
        updateNodeSummary(nodeId);
        if (heavyApi) {
            heavyApi.refreshCameraControlPreview(nodeId, node.data.image);
        }
    }

    function refreshAllCameraControlPreviews() {
        if (heavyApi) {
            heavyApi.refreshAllCameraControlPreviews();
            return;
        }
        state.nodes.forEach((node, nodeId) => {
            if (node.type === 'CameraControl') {
                refreshCameraControlPreview(nodeId);
            }
        });
    }

    function syncCameraControlFromExecution(nodeId, imageValue) {
        if (heavyApi) {
            return heavyApi.syncCameraControlFromExecution(nodeId, imageValue);
        }
        refreshCameraControlPreview(nodeId, typeof imageValue === 'string' ? imageValue : '');
        return syncNodeData(nodeId, getNodeCameraState(nodeId), { save: false });
    }

    async function openCameraControlEditor(nodeId, returnFocusEl = null) {
        try {
            const api = await getHeavyApi();
            api.openCameraControlEditor(nodeId, returnFocusEl);
        } catch (error) {
            console.error('Failed to load camera control editor:', error);
            showToast('视角编辑器加载失败，请刷新后重试', 'error');
        } finally {
            pendingOpenEditors.delete(nodeId);
        }
    }

    function setupCameraControlNode(nodeId, el) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'CameraControl') return;

        const openButton = el.querySelector(`#${nodeId}-camera-open`);
        if (openButton && openButton.dataset.bound !== '1') {
            const handleOpen = (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (pendingOpenEditors.has(nodeId)) return;
                const loadPromise = openCameraControlEditor(nodeId, openButton);
                pendingOpenEditors.set(nodeId, loadPromise);
            };
            openButton.addEventListener('click', handleOpen);
            openButton.dataset.bound = '1';
            if (!Array.isArray(openButton._cleanupFns)) {
                openButton._cleanupFns = [];
            }
            openButton._cleanupFns.push(() => {
                openButton.removeEventListener('click', handleOpen);
            });
        }

        if (!Array.isArray(el._cleanupFns)) {
            el._cleanupFns = [];
        }
        el._cleanupFns.push(() => {
            heavyApi?.closeCameraControlEditorForNode?.(nodeId, { restoreFocus: false });
        });

        syncNodeData(nodeId, getNodeCameraState(nodeId), { save: false });
        refreshCameraControlPreview(nodeId);
        fitNodeToContent(nodeId);
    }

    function closeCameraControlEditor(options = {}) {
        heavyApi?.closeCameraControlEditor(options);
    }

    return {
        setupCameraControlNode,
        openCameraControlEditor,
        closeCameraControlEditor,
        closeCameraControlEditorForNode: (nodeId, options) => heavyApi?.closeCameraControlEditorForNode?.(nodeId, options),
        refreshCameraControlPreview,
        refreshAllCameraControlPreviews,
        syncCameraControlFromExecution
    };
}
