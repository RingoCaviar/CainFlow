import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_COMPACT_STORAGE_KEY, COMPACTION_MODEL_STORAGE_KEY, migrateAutoCompactTokens, readAutoCompactTokens, readCompactionModelId, writeAutoCompactTokens, writeCompactionModelId } from '../js/features/prompt-agent/auto-compact-preference.js';
import { measurePromptAgentContext } from '../js/features/prompt-agent/prompt-agent-token-budget.js';

test('one persisted threshold applies across models and ignores legacy model values', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    assert.equal(readAutoCompactTokens(storage), 12000);
    writeAutoCompactTokens(storage, '24000');
    assert.equal(data.get(AUTO_COMPACT_STORAGE_KEY), '24000');
    const restored = { ...storage };
    for (const model of [{ autoCompactTokenLimit: 1 }, { autoCompactTokenLimit: 99999 }]) {
        assert.equal(measurePromptAgentContext({ model, autoCompactTokenLimit: readAutoCompactTokens(restored) }).threshold, 24000);
    }
    for (const value of ['', '0', '-1', '1.5', 'Infinity', '12000x']) {
        assert.throws(() => writeAutoCompactTokens(storage, value));
        assert.equal(readAutoCompactTokens(storage), 24000);
    }
});

test('only the selected legacy model seeds a missing global preference once', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    const models = [{ id: 'first', autoCompactTokenLimit: 8000 }, { id: 'second', autoCompactTokenLimit: 24000 }];
    assert.equal(migrateAutoCompactTokens(storage, models, 'second'), 24000);
    assert.equal(migrateAutoCompactTokens(storage, models, 'first'), 24000);
    assert.equal(readAutoCompactTokens(storage), 24000);
});

test('compaction model preference is independent of the chat model', () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
    assert.equal(readCompactionModelId(storage), '');
    writeCompactionModelId(storage, 'cheap-chat');
    assert.equal(data.get(COMPACTION_MODEL_STORAGE_KEY), 'cheap-chat');
    assert.equal(readCompactionModelId(storage), 'cheap-chat');
    writeCompactionModelId(storage, '');
    assert.equal(readCompactionModelId(storage), '');
});

test('global threshold survives a failed disk write, retry and app reconstruction', async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = globalThis.setTimeout;
    const documents = new Map(), retries = [];
    let failed = true;
    globalThis.setTimeout = callback => { retries.push(callback); return retries.length; };
    globalThis.fetch = async (url, options = {}) => {
        if (options.method === 'PUT') {
            if (failed) return { ok: false, status: 503 };
            documents.set(url, JSON.parse(options.body).value);
        }
        return { ok: true, json: async () => ({ value: documents.get(url) ?? null }) };
    };
    try {
        const { diskStorage } = await import('../js/services/storage-documents.js?compact-first');
        diskStorage.onError = () => {};
        writeAutoCompactTokens(diskStorage, 32000);
        await diskStorage.flushPromise;
        assert.ok(retries.length);
        failed = false;
        retries.shift()();
        await diskStorage.flushPromise;
        const { diskStorage: reopened } = await import('../js/services/storage-documents.js?compact-reopened');
        await reopened.hydrate();
        assert.equal(readAutoCompactTokens(reopened), 32000);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalTimeout;
    }
});
