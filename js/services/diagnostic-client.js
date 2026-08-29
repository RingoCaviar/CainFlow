import { createConnectionDiagnostics } from '../canvas/connection-diagnostics.js';

export function createDiagnosticClient({ fetchImpl = fetch, localStorageRef = localStorage, nowRef = () => Date.now() } = {}) {
    let canvasAdapter = null;
    let currentStatus = null;

    async function request(body = null) {
        const response = await fetchImpl('/api/diagnostics', body ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        } : { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    function applyStatus(statusValue) {
        const canvasPolicy = statusValue?.adapters?.canvas;
        if (canvasPolicy && !canvasAdapter) {
            canvasAdapter = createConnectionDiagnostics({ localStorageRef, nowRef, policy: canvasPolicy });
        }
        currentStatus = {
            ...statusValue,
            adapters: {
                ...(statusValue?.adapters || {}),
                canvas: { ...(canvasPolicy || {}), ...(canvasAdapter?.status() || {}) }
            }
        };
        return currentStatus;
    }

    async function status() {
        return applyStatus((await request()).status);
    }

    async function setLevel(level) {
        const result = await request({ action: 'set-level', level });
        await status();
        return result.policy;
    }

    async function clear(scope = 'all') {
        let result;
        try {
            result = await request({ action: 'clear', scope });
        } catch (error) {
            result = { adapters: { backend: { success: false, error: String(error?.message || error) } } };
        }
        const canvas = canvasAdapter?.clear() || { success: false, error: 'Canvas diagnostic adapter is not initialized' };
        return { ...result, adapters: { ...(result.adapters || {}), canvas } };
    }

    return {
        clear,
        currentStatus: () => currentStatus,
        recordCanvas: (intent) => canvasAdapter?.record(intent) || false,
        recordCanvasBatch: (intents) => canvasAdapter?.recordBatch(intents)
            || { accepted: 0, deduped: 0, dropped: Array.isArray(intents) ? intents.length : 0 },
        setLevel,
        status
    };
}

/** Owns the browser-side seam to the backend-authoritative diagnostic module. */
