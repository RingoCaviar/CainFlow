const STORAGE_KEY = 'cainflow_connection_diagnostics';
const DEDUPE_WINDOW_MS = 2000;

export function createConnectionDiagnostics({ localStorageRef = localStorage, nowRef = () => Date.now(), policy } = {}) {
    if (!policy || !Number.isFinite(policy.budgetBytes) || !Number.isFinite(policy.recordBytes) || !Number.isFinite(policy.retentionDays)) {
        throw new TypeError('Backend-resolved Canvas diagnostic policy is required');
    }
    const retentionDays = Number(policy.retentionDays);
    const storageBudgetBytes = Number(policy.budgetBytes);
    const recordBudgetBytes = Number(policy.recordBytes);
    const textEncoder = new TextEncoder();
    let entries = [];

    function prune() {
        const previousLength = entries.length;
        const cutoff = nowRef() - retentionDays * 24 * 60 * 60 * 1000;
        entries = entries.filter((entry) => Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) >= cutoff);
        let encodedBytes = 2;
        let retainedCount = 0;
        for (const entry of entries) {
            const entryBytes = textEncoder.encode(JSON.stringify(entry)).length;
            const separatorBytes = retainedCount > 0 ? 1 : 0;
            if (encodedBytes + separatorBytes + entryBytes > storageBudgetBytes) break;
            encodedBytes += separatorBytes + entryBytes;
            retainedCount += 1;
        }
        if (retainedCount < entries.length) entries = entries.slice(0, retainedCount);
        return previousLength - entries.length;
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

    function normalizeEntry(entry, timestamp) {
        let next = { ...entry, timestamp };
        const encoded = textEncoder.encode(JSON.stringify(next));
        if (encoded.length > recordBudgetBytes) {
            next = { reason: String(entry?.reason || '').slice(0, 512), connectionId: String(entry?.connectionId || '').slice(0, 256), timestamp, originalBytes: encoded.length, truncated: true };
        }
        return next;
    }

    function recordBatch(intents) {
        const batch = Array.isArray(intents) ? intents : [];
        let accepted = 0;
        let deduped = 0;
        const batchStartedAt = nowRef();
        const recentKeys = new Set(entries
            .filter((entry) => batchStartedAt - Number(entry.timestamp) <= DEDUPE_WINDOW_MS)
            .map((entry) => JSON.stringify([entry.reason, entry.connectionId])));
        for (const intent of batch) {
            const timestamp = nowRef();
            const next = normalizeEntry(intent, timestamp);
            const dedupeKey = JSON.stringify([next.reason, next.connectionId]);
            if (recentKeys.has(dedupeKey)) {
                deduped += 1;
                continue;
            }
            entries.unshift(next);
            recentKeys.add(dedupeKey);
            accepted += 1;
        }
        if (accepted === 0) return { accepted, deduped, dropped: 0 };
        const dropped = prune();
        try { localStorageRef.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* diagnostics must never block the UI */ }
        return { accepted, deduped, dropped };
    }

    function record(entry) {
        return recordBatch([entry]).accepted > 0;
    }

    load();
    function clear() {
        entries = [];
        try { localStorageRef.removeItem(STORAGE_KEY); return { success: true }; } catch (error) { return { success: false, error: String(error) }; }
    }

    return {
        clear,
        record,
        recordBatch,
        prune,
        getEntries: () => entries.slice(),
        status: () => ({ usedBytes: textEncoder.encode(JSON.stringify(entries)).length })
    };
}
