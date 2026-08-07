const STORAGE_KEY = 'cainflow_connection_diagnostics';
const RETENTION_DAYS = 1;
const DEDUPE_WINDOW_MS = 2000;

export function createConnectionDiagnostics({ localStorageRef = localStorage, nowRef = () => Date.now() } = {}) {
    let entries = [];

    function prune() {
        const cutoff = nowRef() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        entries = entries.filter((entry) => Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) >= cutoff);
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
        const next = { ...entry, timestamp };
        const previous = entries[0];
        if (previous && previous.reason === next.reason && previous.connectionId === next.connectionId && timestamp - Number(previous.timestamp) <= DEDUPE_WINDOW_MS) return false;
        entries.unshift(next);
        prune();
        try { localStorageRef.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* diagnostics must never block the UI */ }
        return true;
    }

    load();
    return { record, prune, getEntries: () => entries.slice() };
}
