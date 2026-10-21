import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentPanelWidth } from '../js/features/prompt-agent/prompt-agent-panel-width.js';

test('width preference survives a disk outage, retry and a new storage instance', async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = globalThis.setTimeout;
    const documents = new Map();
    const retries = [];
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
        const { diskStorage } = await import('../js/services/storage-documents.js?agent-width-first');
        let notified = false;
        diskStorage.onError = () => { notified = true; };
        diskStorage.setItem('cainflow_prompt_agent_panel_width', '712');
        await diskStorage.flushPromise;
        assert.ok(notified && retries.length);
        failed = false;
        retries.shift()();
        await diskStorage.flushPromise;
        const { diskStorage: reopened } = await import('../js/services/storage-documents.js?agent-width-reopened');
        await reopened.hydrate();
        const layoutProperties = new Map();
        const panel = { style: {}, parentElement: { clientWidth: 1200, style: { setProperty: (key, value) => layoutProperties.set(key, value) } } };
        createPromptAgentPanelWidth({ panel, read: () => reopened.getItem('cainflow_prompt_agent_panel_width') });
        assert.equal(panel.style.width, '712px');
        assert.equal(layoutProperties.get('--prompt-agent-width'), '712px');
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalTimeout;
    }
});

test('invalid preferences use defaults, and only the initial workflow can migrate a width', () => {
    for (const value of [null, '', 'NaN', -1, 0, 299, 961, Infinity]) {
        const panel = { style: {}, parentElement: { clientWidth: 1200, style: { setProperty() {} } } };
        const writes = [];
        const width = createPromptAgentPanelWidth({ panel, read: () => value, write: value => writes.push(value) });
        assert.equal(panel.style.width, '408px');
        width.migrate(null);
        width.migrate(612);
        assert.deepEqual(writes, []);
    }
});
