import { hydrateDiskStorage } from '../services/storage-documents.js';

let appInstance = null;

export async function bootstrapCainFlowApp() {
    if (!appInstance) {
        await Promise.all([
            hydrateDiskStorage(),
            globalThis.__cainflowThemeBootstrapPromise || Promise.resolve()
        ]);
        const { initializeCainFlowApp } = await import('./bootstrap-impl.js');
        appInstance = initializeCainFlowApp();
    }
    return appInstance;
}
