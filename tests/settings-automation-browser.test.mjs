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
    assert.deepEqual(result.grouping.labels, ['外观与画布', '生成与运行', '通知', '高级']);
    assert.equal(result.grouping.selected, 'canvas');
    assert.equal(result.grouping.restoredCategory, 'generation');
    assert.equal(result.grouping.keyboardEnd, 'advanced');
    assert.equal(result.grouping.keyboardHome, 'canvas');
    assert.deepEqual(result.grouping.fields, {
        'setting-canvas-dense-mode': 'canvas', 'setting-global-export-dir': 'generation', 'toggle-retry': 'generation',
        'toggle-notifications': 'notifications', 'setting-agent-auto-compact-tokens': 'advanced',
        'btn-migrate-browser-storage': 'advanced', 'setting-diagnostic-level': 'advanced'
    });
    assert.match(result.grouping.saveNote, /自动保存/);
    assert.match(result.grouping.saveNote, /保存目录需点击/);
    assert.equal(result.disabledRetry.controlsDisabled, true);
    assert.equal(result.disabledRetry.steppingIgnored, true);
    assert.match(result.disabledRetry.hint, /开启.*后生效/);
    assert.deepEqual(result.retry, { restored: true, enabled: true, writes: 2, controlsEnabled: true });
    assert.deepEqual(result.explicitSave, { unchangedBeforeSave: true, directory: 'D:\\CainFlow\\exports', category: 'generation' });
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
    assert.equal(result.themes.length, 28);
    for (const layout of result.themes) {
        assert.equal(layout.contained, true, `${layout.theme} ${layout.category} overflows`);
        assert.equal(layout.navigationFits, true, `${layout.theme} navigation overflows`);
        assert.equal(layout.directoryReadable, true, `${layout.theme} directory input is too narrow`);
    }
    assert.ok(result.imageSpace < 40, `image settings must retain natural height, got ${result.imageSpace}px of empty space`);
});

test('grouped settings keep every category and field within a narrow dialog in every theme', async () => {
    const result = await runUiFixture('tests/fixtures/settings-automation.html', { windowSize: '360,900' });
    assert.equal(result.error, undefined);
    for (const layout of result.themes) {
        assert.equal(layout.contained, true, `${layout.theme} ${layout.category} overflows`);
        assert.equal(layout.navigationFits, true, `${layout.theme} navigation overflows`);
        assert.equal(layout.directoryReadable, true, `${layout.theme} directory input is too narrow`);
    }
});
