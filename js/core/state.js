/**
 * 创建应用的初始状态树，集中管理画布、节点、执行、历史与设置相关的默认值。
 */
import { DEFAULT_MODELS, DEFAULT_PROVIDERS } from './constants.js';

export function createInitialState() {
    return {
        nodes: new Map(),
        connections: [],
        canvas: { x: 0, y: 0, zoom: 1, isPanning: false, panStart: { x: 0, y: 0 }, canvasStart: { x: 0, y: 0 } },
        dragging: null,
        connecting: null,
        resizing: null,
        marquee: null,
        contextMenu: { x: 0, y: 0 },
        isRunning: false,
        themeMode: 'dark',
        notificationsEnabled: false,
        autoRetry: false,
        maxRetries: 15,
        clipboard: null,
        clipboardTimestamp: 0,
        lastFocusTime: Date.now(),
        mouseCanvas: { x: 0, y: 0 },
        selectedNodes: new Set(),
        historySelectionMode: false,
        selectedHistoryIds: new Set(),
        providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })),
        models: DEFAULT_MODELS.map((model) => ({ ...model })),
        logs: [],
        globalSaveDirHandle: null,
        justDragged: false,
        isInteracting: false,
        zoomTimer: null,
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
