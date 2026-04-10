/**
 * CainFlow — Application State
 * Centralized state management for the application.
 */

import { DEFAULT_PROVIDERS, DEFAULT_MODELS } from './constants.js';

export const state = {
    nodes: new Map(),
    connections: [],
    canvas: { x: 0, y: 0, zoom: 1, isPanning: false, panStart: { x: 0, y: 0 }, canvasStart: { x: 0, y: 0 } },
    dragging: null,
    connecting: null,
    resizing: null,
    marquee: null,
    contextMenu: { x: 0, y: 0 },
    isRunning: false,
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
    providers: [...DEFAULT_PROVIDERS],
    models: [...DEFAULT_MODELS],
    logs: [],
    globalSaveDirHandle: null,
    justDragged: false,
    isInteracting: false,
    zoomTimer: null,
    abortController: null,
    imageMaxPixels: 2048 * 2048, // Default to 4MP
    isMouseOverCanvas: false,
    notificationVolume: 1.0,
    notificationAudio: null,
    proxy: null, // UI level explicit proxy config. If null, we'll try to fetch auto-detect
    historyGridCols: 2,
    cacheSizes: {}, // Maps storeName to MB (number)
    undoStack: [],
    isSpacePressed: false,
    isCutting: false,
    cutPath: [],
    justCut: false
};
