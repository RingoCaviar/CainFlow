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

test('execution history preserves distinct attempts and restores unfinished requests as interrupted', () => {
    const localStorageRef = storage();
    const state = { logs: [] };
    const renderErrorModal = () => assert.fail('request outcome must not open an error modal');
    const api = createLogPanelApi({ state, elements: {}, renderErrorModal, localStorageRef });
    const start = () => api.logRequestToPanel('生成图片', 'https://provider.invalid/generate?key=fixture-secret',
        { prompt: 'fixture' }, { requestStatus: 'pending' });
    const finish = start();
    const finishOther = start();
    finish('failed', { error: '请求失败' });
    assert.deepEqual(state.logs.map(log => log.requestStatus), ['pending', 'failed']);
    assert.doesNotMatch(localStorageRef.read(), /fixture-secret/);

    const restored = { logs: [] };
    const restoredApi = createLogPanelApi({ state: restored, elements: {}, renderErrorModal, localStorageRef });
    restoredApi.initializeLogs();
    assert.deepEqual(restored.logs.map(log => log.requestStatus), ['interrupted', 'failed']);
    api.clearLogs();
    finishOther('success');
    assert.deepEqual(state.logs, []);
});
