import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('general settings retain automation state and notification permission behavior after every render', async () => {
    const result = await runUiFixture('tests/fixtures/settings-automation.html');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.controls, {
        retryCard: '自动化与重试', notificationCard: '通知设置', retryLoaded: true,
        notificationsLoaded: false, sidebarControl: false, toolbarLabel: '统一顶部工具栏固定显示'
    });
    assert.deepEqual(result.retry, { restored: true, enabled: true, writes: 2 });
    for (const outcome of [result.unsupported, result.denied, result.failedTest]) {
        assert.equal(outcome.enabled, false);
        assert.equal(outcome.checked, false);
        assert.equal(outcome.saved, false);
        assert.equal(outcome.toast.type, 'warning');
    }
    assert.match(result.unsupported.toast.message, /不支持系统通知/);
    assert.match(result.denied.toast.message, /未开启通知权限/);
    assert.equal(result.denied.permissionRequests, 1);
    assert.equal(result.denied.notices, 0);
    assert.equal(result.success.enabled, true);
    assert.equal(result.success.checked, true);
    assert.equal(result.success.saved, true);
    assert.equal(result.success.permissionRequests, 2);
    assert.equal(result.success.readyCalls, 1);
    assert.deepEqual(result.success.notices, [{ title: 'CainFlow 运行通知已开启',
        body: '之后工作流运行结束时，你会收到系统通知。', tag: 'cainflow-notification-test' }]);
    assert.equal(result.disabled.restored, true);
    assert.equal(result.disabled.enabled, false);
    assert.equal(result.disabled.saved, false);
    assert.equal(result.disabled.paused, 1);
    assert.equal(result.disabled.audioSrc, '');
    assert.equal(result.disabled.audioCleared, true);
    assert.match(result.failedTest.toast.message, /系统通知测试失败/);
    assert.equal(result.failedTest.permissionRequests, 2);
    assert.equal(result.failedTest.notices, 2);
});
