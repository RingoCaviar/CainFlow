import * as THREE from '../../vendor/three.module.js';
import {
    CAMERA_LIMITS,
    DEFAULT_CAMERA_STATE,
    generateCameraPrompt,
    normalizeAngle,
    normalizeCameraState,
    roundTo
} from './camera-prompt-utils.js';

const CAMERA_VIEW_MODES = Object.freeze({
    FIRST_PERSON: 'firstPerson',
    THIRD_PERSON: 'thirdPerson'
});

const SUBJECT_TARGET = Object.freeze({ x: 0, y: 1.2, z: 0 });

const DEFAULT_OBSERVER_CAMERA_STATE = Object.freeze({
    yaw: 42,
    pitch: 28,
    distance: 11
});

const OBSERVER_CAMERA_LIMITS = Object.freeze({
    pitch: { min: -18, max: 78 },
    distance: { min: 4.5, max: 28 }
});

const FRONT_CAMERA_STATE = Object.freeze({
    pitch: 0,
    yaw: 0,
    distance: DEFAULT_CAMERA_STATE.distance,
    fov: DEFAULT_CAMERA_STATE.fov,
    roll: 0
});

const SLIDER_KEYS = ['pitch', 'yaw', 'distance', 'fov', 'roll'];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeCameraViewMode(value) {
    return value === CAMERA_VIEW_MODES.THIRD_PERSON
        ? CAMERA_VIEW_MODES.THIRD_PERSON
        : CAMERA_VIEW_MODES.FIRST_PERSON;
}

function buildBackTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#1b2330';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(94, 234, 212, 0.22)';
    ctx.lineWidth = 10;
    for (let x = -canvas.height; x < canvas.width; x += 72) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + canvas.height, canvas.height);
        ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = 'bold 136px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BACK', canvas.width / 2, canvas.height / 2 - 36);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.66)';
    ctx.font = '600 44px Inter, Arial, sans-serif';
    ctx.fillText('reverse side reference', canvas.width / 2, canvas.height / 2 + 78);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

function buildPlaceholderTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#16202d');
    gradient.addColorStop(1, '#0f1722');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= canvas.width; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = 'bold 78px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Image Preview', canvas.width / 2, canvas.height / 2 - 24);

    ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
    ctx.font = '500 32px Inter, Arial, sans-serif';
    ctx.fillText('Connect an upstream image node', canvas.width / 2, canvas.height / 2 + 56);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

function disposeTexture(texture) {
    if (texture && typeof texture.dispose === 'function') {
        texture.dispose();
    }
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
    });
}

function getNodeImageOutput(node) {
    if (!node) return '';
    if (typeof node.imageData === 'string' && node.imageData) return node.imageData;
    if (typeof node.resizePreviewData === 'string' && node.resizePreviewData) return node.resizePreviewData;
    if (typeof node.imageUrl === 'string' && node.imageUrl) return node.imageUrl;
    if (typeof node.data?.image === 'string' && node.data.image) return node.data.image;
    return '';
}

