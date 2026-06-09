import { initializeCainFlowApp } from './bootstrap-impl.js';

let appInstance = null;

export function bootstrapCainFlowApp() {
    if (!appInstance) {
        appInstance = initializeCainFlowApp();
    }
    return appInstance;
}
