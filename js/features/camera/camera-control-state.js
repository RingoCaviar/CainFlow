import { DEFAULT_CAMERA_STATE, generateCameraPrompt, normalizeCameraState } from './camera-prompt-utils.js';
import { getCanonicalImageList } from '../execution/execution-data-utils.js';
import { readPrimaryImageOutput } from '../../nodes/image-output-projection.js';

export const CAMERA_VIEW_MODES = Object.freeze({ FIRST_PERSON: 'firstPerson', THIRD_PERSON: 'thirdPerson' });
export const normalizeCameraViewMode = value => value === CAMERA_VIEW_MODES.THIRD_PERSON
    ? CAMERA_VIEW_MODES.THIRD_PERSON : CAMERA_VIEW_MODES.FIRST_PERSON;

/** Parameters live on node.data; asynchronous work stays bound to that node's workflow. */
export function createCameraControlState({ state, scheduleSave = () => {}, getImageAsset = async () => '',
    getImageAssetList = async () => [], getActiveWorkflowId = () => state.activeWorkflowId || '' }) {
    const pendingReads = new WeakMap();
    const capture = nodeId => ({ node: state.nodes.get(nodeId), workflowId: getActiveWorkflowId() });
    const isCurrent = ref => !!ref?.node && ref.node.type === 'CameraControl'
        && state.nodes.get(ref.node.id) === ref.node && getActiveWorkflowId() === ref.workflowId;
    const canEdit = ref => isCurrent(ref) && !ref.node.isClone && ref.node.enabled !== false
        && !state.runningNodeIds?.has(ref.node.id) && !ref.node.el?.classList?.contains('running');
    const defaults = () => {
        if (!state.nodeDefaults || typeof state.nodeDefaults !== 'object') state.nodeDefaults = {};
        if (!state.nodeDefaults.CameraControl || typeof state.nodeDefaults.CameraControl !== 'object') {
            state.nodeDefaults.CameraControl = { ...DEFAULT_CAMERA_STATE };
        }
        return state.nodeDefaults.CameraControl;
    };
    const getNodeCameraState = nodeId => {
        const node = state.nodes.get(nodeId);
        return normalizeCameraState(Object.fromEntries(Object.keys(DEFAULT_CAMERA_STATE).map(key =>
            [key, node?.data?.[key] ?? node?.[key] ?? DEFAULT_CAMERA_STATE[key]])));
    };
    const getNodeCameraViewMode = nodeId => {
        const node = state.nodes.get(nodeId);
        return normalizeCameraViewMode(node?.data?.cameraViewMode ?? node?.cameraViewMode);
    };
    function updateNodeSummary(nodeId) {
        const node = state.nodes.get(nodeId);
        const preview = node?.el?.querySelector?.(`[id="${nodeId}-camera-preview"]`);
        if (!preview) return;
        const snapshot = typeof node.data?.cameraPreviewImage === 'string' ? node.data.cameraPreviewImage.trim() : '';
        const hasReference = !!node.data?.image;
        preview.dataset.cameraState = hasReference ? 'current' : (snapshot ? 'stale' : 'empty');
        preview.dataset.cameraMessage = hasReference ? '参考首图已就绪；视角文字随参数更新'
            : (snapshot ? '参考图不可用，保留上次视角预览；未更新' : '等待参考图输入；视角文字仍可使用');
        preview.classList.toggle('has-image', !!snapshot);
        if (snapshot) {
            let img = preview.querySelector('img');
            if (!img) {
                preview.innerHTML = '<img alt="视角预览图" draggable="false" />';
                img = preview.querySelector('img');
            }
            if (img && img.getAttribute('src') !== snapshot) img.src = snapshot;
        } else {
            const message = hasReference ? '点击“编辑视角”生成当前角度预览' : '等待参考图输入';
            if (preview.querySelector('.camera-control-node-preview-placeholder')?.textContent !== message) {
                preview.innerHTML = `<div class="camera-control-node-preview-placeholder">${message}</div>`;
            }
        }
    }
    function syncNodeData(nodeId, cameraState, options = {}) {
        const ref = options.identity || capture(nodeId);
        if (!isCurrent(ref)) return '';
        const node = ref.node;
        const normalized = normalizeCameraState(cameraState);
        const prompt = generateCameraPrompt(normalized);
        node.data ||= {};
        Object.assign(node.data, normalized, { text: prompt, cameraPrompt: prompt });
        Object.assign(defaults(), normalized);
        defaults().cameraViewMode = normalizeCameraViewMode(defaults().cameraViewMode);
        updateNodeSummary(nodeId);
        if (options.save !== false) scheduleSave();
        return prompt;
    }
    function syncNodeCameraViewMode(nodeId, mode, options = {}) {
        const ref = options.identity || capture(nodeId);
        if (!isCurrent(ref)) return normalizeCameraViewMode(mode);
        ref.node.data ||= {};
        ref.node.data.cameraViewMode = normalizeCameraViewMode(mode);
        defaults().cameraViewMode = ref.node.data.cameraViewMode;
        if (options.save !== false) scheduleSave();
        return ref.node.data.cameraViewMode;
    }
    async function refreshCameraControlPreview(nodeId, imageValue = null) {
        const ref = capture(nodeId);
        if (!isCurrent(ref)) return null;
        const token = {};
        pendingReads.set(ref.node, token);
        const connection = state.connections.find(edge => edge.to.nodeId === nodeId && edge.to.port === 'image');
        const source = connection && state.nodes.get(connection.from.nodeId);
        let image = '';
        if (imageValue !== null) {
            const first = Array.isArray(imageValue) ? imageValue[0] : imageValue;
            image = typeof first === 'string' ? first : '';
            if (source?.enabled === false) image = '';
        } else if (source && source.enabled !== false) {
            try {
                image = await readPrimaryImageOutput(source, getCanonicalImageList(source), async key =>
                    key.startsWith('media:') ? getImageAsset(key) : (await getImageAssetList(key))?.[0] || '');
            } catch {
                image = '';
            }
        }
        if (!isCurrent(ref) || pendingReads.get(ref.node) !== token) return null;
        if (connection && (!state.connections.includes(connection) || state.nodes.get(connection.from.nodeId) !== source)) return null;
        if (source?.enabled === false || source?.data?.mediaIntegrity?.missingItems?.some(item => item.position === 0)) image = '';
        ref.node.data ||= {};
        ref.node.data.image = typeof image === 'string' ? image : '';
        updateNodeSummary(nodeId);
        return ref.node.data.image;
    }
    return { capture, isCurrent, canEdit, getNodeCameraState, getNodeCameraViewMode, updateNodeSummary,
        syncNodeData, syncNodeCameraViewMode, refreshCameraControlPreview };
}
