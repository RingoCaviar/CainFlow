import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Agent cache card follows live conversation, compaction and clearing without network or persistence side effects', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-cache.html');
    assert.equal(result.error, undefined);
    const { initial, compacted, followup, cleared } = result.stages;
    assert.equal(initial.detail, '2 个场景 · 3 条消息 · 1 张参考图');
    assert.equal(initial.context, '上下文 2 条 · 归档 0 条 · 摘要 0 份');
    assert.match(initial.total, /^[1-9]\d*(?:\.\d+)? (B|KB|MB)$/);
    assert.notEqual(initial.current, '0 B');
    assert.equal(compacted.detail, initial.detail);
    assert.equal(compacted.context, '上下文 0 条 · 归档 2 条 · 摘要 1 份');
    assert.notEqual(compacted.total, initial.total);
    assert.equal(followup.detail, '2 个场景 · 4 条消息 · 1 张参考图');
    assert.equal(followup.context, '上下文 1 条 · 归档 2 条 · 摘要 1 份');
    assert.equal(cleared.detail, '1 个场景 · 1 条消息 · 0 张参考图');
    assert.equal(cleared.context, '上下文 0 条 · 归档 0 条 · 摘要 0 份');
    assert.equal(cleared.current, '0 B');
    assert.notEqual(cleared.total, '0 B');
    assert.ok(result.closedSkipped && result.forcedWhileClosed);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.stateWrites, 0);
    assert.ok(result.sourceUnchanged);
    assert.ok(result.currentHint && result.compactHint);
    assert.equal(result.themeSamples.length, 6);
    for (const sample of result.themeSamples) {
        assert.ok(sample.cardFits && sample.textFits && !sample.overflow, `${sample.theme} at ${sample.width}px must fit`);
        assert.notEqual(sample.color, 'rgba(0, 0, 0, 0)');
    }
});
