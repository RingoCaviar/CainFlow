import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('automatic update checks stay quiet while manual checks, failures and available updates retain feedback', async () => {
    const result = await runUiFixture('tests/fixtures/background-update-check.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.pending, { requests: 0, toasts: 0, directToasts: 0 });
    assert.deepEqual(result.automatic, { requests: 1, status: 'latest', toasts: 0, notices: 0 });
    assert.deepEqual(result.manual, { messages: [
        { message: '正在检查更新...', type: 'info', duration: 0 },
        { message: '当前已是最新版本 (v1.0.0)', type: 'success', duration: 3000 }
    ], dismissals: 1, status: 'latest' });
    assert.deepEqual(result.available, { status: 'new_version', toast: { message: '发现新版本 v2.0.0', type: 'success', duration: 6000 },
        notice: [{ id: 'update-canvas', actions: ['更新通知', '下载更新'] }] });
    assert.equal(result.failed.status, 'error');
    assert.deepEqual(result.failed.types, ['error']);
    assert.ok(result.failed.error);
    assert.deepEqual(result.timeout, { retriedProxyDetection: true, status: 'error', types: ['warning', 'error'] });
    assert.deepEqual(result.disabled, { notScheduled: false, requests: 0, toasts: 0 });
});
