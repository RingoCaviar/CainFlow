/**
 * 创建应用的初始状态树，集中管理画布、节点、执行、历史与设置相关的默认值。
 */
import { DEFAULT_MODELS, DEFAULT_PROVIDERS } from './constants.js';

export const NODE_DEFAULT_TYPES = ['ImageGenerate', 'TextChat', 'CameraControl'];

export function createInitialNodeDefaults() {
    return NODE_DEFAULT_TYPES.reduce((defaults, type) => {
        defaults[type] = {
            apiConfigId: '',
            providerId: ''
        };
        if (type === 'CameraControl') {
            defaults[type] = {
                pitch: 12,
                yaw: 28,
                distance: 6.5,
                fov: 50,
                roll: 0
            };
        }
        return defaults;
    }, {});
}

export function normalizeNodeDefaults(raw = {}) {
    const defaults = createInitialNodeDefaults();
    NODE_DEFAULT_TYPES.forEach((type) => {
        const current = raw?.[type];
        if (!current || typeof current !== 'object') return;
        if (type === 'CameraControl') {
            defaults[type] = {
                pitch: Number.isFinite(Number(current.pitch)) ? Number(current.pitch) : 12,
                yaw: Number.isFinite(Number(current.yaw)) ? Number(current.yaw) : 28,
                distance: Number.isFinite(Number(current.distance)) ? Number(current.distance) : 6.5,
                fov: Number.isFinite(Number(current.fov)) ? Number(current.fov) : 50,
                roll: Number.isFinite(Number(current.roll)) ? Number(current.roll) : 0
            };
            return;
        }
        defaults[type] = {
            apiConfigId: typeof current.apiConfigId === 'string' ? current.apiConfigId : '',
            providerId: typeof current.providerId === 'string' ? current.providerId : ''
        };
    });
    return defaults;
}

export function createInitialState() {
    return {
        nodes: new Map(),
        connections: [],
        canvas: { x: 0, y: 0, zoom: 1, isPanning: false, panStart: { x: 0, y: 0 }, canvasStart: { x: 0, y: 0 } },
        dragging: null,
        connectionInsertPreview: null,
        connectionCreatePopup: null,
        connecting: null,
        resizing: null,
        marquee: null,
        contextMenu: { x: 0, y: 0 },
        isRunning: false,
        themeId: 'dark',
        notificationsEnabled: false,
        autoRetry: false,
        maxRetries: 15,
        concurrentRequestMode: true,
        clipboard: null,
        clipboardTimestamp: 0,
        lastFocusTime: Date.now(),
        mouseCanvas: { x: 0, y: 0 },
        selectedNodes: new Set(),
        runningNodeIds: new Set(),
        runningNodeCancelHandlers: new Map(),
        activeRunCount: 0,
        runAbortControllers: new Set(),
        nodeDefaults: createInitialNodeDefaults(),
        historySelectionMode: false,
        selectedHistoryIds: new Set(),
        draggedHistoryImage: null,
        providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })),
        models: DEFAULT_MODELS.map((model) => ({ ...model })),
        logs: [],
        globalSaveDirHandle: null,
        justDragged: false,
        isInteracting: false,
        zoomTimer: null,
        zoomSettleBlockedUntil: 0,
        zoomSettleControlLock: false,
        pendingZoomVisualRefresh: false,
        abortController: null,
        workflowTimeoutId: null,
        abortReason: null,
        imageAutoResizeEnabled: true,
        imageMaxPixels: 2048 * 2048,
        isMouseOverCanvas: false,
        notificationVolume: 1.0,
        notificationAudio: null,
        proxy: null,
        requestTimeoutEnabled: true,
        requestTimeoutSeconds: 600,
        connectionLineType: 'bezier',
        globalAnimationEnabled: true,
        connectionFlowAnimationEnabled: true,
        historyGridCols: 2,
        cacheSizes: {},
        undoStack: [],
        isSpacePressed: false,
        isCutting: false,
        cutPath: [],
        justCut: false
    };
}
/**
 * 定义前端运行期共享状态的初始结构。
 */
