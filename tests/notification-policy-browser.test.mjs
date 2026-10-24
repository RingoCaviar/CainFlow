import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';

test('status notifications share one slot without merging progress, warnings, errors or handle lifetimes', async () => {
    const result = await runUiFixture('tests/fixtures/notification-policy.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.startup, { messages: ['工作流已保存'], role: 'status', timers: 1 });
    assert.deepEqual(result.important, { messages: ['工作流已保存', '请配置模型', '读取失败'], warningRole: 'alert', errorRole: 'alert' });
    assert.deepEqual(result.progress, {
        messages: ['请配置模型', '读取失败', '视频保存 30%', '图片复制 60%', '受控进度', '进度 50%', '第二次操作完成'],
        persistentConnected: true, longConnected: true, controlledConnected: true, updatedConnected: true
    });
    assert.deepEqual(result.removal, { oldConnected: false, newestConnected: true, newestMessage: '新的操作已完成' });
    assert.deepEqual(result.close, { text: '本次隐藏', name: '本次不再显示工作流备份提醒', title: '本次不再显示工作流备份提醒' });
    assert.deepEqual(result.dismissal, { hidden: true, persistentWrites: 0, sessionValue: 'true', hiddenAfterUpdate: true,
        hiddenAfterRecreate: true, visibleInNewSession: true, legacyPreferenceRetained: true, permanentDefault: 'true' });
    assert.equal(result.themes.length, 7);
    for (const { theme, controls, canvas, root, page } of result.themes) {
        assert.equal(controls.length, 4, theme);
        const backdrop = composite(parseColor(page), composite(parseColor(root), parseColor(canvas)));
        for (const control of controls) {
            assert.equal(control.visible, true, `${theme}: ${control.text}`);
            const surface = composite(parseColor(control.background), backdrop);
            const ratio = contrastRatio(composite(parseColor(control.foreground), surface), surface);
            assert.ok(ratio >= 4.5, `${theme}: ${control.text} contrast ${ratio.toFixed(2)}`);
            assert.ok(control.fontSize >= 11, theme);
        }
    }
});
