import { hydrateDiskStorage } from '../services/storage-documents.js';
import { initializeDesktopBridge } from '../services/desktop-bridge.js';

let appInstance = null;

export async function bootstrapCainFlowApp() {
    if (!appInstance) {
        await Promise.all([
            hydrateDiskStorage(),
            initializeDesktopBridge(),
            globalThis.__cainflowThemeBootstrapPromise || Promise.resolve()
        ]);
        const { initializeCainFlowApp } = await import('./bootstrap-impl.js');
        appInstance = initializeCainFlowApp();
    }
    return appInstance;
}