export function createCameraControlNodeApi({
    state,
    fitNodeToContent = () => {},
    scheduleSave = () => {},
    showToast = () => {},
    documentRef = document
}) {
    let activeEditor = null;
    const SLIDER_META = {
        pitch: { label: '俯仰角 Pitch', min: CAMERA_LIMITS.pitch.min, max: CAMERA_LIMITS.pitch.max, step: 0.5 },
        yaw: { label: '偏航角 Yaw', min: CAMERA_LIMITS.yaw.min, max: CAMERA_LIMITS.yaw.max, step: 0.5 },
        distance: { label: '距离 Distance', min: CAMERA_LIMITS.distance.min, max: CAMERA_LIMITS.distance.max, step: 0.1 },
        fov: { label: '视野角 FOV', min: CAMERA_LIMITS.fov.min, max: CAMERA_LIMITS.fov.max, step: 0.5 },
        roll: { label: '翻滚角 Roll', min: CAMERA_LIMITS.roll.min, max: CAMERA_LIMITS.roll.max, step: 0.5 }
    };

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

    function getNodeCameraViewMode(nodeId) {
        const node = state.nodes.get(nodeId);
        return normalizeCameraViewMode(node?.data?.cameraViewMode ?? node?.cameraViewMode);
    }

    function isNodeRunning(nodeId) {
        return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList.contains('running');
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

    function syncNodeCameraViewMode(nodeId, mode, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node) return CAMERA_VIEW_MODES.FIRST_PERSON;
        node.data = node.data || {};
        const normalizedMode = normalizeCameraViewMode(mode);
        node.data.cameraViewMode = normalizedMode;
        const defaults = getCameraDefaultsStore();
        defaults.cameraViewMode = normalizedMode;
        if (options.save !== false) {
            scheduleSave();
        }
        return normalizedMode;
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

    function updateCameraViewModeUi(editor) {
        const mode = normalizeCameraViewMode(editor.viewMode);
        editor.stage?.classList.toggle('is-third-person', mode === CAMERA_VIEW_MODES.THIRD_PERSON);
        editor.viewModeButtons?.forEach((button, key) => {
            const active = key === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        if (editor.stageNote) {
            editor.stageNote.textContent = mode === CAMERA_VIEW_MODES.THIRD_PERSON
                ? '第三人称：左键旋转观察视角，滚轮缩放观察视角，右键重置观察位置；右侧参数控制世界中的摄像机。'
                : '第一人称：画面就是当前摄像机视角，左键拖拽旋转，滚轮调整距离。';
        }
    }

    function updateEditorControls(editor, promptText = null) {
        const stateValues = editor.cameraState;
        SLIDER_KEYS.forEach((key) => {
            const slider = editor.sliders.get(key);
            const valueEl = editor.valueBadges.get(key);
            if (slider) slider.value = String(stateValues[key]);
            if (valueEl) {
                valueEl.value = key === 'distance'
                    ? String(roundTo(stateValues[key], 2))
                    : String(roundTo(stateValues[key], 1));
            }
        });

        if (editor.promptTextarea) {
            editor.promptTextarea.value = promptText ?? generateCameraPrompt(stateValues);
        }
        updateCameraViewModeUi(editor);
    }

    function applyCameraStateToCamera(camera, cameraState, aspect = camera.aspect || 1) {
        const pitchRad = THREE.MathUtils.degToRad(cameraState.pitch);
        const yawRad = THREE.MathUtils.degToRad(cameraState.yaw);
        const radius = cameraState.distance;
        const cosPitch = Math.cos(pitchRad);

        camera.position.set(
            radius * cosPitch * Math.sin(yawRad),
            radius * Math.sin(pitchRad) + SUBJECT_TARGET.y,
            radius * cosPitch * Math.cos(yawRad)
        );
        camera.fov = cameraState.fov;
        camera.aspect = aspect;
        camera.up.set(0, 1, 0);
        camera.lookAt(SUBJECT_TARGET.x, SUBJECT_TARGET.y, SUBJECT_TARGET.z);
        camera.rotateZ(THREE.MathUtils.degToRad(cameraState.roll));
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
    }

    function syncCameraHelper(editor) {
        const showThirdPersonRig = editor.viewMode === CAMERA_VIEW_MODES.THIRD_PERSON;
        editor.camera.updateMatrixWorld(true);
        if (editor.cameraHelper) {
            editor.cameraHelper.visible = showThirdPersonRig;
            editor.cameraHelper.update();
        }
        if (editor.cameraModel) {
            editor.cameraModel.position.copy(editor.camera.position);
            editor.cameraModel.quaternion.copy(editor.camera.quaternion);
            editor.cameraModel.visible = showThirdPersonRig;
        }
    }

    function syncObserverCamera(editor) {
        const stateValue = editor.observerState || DEFAULT_OBSERVER_CAMERA_STATE;
        const pitch = clamp(Number(stateValue.pitch) || DEFAULT_OBSERVER_CAMERA_STATE.pitch, OBSERVER_CAMERA_LIMITS.pitch.min, OBSERVER_CAMERA_LIMITS.pitch.max);
        const distance = clamp(Number(stateValue.distance) || DEFAULT_OBSERVER_CAMERA_STATE.distance, OBSERVER_CAMERA_LIMITS.distance.min, OBSERVER_CAMERA_LIMITS.distance.max);
        const yawRad = THREE.MathUtils.degToRad(Number(stateValue.yaw) || 0);
        const pitchRad = THREE.MathUtils.degToRad(pitch);
        const cosPitch = Math.cos(pitchRad);

        editor.observerState = {
            yaw: normalizeAngle(stateValue.yaw),
            pitch,
            distance
        };
        editor.observerCamera.position.set(
            distance * cosPitch * Math.sin(yawRad),
            SUBJECT_TARGET.y + distance * Math.sin(pitchRad),
            distance * cosPitch * Math.cos(yawRad)
        );
        editor.observerCamera.up.set(0, 1, 0);
        editor.observerCamera.lookAt(SUBJECT_TARGET.x, SUBJECT_TARGET.y, SUBJECT_TARGET.z);
        editor.observerCamera.updateProjectionMatrix();
    }

    function resetObserverCamera(editor) {
        editor.observerState = { ...DEFAULT_OBSERVER_CAMERA_STATE };
        syncObserverCamera(editor);
        requestRender(editor);
    }

    function syncCamera(editor, options = {}) {
        const { cameraState, camera } = editor;
        applyCameraStateToCamera(camera, cameraState, editor.camera.aspect);
        syncCameraHelper(editor);

        const promptText = syncNodeData(editor.nodeId, cameraState, options);
        updateEditorControls(editor, promptText);
        requestRender(editor);
    }

    function createCameraModel() {
        const group = new THREE.Group();
        group.name = 'ControlledCameraModel';

        const bodyMaterial = new THREE.MeshStandardMaterial({
            color: '#f8fafc',
            roughness: 0.42,
            metalness: 0.08
        });
        const accentMaterial = new THREE.MeshStandardMaterial({
            color: '#38bdf8',
            roughness: 0.35,
            metalness: 0.18
        });
        const darkMaterial = new THREE.MeshStandardMaterial({
            color: '#0f172a',
            roughness: 0.55,
            metalness: 0.12
        });

        const body = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.34, 0.24), bodyMaterial);
        body.position.set(0, 0, 0.12);
        group.add(body);

        const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 0.28, 24), darkMaterial);
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0, -0.08);
        group.add(lens);

        const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.018, 24), accentMaterial);
        glass.rotation.x = Math.PI / 2;
        glass.position.set(0, 0, -0.23);
        group.add(glass);

        const top = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.16), accentMaterial);
        top.position.set(0, 0.23, 0.12);
        group.add(top);

        const directionMaterial = new THREE.LineBasicMaterial({ color: '#38bdf8' });
        const directionGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -0.26),
            new THREE.Vector3(0, 0, -0.78)
        ]);
        group.add(new THREE.Line(directionGeometry, directionMaterial));

        group.visible = false;
        return group;
    }

    function resizeRenderer(editor) {
        const width = Math.max(1, editor.stage.clientWidth || 1);
        const height = Math.max(1, editor.stage.clientHeight || 1);
        if (width === editor.size.width && height === editor.size.height) return;
        editor.size.width = width;
        editor.size.height = height;
        editor.renderer.setSize(width, height, false);
        editor.camera.aspect = width / height;
        editor.camera.updateProjectionMatrix();
        editor.observerCamera.aspect = width / height;
        editor.observerCamera.updateProjectionMatrix();
        applyCameraStateToCamera(editor.camera, editor.cameraState, width / height);
        syncObserverCamera(editor);
        syncCameraHelper(editor);
        requestRender(editor);
    }

    function getActiveRenderCamera(editor) {
        return editor.viewMode === CAMERA_VIEW_MODES.THIRD_PERSON
            ? editor.observerCamera
            : editor.camera;
    }

    function renderSnapshotFrame(editor) {
        const previousMode = editor.viewMode;
        editor.viewMode = CAMERA_VIEW_MODES.FIRST_PERSON;
        syncCameraHelper(editor);
        editor.renderer.render(editor.scene, editor.camera);
        editor.viewMode = previousMode;
        syncCameraHelper(editor);
    }

    function requestRender(editor) {
        if (!editor || editor.disposed || editor.renderQueued) return;
        editor.renderQueued = true;
        const view = documentRef.defaultView || window;
        view.requestAnimationFrame(() => {
            editor.renderQueued = false;
            if (editor.disposed) return;
            resizeRenderer(editor);
            syncCameraHelper(editor);
            editor.renderer.render(editor.scene, getActiveRenderCamera(editor));
        });
    }

    function createPreviewSnapshot(canvas) {
        if (!canvas?.width || !canvas?.height) return '';
        const previewCanvas = documentRef.createElement('canvas');
        const scale = Math.min(1, 360 / canvas.width, 240 / canvas.height);
        previewCanvas.width = Math.max(1, Math.round(canvas.width * scale));
        previewCanvas.height = Math.max(1, Math.round(canvas.height * scale));
        const ctx = previewCanvas.getContext('2d');
        if (!ctx) return '';
        ctx.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
        return previewCanvas.toDataURL('image/png');
    }
    function storeNodePreviewImage(nodeId, previewImage, options = {}) {
        const node = state.nodes.get(nodeId);
        if (!node) return;
        node.data = node.data || {};
        node.data.cameraPreviewImage = typeof previewImage === 'string' ? previewImage : '';
        updateNodeSummary(nodeId);
        if (options.save === true) {
            scheduleSave();
        }
    }

    async function setStageImage(editor, imageValue) {
        const nextImageValue = typeof imageValue === 'string' ? imageValue : '';
        if (editor.imageValue === nextImageValue) {
            return;
        }
        editor.imageValue = nextImageValue;
        editor.textureVersion += 1;
        const requestVersion = editor.textureVersion;

        const usePlaceholderTexture = () => {
            disposeTexture(editor.frontTexture);
            editor.frontTexture = buildPlaceholderTexture();
            editor.frontMaterial.map = editor.frontTexture;
            editor.frontMaterial.needsUpdate = true;
            editor.subjectGroup.scale.set(1, 1, 1);
            requestRender(editor);
        };

        if (!nextImageValue) {
            usePlaceholderTexture();
            return;
        }

        try {
            const image = await loadImageElement(nextImageValue);
            if (editor.disposed || requestVersion !== editor.textureVersion) return;

            const texture = new THREE.Texture(image);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;

            disposeTexture(editor.frontTexture);
            editor.frontTexture = texture;
            editor.frontMaterial.map = texture;
            editor.frontMaterial.needsUpdate = true;

            const aspect = image.naturalWidth > 0 && image.naturalHeight > 0
                ? image.naturalWidth / image.naturalHeight
                : 1;
            editor.subjectGroup.scale.set(clamp(aspect, 0.45, 2.4), 1, 1);
            requestRender(editor);
        } catch {
            if (editor.disposed || requestVersion !== editor.textureVersion) return;
            usePlaceholderTexture();
        }
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
        if (activeEditor?.nodeId === nodeId) {
            void setStageImage(activeEditor, node.data.image);
        }
    }

    function refreshAllCameraControlPreviews() {
        state.nodes.forEach((node, nodeId) => {
            if (node.type === 'CameraControl') {
                refreshCameraControlPreview(nodeId);
            }
        });
    }

    function syncCameraControlFromExecution(nodeId, imageValue) {
        refreshCameraControlPreview(nodeId, typeof imageValue === 'string' ? imageValue : '');
        return syncNodeData(nodeId, getNodeCameraState(nodeId), { save: false });
    }

    function buildScene() {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0f1722');

        const ambientLight = new THREE.AmbientLight('#ffffff', 1.2);
        scene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight('#ffffff', 1.35);
        keyLight.position.set(5, 7, 6);
        scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight('#93c5fd', 0.65);
        fillLight.position.set(-4, 4, -6);
        scene.add(fillLight);

        const grid = new THREE.GridHelper(18, 18, '#4ade80', '#334155');
        grid.position.y = -0.45;
        scene.add(grid);

        const subjectGroup = new THREE.Group();
        subjectGroup.position.set(0, 1.2, 0);
        scene.add(subjectGroup);

        const frontTexture = buildPlaceholderTexture();
        const backTexture = buildBackTexture();
        const frontMaterial = new THREE.MeshStandardMaterial({
            map: frontTexture,
            roughness: 0.95,
            metalness: 0.02,
            side: THREE.FrontSide
        });
        const backMaterial = new THREE.MeshStandardMaterial({
            map: backTexture,
            roughness: 1,
            metalness: 0,
            side: THREE.FrontSide
        });

        const planeGeometry = new THREE.PlaneGeometry(3, 3);
        const frontPlane = new THREE.Mesh(planeGeometry, frontMaterial);
        frontPlane.position.z = 0.015;
        subjectGroup.add(frontPlane);

        const backPlane = new THREE.Mesh(planeGeometry, backMaterial);
        backPlane.rotation.y = Math.PI;
        backPlane.position.z = -0.015;
        subjectGroup.add(backPlane);

        const frame = new THREE.LineSegments(
            new THREE.EdgesGeometry(planeGeometry),
            new THREE.LineBasicMaterial({ color: '#f8fafc' })
        );
        subjectGroup.add(frame);

        const axis = new THREE.AxesHelper(1.5);
        axis.position.copy(subjectGroup.position);
        scene.add(axis);

        const cameraModel = createCameraModel();
        scene.add(cameraModel);

        return {
            scene,
            subjectGroup,
            cameraModel,
            frontMaterial,
            backMaterial,
            frontTexture,
            backTexture
        };
    }

    function disposeSceneResources(scene) {
        const disposedGeometries = new Set();
        const disposedMaterials = new Set();

        scene.traverse((child) => {
            if (child.geometry && typeof child.geometry.dispose === 'function' && !disposedGeometries.has(child.geometry)) {
                disposedGeometries.add(child.geometry);
                child.geometry.dispose();
            }

            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material) => {
                if (material && typeof material.dispose === 'function' && !disposedMaterials.has(material)) {
                    disposedMaterials.add(material);
                    material.dispose();
                }
            });
        });
    }

    function buildEditorMarkup() {
        const getUnit = (key) => key === 'distance' ? 'cm' : '°';
        const sliderMarkup = SLIDER_KEYS.map((key) => {
            const meta = SLIDER_META[key];
            return `
                <div class="node-field">
                    <div class="camera-control-slider-header">
                        <label>${meta.label}</label>
                        <span class="camera-control-value-group">
                            <input
                                type="number"
                                class="camera-control-value"
                                data-camera-value="${key}"
                                min="${meta.min}"
                                max="${meta.max}"
                                step="${meta.step}"
                                aria-label="${meta.label}"
                            />
                            <span class="camera-control-unit">${getUnit(key)}</span>
                        </span>
                    </div>
                    <input type="range" data-camera-slider="${key}" min="${meta.min}" max="${meta.max}" step="${meta.step}" />
                </div>
            `;
        }).join('');

        return `
            <div class="camera-control-editor-panel" role="dialog" aria-modal="true" aria-label="编辑视角">
                <div class="camera-control-editor-header">
                    <div class="camera-control-editor-heading">
                        <div class="camera-control-editor-title">编辑视角</div>
                        <div class="camera-control-editor-subtitle">切换第一人称或第三人称来调节摄像机，关闭后保留参数和预览图。</div>
                    </div>
                    <div class="camera-control-editor-actions">
                        <button type="button" class="camera-control-editor-reset" title="重置为正视视角">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 12a9 9 0 1 0 3-6.7"></path>
                                <path d="M3 3v6h6"></path>
                            </svg>
                            重置视角
                        </button>
                        <button type="button" class="camera-control-editor-close">完成</button>
                    </div>
                </div>
                <div class="camera-control-editor-content">
                    <div class="camera-control-stage-shell camera-control-editor-stage-shell">
                        <div class="camera-control-stage"></div>
                        <div class="camera-control-editor-stage-note">第一人称：画面就是当前摄像机视角，左键拖拽旋转，滚轮调整距离。</div>
                    </div>
                    <div class="camera-control-editor-sidebar">
                        <div class="node-field camera-control-view-mode-field">
                            <label>预览模式</label>
                            <div class="camera-control-view-mode-group" role="group" aria-label="预览模式">
                                <button type="button" class="camera-control-view-mode-btn active" data-camera-view-mode="${CAMERA_VIEW_MODES.FIRST_PERSON}" aria-pressed="true">第一人称</button>
                                <button type="button" class="camera-control-view-mode-btn" data-camera-view-mode="${CAMERA_VIEW_MODES.THIRD_PERSON}" aria-pressed="false">第三人称</button>
                            </div>
                        </div>
                        <div class="camera-control-sliders">${sliderMarkup}</div>
                        <div class="node-field camera-control-prompt-field">
                            <label>英文相机提示词</label>
                            <textarea class="camera-control-prompt" rows="4" readonly></textarea>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function closeCameraControlEditor(options = {}) {
        if (!activeEditor) return;
        const editor = activeEditor;
        activeEditor = null;
        if (editor.disposed) return;

        try {
            resizeRenderer(editor);
            renderSnapshotFrame(editor);
            const previewImage = createPreviewSnapshot(editor.renderer.domElement);
            if (previewImage) {
                storeNodePreviewImage(editor.nodeId, previewImage, { save: options.savePreview !== false });
            }
        } catch {
            // Ignore snapshot capture failures such as a tainted canvas.
        }

        editor.disposed = true;
        editor.stageObserver?.disconnect();
        disposeTexture(editor.frontTexture);
        disposeTexture(editor.backTexture);
        disposeSceneResources(editor.scene);
        if (typeof editor.renderer.forceContextLoss === 'function') {
            editor.renderer.forceContextLoss();
        }
        editor.renderer.dispose();
        editor.overlay.remove();

        if (options.restoreFocus !== false && editor.returnFocusEl && editor.returnFocusEl.isConnected) {
            editor.returnFocusEl.focus({ preventScroll: true });
        }
    }

    function closeCameraControlEditorForNode(nodeId, options = {}) {
        if (activeEditor?.nodeId === nodeId) {
            closeCameraControlEditor(options);
        }
    }

    function createEditor(nodeId, returnFocusEl = null) {
        const overlay = documentRef.createElement('div');
        overlay.className = 'camera-control-editor-overlay';
        overlay.tabIndex = -1;
        overlay.innerHTML = buildEditorMarkup();
        documentRef.body.appendChild(overlay);

        const panel = overlay.querySelector('.camera-control-editor-panel');
        const stage = overlay.querySelector('.camera-control-stage');
        const promptTextarea = overlay.querySelector('.camera-control-prompt');
        const closeButton = overlay.querySelector('.camera-control-editor-close');
        const resetButton = overlay.querySelector('.camera-control-editor-reset');
        const stageNote = overlay.querySelector('.camera-control-editor-stage-note');
        const sceneBits = buildScene();
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
        const observerCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
        const cameraHelper = new THREE.CameraHelper(camera);
        cameraHelper.visible = false;
        sceneBits.scene.add(cameraHelper);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
        renderer.setPixelRatio(Math.min((documentRef.defaultView?.devicePixelRatio || 1), 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.className = 'camera-control-canvas';
        stage.appendChild(renderer.domElement);

        const editor = {
            nodeId,
            overlay,
            panel,
            stage,
            promptTextarea,
            closeButton,
            resetButton,
            stageNote,
            returnFocusEl,
            renderer,
            camera,
            observerCamera,
            cameraHelper,
            scene: sceneBits.scene,
            subjectGroup: sceneBits.subjectGroup,
            cameraModel: sceneBits.cameraModel,
            frontMaterial: sceneBits.frontMaterial,
            backMaterial: sceneBits.backMaterial,
            frontTexture: sceneBits.frontTexture,
            backTexture: sceneBits.backTexture,
            renderQueued: false,
            disposed: false,
            imageValue: '',
            textureVersion: 0,
            size: { width: 0, height: 0 },
            cameraState: getNodeCameraState(nodeId),
            viewMode: getNodeCameraViewMode(nodeId),
            observerState: { ...DEFAULT_OBSERVER_CAMERA_STATE },
            sliders: new Map(),
            valueBadges: new Map(),
            viewModeButtons: new Map(),
            stageObserver: null
        };

        SLIDER_KEYS.forEach((key) => {
            const slider = overlay.querySelector(`[data-camera-slider="${key}"]`);
            const valueBadge = overlay.querySelector(`[data-camera-value="${key}"]`);
            if (slider) editor.sliders.set(key, slider);
            if (valueBadge) editor.valueBadges.set(key, valueBadge);
        });
        overlay.querySelectorAll('[data-camera-view-mode]').forEach((button) => {
            editor.viewModeButtons.set(normalizeCameraViewMode(button.dataset.cameraViewMode), button);
        });

        return editor;
    }

    function bindEditorInteractions(editor) {
        let promptResizeStart = null;
        let suppressNextOverlayClick = false;
        const applyState = (patch, options = {}) => {
            editor.cameraState = normalizeCameraState({ ...editor.cameraState, ...patch });
            syncCamera(editor, options);
        };
        const applyObserverState = (patch) => {
            editor.observerState = {
                ...editor.observerState,
                ...patch
            };
            syncObserverCamera(editor);
            requestRender(editor);
        };

        editor.closeButton?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeCameraControlEditor();
        });

        editor.resetButton?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            applyState(FRONT_CAMERA_STATE, { save: true });
        });

        editor.viewModeButtons?.forEach((button, mode) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                editor.viewMode = syncNodeCameraViewMode(editor.nodeId, mode, { save: true });
                updateCameraViewModeUi(editor);
                syncObserverCamera(editor);
                syncCameraHelper(editor);
                requestRender(editor);
            });
        });

        editor.overlay.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target === editor.overlay) {
                if (suppressNextOverlayClick) {
                    suppressNextOverlayClick = false;
                    event.preventDefault();
                    return;
                }
                closeCameraControlEditor();
            }
        });

        ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'pointerdown', 'pointerup'].forEach((eventName) => {
            editor.panel?.addEventListener(eventName, (event) => event.stopPropagation());
        });

        editor.overlay.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                closeCameraControlEditor();
            }
        });
        editor.overlay.addEventListener('keyup', (event) => {
            event.stopPropagation();
        });

        if (editor.promptTextarea) {
            const capturePromptResizeStart = () => {
                const rect = editor.promptTextarea.getBoundingClientRect();
                promptResizeStart = {
                    width: rect.width,
                    height: rect.height
                };
            };
            const finishPromptResize = (event) => {
                if (!promptResizeStart) return;
                const rect = editor.promptTextarea.getBoundingClientRect();
                const resized = Math.abs(rect.width - promptResizeStart.width) > 1 || Math.abs(rect.height - promptResizeStart.height) > 1;
                const releasedOutsidePanel = editor.panel && !editor.panel.contains(event.target);
                if (resized || releasedOutsidePanel) {
                    suppressNextOverlayClick = true;
                }
                promptResizeStart = null;
            };

            editor.promptTextarea.addEventListener('pointerdown', capturePromptResizeStart);
            editor.promptTextarea.addEventListener('mousedown', capturePromptResizeStart);
            editor.promptTextarea.addEventListener('click', (event) => event.stopPropagation());
            editor.promptTextarea.addEventListener('dblclick', (event) => event.stopPropagation());
            editor.promptTextarea.addEventListener('pointerup', finishPromptResize);
            editor.promptTextarea.addEventListener('mouseup', finishPromptResize);
            editor.overlay.addEventListener('pointerup', finishPromptResize, true);
            editor.overlay.addEventListener('mouseup', finishPromptResize, true);
        }

        SLIDER_KEYS.forEach((key) => {
            const slider = editor.sliders.get(key);
            const valueInput = editor.valueBadges.get(key);
            slider?.addEventListener('input', (event) => {
                event.stopPropagation();
                applyState({ [key]: Number(slider.value) }, { save: true });
            });
            slider?.addEventListener('change', (event) => event.stopPropagation());
            slider?.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

            const commitValueInput = (event) => {
                event.stopPropagation();
                if (!valueInput) return;
                const nextValue = Number(valueInput.value);
                if (!Number.isFinite(nextValue)) {
                    updateEditorControls(editor);
                    return;
                }
                applyState({ [key]: nextValue }, { save: true });
            };
            valueInput?.addEventListener('input', commitValueInput);
            valueInput?.addEventListener('change', commitValueInput);
            valueInput?.addEventListener('blur', commitValueInput);
            valueInput?.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitValueInput(event);
                    valueInput.blur();
                }
            });
            valueInput?.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
        });

        let dragState = null;
        const stopStageInteraction = (event) => {
            event.stopPropagation();
        };

        ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick'].forEach((eventName) => {
            editor.stage.addEventListener(eventName, stopStageInteraction);
        });

        editor.stage.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            dragState = {
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                mode: editor.viewMode
            };
            editor.stage.setPointerCapture(event.pointerId);
            editor.stage.classList.add('is-dragging');
            event.preventDefault();
            event.stopPropagation();
        });

        editor.stage.addEventListener('pointermove', (event) => {
            if (!dragState || dragState.pointerId !== event.pointerId) return;
            const dx = event.clientX - dragState.clientX;
            const dy = event.clientY - dragState.clientY;
            dragState.clientX = event.clientX;
            dragState.clientY = event.clientY;
            if (dragState.mode === CAMERA_VIEW_MODES.THIRD_PERSON) {
                applyObserverState({
                    yaw: editor.observerState.yaw - dx * 0.35,
                    pitch: editor.observerState.pitch + dy * 0.25
                });
            } else {
                applyState({
                    yaw: editor.cameraState.yaw - dx * 0.35,
                    pitch: editor.cameraState.pitch + dy * 0.25
                }, { save: true });
            }
            event.preventDefault();
            event.stopPropagation();
        });

        const endPointerDrag = (event) => {
            if (!dragState || dragState.pointerId !== event.pointerId) return;
            try {
                editor.stage.releasePointerCapture(event.pointerId);
            } catch {
                // no-op
            }
            dragState = null;
            editor.stage.classList.remove('is-dragging');
            event.preventDefault();
            event.stopPropagation();
        };

        editor.stage.addEventListener('pointerup', endPointerDrag);
        editor.stage.addEventListener('pointercancel', endPointerDrag);
        editor.stage.addEventListener('wheel', (event) => {
            if (editor.viewMode === CAMERA_VIEW_MODES.THIRD_PERSON) {
                const nextDistance = editor.observerState.distance * (1 + (event.deltaY * 0.0015));
                applyObserverState({ distance: nextDistance });
            } else {
                const nextDistance = editor.cameraState.distance * (1 + (event.deltaY * 0.0015));
                applyState({ distance: nextDistance }, { save: true });
            }
            event.preventDefault();
            event.stopPropagation();
        }, { passive: false });
        editor.stage.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (editor.viewMode === CAMERA_VIEW_MODES.THIRD_PERSON) {
                resetObserverCamera(editor);
            }
        });

        const ResizeObserverCtor = documentRef.defaultView?.ResizeObserver;
        if (ResizeObserverCtor) {
            editor.stageObserver = new ResizeObserverCtor(() => requestRender(editor));
            editor.stageObserver.observe(editor.stage);
        }
    }

    function openCameraControlEditor(nodeId, returnFocusEl = null) {
        if (activeEditor?.nodeId === nodeId) {
            activeEditor.overlay.focus({ preventScroll: true });
            return;
        }

        if (isNodeRunning(nodeId)) {
            showToast('节点正在运行，暂不能修改', 'warning');
            return;
        }

        closeCameraControlEditor({ restoreFocus: false });

        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'CameraControl') return;

        refreshCameraControlPreview(nodeId);
        const editor = createEditor(nodeId, returnFocusEl);
        activeEditor = editor;
        bindEditorInteractions(editor);
        updateEditorControls(editor, node.data?.cameraPrompt || node.data?.text || '');
        syncCamera(editor, { save: false });
        void setStageImage(editor, node.data?.image || '');
        editor.overlay.focus({ preventScroll: true });
    }

    function setupCameraControlNode(nodeId, el) {
        const node = state.nodes.get(nodeId);
        if (!node || node.type !== 'CameraControl') return;

        const openButton = el.querySelector(`#${nodeId}-camera-open`);
        if (openButton && openButton.dataset.bound !== '1') {
            const handleOpen = (event) => {
                event.preventDefault();
                event.stopPropagation();
                openCameraControlEditor(nodeId, openButton);
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
            if (activeEditor?.nodeId === nodeId) {
                closeCameraControlEditor({ restoreFocus: false });
            }
        });

        syncNodeData(nodeId, getNodeCameraState(nodeId), { save: false });
        refreshCameraControlPreview(nodeId);
        fitNodeToContent(nodeId);
    }

    return {
        setupCameraControlNode,
        openCameraControlEditor,
        closeCameraControlEditor,
        closeCameraControlEditorForNode,
        refreshCameraControlPreview,
        refreshAllCameraControlPreviews,
        syncCameraControlFromExecution
    };
}
