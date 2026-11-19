import assert from 'node:assert/strict';
import test from 'node:test';

import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';

test('Prompt Agent browser flow keeps references, actions, recovery, workflow state and themes observable', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-ui.html');

    assert.equal(result.error, undefined);
    assert.deepEqual(result.referenceConnectionsApplied, ['构图.png', '色彩.webp']);
    assert.ok(result.opened);
    assert.ok(result.unavailable && result.subtleHint);
    assert.ok(result.addModelOpensSettings);
    assert.ok(result.addImageModelOpensSettings);
    assert.ok(result.shellNamed && result.gripHitArea && result.examplePreservesDraft && result.closeRestoresFocus);
    assert.match(result.permissionGuidance, /先预览方案.*直接新建并运行.*已有节点.*仍需确认/);
    for (const [theme, sample] of Object.entries(result.contrastSamples)) {
        const underlay = parseColor(sample.underlay);
        const inputBackground = composite(parseColor(sample.inputBackground), underlay);
        assert.ok(contrastRatio(parseColor(sample.placeholder), inputBackground) >= 4.5, `${theme}: composer placeholder contrast`);
        assert.equal(sample.labels.length, 2);
        for (const label of sample.labels) {
            assert.equal(label.opacity, 1);
            const labelBackground = composite(parseColor(label.background), underlay);
            assert.ok(contrastRatio(parseColor(label.color), labelBackground) >= 4.5, `${theme}: unconfigured model label contrast`);
        }
    }
    assert.ok(result.chatWithoutImageModel);
    assert.ok(result.initiallyRequiresImageModel && result.noImplicitDefault);
    assert.ok(result.createsWithChosenModel && result.changedModelReusesTarget);
    assert.ok(result.invalidModelBlocksActions);
    assert.ok(result.persistsImageModel && result.restoresImageModel && result.newWorkflowHasNoImageModel);
    assert.ok(result.selectIsModern && result.narrowHeaderFits);
    assert.equal(result.widthStyle, '612px');
    assert.ok(result.widthSnapshot);
    assert.ok(result.noTargetActionsReady);
    assert.ok(result.draftDoesNotCreate && result.createsOnGenerate);
    assert.ok(result.persistsBinding && result.followsBoundContext);
    assert.ok(result.retryReusesTarget && result.restoredReusesTarget);
    assert.deepEqual(result.createdNodes, ['image-1']);
    assert.equal(result.selectedNodeCount, 0);
    assert.equal(result.runs.length, 6);
    assert.ok(result.runs.every((run) => run.mode === 'selected-only'
        && run.selectedNodeIds.length === 1 && run.selectedNodeIds[0] === 'image-1'));
    assert.ok(result.summaryCollapsed && result.summaryCanExpand);
    assert.equal(result.referencePreviewCount, 2);
    assert.deepEqual(result.referencesInRequest, ['构图.png', '色彩.webp']);
    assert.deepEqual(result.referencesInWorkflow, ['构图.png', '色彩.webp']);
    assert.ok(result.planMentionsReferences);
    assert.equal(result.copyableText, 'text');
    assert.ok(result.applied);
    assert.ok(result.progressVisible && result.stopped);
    assert.ok(result.failureVisible && result.retriedWithPreview);
    assert.ok(result.resultPreviewActions && result.savesResultBatches);
    assert.equal(result.restoredBatchCount, 2);
    assert.deepEqual(result.focused, ['image-1', 'image-1']);
    for (const theme of ['light', 'dark', 'pink']) {
        assert.equal(result.themeSamples[theme].display, 'flex');
        assert.notEqual(result.themeSamples[theme].color, 'rgba(0, 0, 0, 0)');
        assert.notEqual(result.themeSamples[theme].border, 'rgba(0, 0, 0, 0)');
    }
    assert.ok(result.persistedMessageCount >= 6);
    assert.ok(result.restored && result.clearedForNewWorkflow);
    assert.ok(result.discussionHasNoActions);
});
