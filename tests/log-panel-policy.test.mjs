import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogPanelApi } from '../js/features/logs/log-panel.js';

function storage(initial = null) {
    let value = initial;
    return {
        getItem: () => value,
        setItem: (_key, next) => { value = next; },
        read: () => value
    };
}

test('execution history migrates retention days to a fixed 200-entry/7-day policy', () => {
    const now = Date.now();
    const persisted = storage(JSON.stringify({ logRetentionDays: 30, logs: [{ id: 'old', timestamp: now - 8 * 86400000 }, { id: 'new', timestamp: now }] }));
    const state = { logs: [] };
    const api = createLogPanelApi({ state, elements: {}, renderErrorModal() {}, localStorageRef: persisted });
    api.initializeLogs();
    assert.deepEqual(state.logs.map((entry) => entry.id), ['new']);
    assert.equal(JSON.parse(persisted.read()).logRetentionDays, undefined);
});

test('execution history bounds details and escapes rendered titles', () => {
    const logList = { innerHTML: '' };
    const state = { logs: [], autoRetry: true };
    const api = createLogPanelApi({ state, elements: { logList }, renderErrorModal() {}, localStorageRef: storage() });
    const record = api.addLog('info', '<img src=x onerror=alert(1)>', 'message', { text: 'x'.repeat(20 * 1024) });
    assert.ok(new TextEncoder().encode(JSON.stringify(record.details)).length <= 16 * 1024);
    assert.equal(logList.innerHTML.includes('<img src=x'), false);
    assert.equal(logList.innerHTML.includes('&lt;img'), true);
});
