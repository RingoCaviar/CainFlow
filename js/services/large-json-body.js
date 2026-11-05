let worker = null;
let sequence = 0;
const pending = new Map();

function fallback(json) {
    return new Blob([json], { type: 'application/json' });
}

// Small writes keep their synchronous fetch/keepalive path. Only large JSON
// strings cross this boundary; the returned Blob avoids encoding in fetch.
export function createLargeJsonBody(json) {
    if (typeof Worker !== 'function') return Promise.resolve(fallback(json));
    try {
        if (!worker) {
            const current = new Worker(new URL('./json-body-worker.js', import.meta.url), { type: 'module' });
            current.addEventListener('message', ({ data }) => {
                const request = pending.get(data.id);
                if (!request) return;
                pending.delete(data.id);
                request.resolve(data.body);
            });
            const recover = () => {
                if (worker !== current) return;
                current.terminate();
                worker = null;
                for (const request of pending.values()) request.resolve(fallback(request.json));
                pending.clear();
            };
            current.addEventListener('error', recover);
            current.addEventListener('messageerror', recover);
            worker = current;
        }
        const id = ++sequence;
        return new Promise(resolve => {
            pending.set(id, { resolve, json });
            try { worker.postMessage({ id, json }); }
            catch { pending.delete(id); resolve(fallback(json)); }
        });
    } catch {
        return Promise.resolve(fallback(json));
    }
}
