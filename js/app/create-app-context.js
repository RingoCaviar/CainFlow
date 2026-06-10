import { createElements } from '../core/elements.js';
import { createInitialState } from '../core/state.js';
import { API_PROVIDERS_LOCKED, STORAGE_KEY } from '../core/constants.js';
import { createProxyHeadersGetter } from '../services/api-client.js';
import { createIndexedDbApi } from '../services/storage-idb.js';
import { createMediaUtils } from '../features/media/media-utils.js';
import { createPanelManager } from '../features/ui/panel-manager.js';
import { createUiUtils } from '../features/ui/ui-utils.js';

/**
 * 创建前端装配阶段共享的基础上下文。
 * 这里只初始化无业务副作用、且可被多个域复用的基础对象。
 */
export function createAppContext({
    documentRef = document,
    localStorageRef = localStorage,
    showToast = () => {},
    onNativeClipboardWrite = () => {}
} = {}) {
    const elements = createElements(documentRef);
    const panelManager = createPanelManager(documentRef, elements.canvasContainer);
    const hasStoredProjectState = (() => {
        try {
            const raw = localStorageRef?.getItem?.(STORAGE_KEY);
            return typeof raw === 'string' && raw.trim().length > 0;
        } catch {
            return false;
        }
    })();
    const state = createInitialState({
        includeDefaultProviders: !(API_PROVIDERS_LOCKED && !hasStoredProjectState)
    });
    const dirHandles = new Map();
    const proxyHeadersGetter = createProxyHeadersGetter(() => state);
    const indexedDbApi = createIndexedDbApi(() => state);
    const mediaUtils = createMediaUtils({
        getImageMaxPixels: () => state.imageMaxPixels,
        documentRef
    });
    const uiUtils = createUiUtils({
        showToast,
        onNativeClipboardWrite
    });

    return {
        documentRef,
        elements,
        panelManager,
        state,
        dirHandles,
        proxyHeadersGetter,
        indexedDbApi,
        mediaUtils,
        uiUtils
    };
}
