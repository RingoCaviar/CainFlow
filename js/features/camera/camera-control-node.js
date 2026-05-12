import * as THREE from '../../vendor/three.module.js';

const DEFAULT_CAMERA_STATE = Object.freeze({
    pitch: 12,
    yaw: 28,
    distance: 6.5,
    fov: 50,
    roll: 0
});

const FRONT_CAMERA_STATE = Object.freeze({
    pitch: 0,
    yaw: 0,
    distance: DEFAULT_CAMERA_STATE.distance,
    fov: DEFAULT_CAMERA_STATE.fov,
    roll: 0
});

const CAMERA_LIMITS = Object.freeze({
    pitch: { min: -85, max: 85 },
    yaw: { min: -180, max: 180 },
    distance: { min: 1.4, max: 18 },
    fov: { min: 18, max: 120 },
    roll: { min: -45, max: 45 }
});

const SLIDER_KEYS = ['pitch', 'yaw', 'distance', 'fov', 'roll'];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundTo(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
}

function normalizeAngle(value) {
    let angle = Number(value) || 0;
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
}

function dedupeSegments(segments = []) {
    const seen = new Set();
    return segments.filter((segment) => {
        const key = String(segment || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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

function getSubjectHorizontalDirection(yaw) {
    // In this scene setup, positive yaw moves the camera toward +X while staying
    // in front of the subject, which reveals the subject's right side.
    return yaw >= 0 ? 'right' : 'left';
}

function getPitchInstruction(pitch) {
    if (pitch >= 60) {
        return "bird's-eye top-down view, with the camera looking steeply down at the subject";
    }
    if (pitch >= 32) {
        return 'high-angle view, with the camera above the subject looking down';
    }
    if (pitch >= 12) {
        return 'slightly high-angle view, with the camera a little above eye level';
    }
    if (pitch <= -38) {
        return "worm's-eye low-angle view, with the camera very low and looking up";
    }
    if (pitch <= -16) {
        return 'low-angle view, with the camera below the subject looking up';
    }
    if (pitch <= -6) {
        return 'subtle low-angle view, with the camera just below eye level';
    }
    return 'eye-level view';
}

function getYawInstruction(yaw) {
    const absYaw = Math.abs(yaw);
    const direction = getSubjectHorizontalDirection(yaw);
    if (absYaw <= 18) {
        return 'straight-on front view, centered on the subject';
    }
    if (absYaw <= 68) {
        return `${direction} front three-quarter view, showing the front and ${direction} side of the subject`;
    }
    if (absYaw <= 112) {
        return `${direction} side profile view, showing the subject mainly from the side`;
    }
    if (absYaw <= 162) {
        return `${direction} rear three-quarter view, showing the back and ${direction} side of the subject`;
    }
    return 'straight rear view, showing the back of the subject';
}

function getDistanceInstruction(distance) {
    if (distance <= 2.4) {
        return 'extreme close-up framing, filling the image with the subject details';
    }
    if (distance <= 4) {
        return 'close-up framing, focusing tightly on the subject';
    }
    if (distance <= 5.8) {
        return 'medium close-up framing, keeping the subject dominant in the composition';
    }
    if (distance <= 8.2) {
        return 'medium shot framing, showing the subject clearly with some surrounding context';
    }
    if (distance <= 12) {
        return 'full-body or full-object framing, keeping the complete subject visible';
    }
    return 'long shot wide framing, showing the subject smaller within the environment';
}

function getFovInstruction(fov) {
    if (fov < 28) {
        return 'super-telephoto lens look with strong perspective compression';
    }
    if (fov < 42) {
        return 'telephoto lens look with compressed perspective and minimal distortion';
    }
    if (fov < 65) {
        return 'natural standard-lens perspective';
    }
    if (fov < 86) {
        return 'wide-angle lens perspective with visible spatial depth';
    }
    if (fov < 108) {
        return 'ultra-wide-angle perspective with expanded space';
    }
    return 'fisheye-like ultra-wide perspective with strong edge distortion';
}

function getRollInstruction(roll) {
    const absRoll = Math.abs(roll);
    if (absRoll < 6) {
        return 'Keep the horizon level.';
    }
    const direction = roll > 0 ? 'clockwise' : 'counterclockwise';
    if (absRoll >= 16) {
        return `Use a strong Dutch angle, tilted ${direction}.`;
    }
    return `Use a slight Dutch angle, tilted ${direction}.`;
}

export function generateCameraPrompt(cameraData = {}) {
    const pitch = Number(cameraData.pitch) || 0;
    const yaw = normalizeAngle(cameraData.yaw);
    const distance = Number(cameraData.distance) || DEFAULT_CAMERA_STATE.distance;
    const fov = Number(cameraData.fov) || DEFAULT_CAMERA_STATE.fov;
    const roll = Number(cameraData.roll) || 0;

    const viewpoint = dedupeSegments([
        getPitchInstruction(pitch),
        getYawInstruction(yaw)
    ]).join(', ');
    const framing = getDistanceInstruction(distance);
    const lens = getFovInstruction(fov);
    const rollInstruction = getRollInstruction(roll);

    return [
        `Camera viewpoint instruction: ${viewpoint}.`,
        `Frame the subject with ${framing}.`,
        `Use ${lens}.`,
        rollInstruction,
        'Preserve the subject identity and scene content; change only the camera angle, framing, lens perspective, and tilt.'
    ].join(' ');
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

    function normalizeCameraState(raw = {}) {
        return {
            pitch: clamp(roundTo(raw.pitch ?? DEFAULT_CAMERA_STATE.pitch, 1), CAMERA_LIMITS.pitch.min, CAMERA_LIMITS.pitch.max),
            yaw: clamp(roundTo(normalizeAngle(raw.yaw ?? DEFAULT_CAMERA_STATE.yaw), 1), CAMERA_LIMITS.yaw.min, CAMERA_LIMITS.yaw.max),
            distance: clamp(roundTo(raw.distance ?? DEFAULT_CAMERA_STATE.distance, 2), CAMERA_LIMITS.distance.min, CAMERA_LIMITS.distance.max),
            fov: clamp(roundTo(raw.fov ?? DEFAULT_CAMERA_STATE.fov, 1), CAMERA_LIMITS.fov.min, CAMERA_LIMITS.fov.max),
            roll: clamp(roundTo(raw.roll ?? DEFAULT_CAMERA_STATE.roll, 1), CAMERA_LIMITS.roll.min, CAMERA_LIMITS.roll.max)
        };
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
    }

    function syncCamera(editor, options = {}) {
        const { cameraState, camera } = editor;
        const pitchRad = THREE.MathUtils.degToRad(cameraState.pitch);
        const yawRad = THREE.MathUtils.degToRad(cameraState.yaw);
        const radius = cameraState.distance;
        const cosPitch = Math.cos(pitchRad);

        camera.position.set(
            radius * cosPitch * Math.sin(yawRad),
            radius * Math.sin(pitchRad) + 1.2,
            radius * cosPitch * Math.cos(yawRad)
        );
        camera.fov = cameraState.fov;
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 1.2, 0);
        camera.rotateZ(THREE.MathUtils.degToRad(cameraState.roll));
        camera.updateProjectionMatrix();

        const promptText = syncNodeData(editor.nodeId, cameraState, options);
        updateEditorControls(editor, promptText);
        requestRender(editor);
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
        requestRender(editor);
    }

    function requestRender(editor) {
        if (!editor || editor.disposed || editor.renderQueued) return;
        editor.renderQueued = true;
        const view = documentRef.defaultView || window;
        view.requestAnimationFrame(() => {
            editor.renderQueued = false;
            if (editor.disposed) return;
            resizeRenderer(editor);
            editor.renderer.render(editor.scene, editor.camera);
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

        return {
            scene,
            subjectGroup,
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
                        <div class="camera-control-editor-subtitle">左键拖拽旋转，滚轮调整距离，关闭后不保留实时渲染窗口。</div>
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
                        <div class="camera-control-editor-stage-note">左键拖拽旋转，滚轮调整距离</div>
                    </div>
                    <div class="camera-control-editor-sidebar">
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
            editor.renderer.render(editor.scene, editor.camera);
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
        const sceneBits = buildScene();
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
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
            returnFocusEl,
            renderer,
            camera,
            scene: sceneBits.scene,
            subjectGroup: sceneBits.subjectGroup,
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
            sliders: new Map(),
            valueBadges: new Map(),
            stageObserver: null
        };

        SLIDER_KEYS.forEach((key) => {
            const slider = overlay.querySelector(`[data-camera-slider="${key}"]`);
            const valueBadge = overlay.querySelector(`[data-camera-value="${key}"]`);
            if (slider) editor.sliders.set(key, slider);
            if (valueBadge) editor.valueBadges.set(key, valueBadge);
        });

        return editor;
    }

    function bindEditorInteractions(editor) {
        const applyState = (patch, options = {}) => {
            editor.cameraState = normalizeCameraState({ ...editor.cameraState, ...patch });
            syncCamera(editor, options);
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

        editor.overlay.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target === editor.overlay) {
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
                clientY: event.clientY
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
            applyState({
                yaw: editor.cameraState.yaw - dx * 0.35,
                pitch: editor.cameraState.pitch + dy * 0.25
            }, { save: true });
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
            const nextDistance = editor.cameraState.distance * (1 + (event.deltaY * 0.0015));
            applyState({ distance: nextDistance }, { save: true });
            event.preventDefault();
            event.stopPropagation();
        }, { passive: false });
        editor.stage.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
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
        refreshCameraControlPreview,
        refreshAllCameraControlPreviews,
        syncCameraControlFromExecution
    };
}
