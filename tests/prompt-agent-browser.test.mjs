import assert from 'node:assert/strict';
import test from 'node:test';

import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('Prompt Agent browser flow keeps references, actions, recovery, workflow state and themes observable', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-ui.html');

    assert.equal(result.error, undefined);
    assert.ok(result.opened);
    assert.equal(result.widthStyle, '612px');
    assert.ok(result.widthSnapshot >= 600);
    assert.ok(result.noTargetDisabled);
    assert.ok(result.summaryCollapsed && result.summaryCanExpand);
    assert.equal(result.referencePreviewCount, 2);
    assert.deepEqual(result.referencesInRequest, ['构图.png', '色彩.webp']);
    assert.deepEqual(result.referencesInWorkflow, ['构图.png', '色彩.webp']);
    assert.ok(result.planMentionsReferences);
    assert.ok(result.applied);
    assert.ok(result.progressVisible && result.stopped);
    assert.ok(result.failureVisible && result.retriedWithPreview);
    assert.deepEqual(result.focused, ['image-1']);
    for (const theme of ['light', 'dark', 'pink']) {
        assert.equal(result.themeSamples[theme].display, 'flex');
        assert.notEqual(result.themeSamples[theme].color, 'rgba(0, 0, 0, 0)');
        assert.notEqual(result.themeSamples[theme].border, 'rgba(0, 0, 0, 0)');
    }
    assert.ok(result.persistedMessageCount >= 6);
    assert.ok(result.restored && result.clearedForNewWorkflow);
});
