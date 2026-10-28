import { createCameraControlState } from './camera-control-state.js';

export function createCameraControlNodeApi(options = {}) {
    const { state, fitNodeToContent = () => {}, showToast = () => {},
        loadCameraModule = () => import('./camera-control-node.js') } = options;
    const camera = createCameraControlState(options);
    let heavyApi = null;
    let heavyApiPromise = null;
    const pendingOpenEditors = new WeakMap();

    async function getHeavyApi() {
        if (heavyApi) return heavyApi;
        if (!heavyApiPromise) {
            heavyApiPromise = loadCameraModule().then(module => {
                heavyApi = module.createCameraControlNodeApi(options);
                return heavyApi;
            }).finally(() => { heavyApiPromise = null; });
        }
        return heavyApiPromise;
    }

    async function refreshCameraControlPreview(nodeId, imageValue = null) {
        if (heavyApi) return heavyApi.refreshCameraControlPreview(nodeId, imageValue);
        return camera.refreshCameraControlPreview(nodeId, imageValue);
    }

    function refreshAllCameraControlPreviews() {
        if (heavyApi) return heavyApi.refreshAllCameraControlPreviews();
        return Promise.all([...state.nodes.values()].filter(node => node.type === 'CameraControl')
            .map(node => refreshCameraControlPreview(node.id)));
    }

    async function syncCameraControlFromExecution(nodeId, imageValue) {
        if (heavyApi) return heavyApi.syncCameraControlFromExecution(nodeId, imageValue);
        const ref = camera.capture(nodeId);
        await refreshCameraControlPreview(nodeId, imageValue ?? '');
        if (camera.isCurrent(ref)) return camera.syncNodeData(nodeId, camera.getNodeCameraState(nodeId), { save: false, identity: ref });
        return '';
    }

    async function openCameraControlEditor(nodeId, returnFocusEl = null) {
        const ref = camera.capture(nodeId);
        if (!camera.canEdit(ref)) return;
        if (pendingOpenEditors.has(ref.node)) return pendingOpenEditors.get(ref.node);
        const pending = (async () => {
            try {
                const api = await getHeavyApi();
                if (camera.canEdit(ref)) await api.openCameraControlEditor(nodeId, returnFocusEl);
            } catch (error) {
                if (!camera.isCurrent(ref)) return;
                console.error('Failed to load camera control editor:', error);
                showToast('视角编辑器加载失败，请刷新后重试', 'error');
            } finally {
                pendingOpenEditors.delete(ref.node);
            }
        })();
        pendingOpenEditors.set(ref.node, pending);
        return pending;
    }

    function setupCameraControlNode(nodeId, el) {
        const ref = camera.capture(nodeId);
        if (!camera.isCurrent(ref)) return;
        const button = el.querySelector(`#${nodeId}-camera-open`);
        if (button && button.dataset.bound !== '1') {
            const handleOpen = event => {
                event.preventDefault(); event.stopPropagation();
                if (state.nodes.get(nodeId) === ref.node) void openCameraControlEditor(nodeId, button);
            };
            button.addEventListener('click', handleOpen);
            button.dataset.bound = '1';
            (button._cleanupFns ||= []).push(() => button.removeEventListener('click', handleOpen));
        }
        (el._cleanupFns ||= []).push(() => heavyApi?.closeCameraControlEditorForNode?.(nodeId,
            { restoreFocus: false, expectedNode: ref.node }));
        camera.syncNodeData(nodeId, camera.getNodeCameraState(nodeId), { save: false, identity: ref });
        void refreshCameraControlPreview(nodeId);
        fitNodeToContent(nodeId);
    }

    return { setupCameraControlNode, openCameraControlEditor, refreshCameraControlPreview,
        refreshAllCameraControlPreviews, syncCameraControlFromExecution,
        closeCameraControlEditor: options => heavyApi?.closeCameraControlEditor(options),
        closeCameraControlEditorForNode: (nodeId, options) => heavyApi?.closeCameraControlEditorForNode(nodeId, options) };
}
