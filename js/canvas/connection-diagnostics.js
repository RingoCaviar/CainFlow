const STORAGE_KEY = 'cainflow_connection_diagnostics';
const DEDUPE_WINDOW_MS = 2000;

export function createConnectionDiagnostics({ localStorageRef = localStorage, nowRef = () => Date.now(), policy } = {}) {
    if (!policy || !Number.isFinite(policy.budgetBytes) || !Number.isFinite(policy.recordBytes) || !Number.isFinite(policy.retentionDays)) {
        throw new TypeError('Backend-resolved Canvas diagnostic policy is required');
    }
    const retentionDays = Number(policy.retentionDays);
    const storageBudgetBytes = Number(policy.budgetBytes);
    const recordBudgetBytes = Number(policy.recordBytes);
    let entries = [];

    function prune() {
        const cutoff = nowRef() - retentionDays * 24 * 60 * 60 * 1000;
        entries = entries.filter((entry) => Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) >= cutoff);
        while (entries.length > 0 && new TextEncoder().encode(JSON.stringify(entries)).length > storageBudgetBytes) entries.pop();
    }

    function load() {
        try {
            const parsed = JSON.parse(localStorageRef.getItem(STORAGE_KEY) || '[]');
            entries = Array.isArray(parsed) ? parsed : [];
        } catch {
            entries = [];
        }
        prune();
    }

    function record(entry) {
        const timestamp = nowRef();
        let next = { ...entry, timestamp };
        const encoded = new TextEncoder().encode(JSON.stringify(next));
        if (encoded.length > recordBudgetBytes) {
            next = { reason: String(entry?.reason || '').slice(0, 512), connectionId: String(entry?.connectionId || '').slice(0, 256), timestamp, originalBytes: encoded.length, truncated: true };
        }
        const previous = entries[0];
        if (previous && previous.reason === next.reason && previous.connectionId === next.connectionId && timestamp - Number(previous.timestamp) <= DEDUPE_WINDOW_MS) return false;
        entries.unshift(next);
        prune();
        try { localStorageRef.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* diagnostics must never block the UI */ }
        return true;
    }

    load();
    function clear() {
        entries = [];
        try { localStorageRef.removeItem(STORAGE_KEY); return { success: true }; } catch (error) { return { success: false, error: String(error) }; }
    }

    return {
        clear,
        record,
        prune,
        getEntries: () => entries.slice(),
        status: () => ({ usedBytes: new TextEncoder().encode(JSON.stringify(entries)).length })
    };
}
