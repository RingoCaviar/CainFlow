import { hydrateDiskStorage } from '../services/storage-documents.js';
import { initializeDesktopBridge } from '../services/desktop-bridge.js';

let appInstance = null;

export async function bootstrapCainFlowApp({
    globalRef = globalThis,
    hydrateDiskStorageRef = hydrateDiskStorage,
    initializeDesktopBridgeRef = initializeDesktopBridge,
    themeBootstrapPromise = globalRef.__cainflowThemeBootstrapPromise || Promise.resolve(),
    loadApplication = () => import('./bootstrap-impl.js')
} = {}) {
    try {
        if (!appInstance) {
            await Promise.all([
                hydrateDiskStorageRef(),
                initializeDesktopBridgeRef(),
                themeBootstrapPromise
            ]);
            const { initializeCainFlowApp } = await loadApplication();
            appInstance = await initializeCainFlowApp();
        }
        globalRef.__cainflowAppReady = true;
        delete globalRef.__cainflowBootstrapError;
        return appInstance;
    } catch (error) {
        globalRef.__cainflowAppReady = false;
        globalRef.__cainflowBootstrapError = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        throw error;
    }
}
