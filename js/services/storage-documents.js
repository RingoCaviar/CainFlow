const DIRECT_KEY_DOCUMENTS = new Map([
    ['nodeflow_ai_state', 'session'],
    ['nodeflow_ai_viewport_state', 'viewport_state'],
    ['cainflow_ui_bootstrap', 'ui_bootstrap'],
    ['cainflow_prompt_library', 'prompt_library'],
    ['cainflow_logs_state', 'logs_state'],
    ['cainflow_request_statistics', 'request_statistics']
]);

const GROUP_DOCUMENTS = [
    { name: 'update_state', prefix: 'cainflow_update_' },
    { name: 'network_detection', prefix: 'cainflow_network_' },
    { name: 'notice_state', prefix: 'cainflow_', fallback: true }
];

function parseStoredJson(value, fallback = null) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

class DiskStorageFacade {
    constructor() {
        this.values = new Map();
        this.groups = new Map();
        this.pending = new Map();
        this.flushPromise = null;
        this.retryTimer = null;
        this.lastError = null;
        this.onError = null;
        this.hydrated = false;
    }

    async hydrate() {
        if (this.hydrated) return this;
        const names = [...new Set([...DIRECT_KEY_DOCUMENTS.values(), ...GROUP_DOCUMENTS.map((item) => item.name)])];
        const results = await Promise.all(names.map(async (name) => {
            try {
                const response = await fetch(`/api/storage/documents/${encodeURIComponent(name)}`, { cache: 'no-store' });
                if (!response.ok) return [name, null];
                return [name, (await response.json()).value];
            } catch {
                return [name, null];
            }
        }));
        const documents = new Map(results);
        DIRECT_KEY_DOCUMENTS.forEach((documentName, key) => {
            const value = documents.get(documentName);
            if (value !== null && value !== undefined) this.values.set(key, JSON.stringify(value));
        });
        GROUP_DOCUMENTS.forEach(({ name }) => {
            const group = documents.get(name);
            const normalized = group && typeof group === 'object' && !Array.isArray(group) ? group : {};
            this.groups.set(name, normalized);
            Object.entries(normalized).forEach(([key, value]) => this.values.set(key, String(value)));
        });
        this.hydrated = true;
        return this;
    }

    get length() {
        return this.values.size;
    }

    key(index) {
        return Array.from(this.values.keys())[index] ?? null;
    }

    getItem(key) {
        key = String(key);
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        key = String(key);
        value = String(value);
        this.values.set(key, value);
        const directDocument = DIRECT_KEY_DOCUMENTS.get(key);
        if (directDocument) {
            this.queueDocument(directDocument, parseStoredJson(value, value));
            return;
        }
        const groupDefinition = GROUP_DOCUMENTS.find((item) => key.startsWith(item.prefix) && !item.fallback)
            || GROUP_DOCUMENTS.find((item) => item.fallback);
        const group = { ...(this.groups.get(groupDefinition.name) || {}), [key]: value };
        this.groups.set(groupDefinition.name, group);
        this.queueDocument(groupDefinition.name, group);
    }

    removeItem(key) {
        key = String(key);
        this.values.delete(key);
        const directDocument = DIRECT_KEY_DOCUMENTS.get(key);
        if (directDocument) {
            this.queueDocument(directDocument, null);
            return;
        }
        const definition = GROUP_DOCUMENTS.find((item) => key.startsWith(item.prefix) && !item.fallback)
            || GROUP_DOCUMENTS.find((item) => item.fallback);
        const group = { ...(this.groups.get(definition.name) || {}) };
        delete group[key];
        this.groups.set(definition.name, group);
        this.queueDocument(definition.name, group);
    }

    async clear() {
        this.values.clear();
        this.groups.clear();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        try { await this.flushPromise; } catch { /* reset below is authoritative */ }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.pending.clear();
        this.flushPromise = null;
        return fetch('/api/storage/maintenance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'factory-reset' })
        }).catch(() => null);
    }

    queueDocument(name, value) {
        this.pending.set(name, value);
        if (!this.flushPromise) {
            this.flushPromise = Promise.resolve().then(() => this.flush()).catch((error) => {
                this.lastError = error;
                console.error('CainFlow 硬盘数据保存失败:', error);
                this.onError?.(error);
            });
        }
    }

    async flush() {
        try {
            while (this.pending.size > 0) {
                const batch = Array.from(this.pending.entries());
                this.pending.clear();
                try {
                    await Promise.all(batch.map(([name, value]) => fetch(`/api/storage/documents/${encodeURIComponent(name)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ value })
                    }).then((response) => {
                        if (!response.ok) throw new Error(`保存 ${name} 失败: HTTP ${response.status}`);
                    })));
                    this.lastError = null;
                } catch (error) {
                    batch.forEach(([name, value]) => {
                        if (!this.pending.has(name)) this.pending.set(name, value);
                    });
                    throw error;
                }
            }
        } finally {
            this.flushPromise = null;
            if (this.pending.size > 0 && !this.retryTimer) {
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    if (!this.flushPromise) this.flushPromise = Promise.resolve().then(() => this.flush()).catch((error) => {
                        this.lastError = error;
                        console.error('CainFlow 硬盘数据重试保存失败:', error);
                        this.onError?.(error);
                    });
                }, 2000);
            }
        }
    }
}

export const diskStorage = new DiskStorageFacade();

export async function hydrateDiskStorage() {
    return diskStorage.hydrate();
}
