import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('workflow execution state reports appearance intent for affected nodes', async () => {
    const source = await read('../js/features/execution/workflow-runner.js');

    assert.match(source, /function markNodeRunning[\s\S]{0,800}nodeAppearanceChanged\(nodeId\)/);
    assert.match(source, /function clearNodeRunning[\s\S]{0,900}nodeAppearanceChanged\(nodeId\)/);
    assert.match(source, /function resetNodesForPlan[\s\S]{0,2200}nodeAppearanceChanged\(changedNodeIds\)/);
    assert.match(source, /emptyImageNodes\.forEach[\s\S]{0,600}nodeAppearanceChanged\(emptyImageNodes\)/);
    assert.match(source, /emptyPromptNodes\.forEach[\s\S]{0,600}nodeAppearanceChanged\(emptyPromptNodes\)/);
    assert.doesNotMatch(source, /scheduleRunningConnectionRefresh|runningConnectionRefreshFrame/);
});

test('execution output and asynchronous recovery report geometry intent', async () => {
    const runner = await read('../js/features/execution/workflow-runner.js');
    const core = await read('../js/features/execution/execution-core.js');
    const asyncMedia = await read('../js/features/execution/async-media-execution.js');

    assert.match(runner, /function commitConcurrentBatchResults[\s\S]{0,5000}nodeGeometryChanged\(node\.id\)/);
    assert.match(runner, /function executeNodeWithInputBatches[\s\S]{0,9000}nodeGeometryChanged\(node\.id\)/);
    assert.match(runner, /releaseWorkflowIntermediateImageResults[\s\S]{0,300}nodeGeometryChanged\(Array\.from\(completedNodes\)\)/);
    assert.match(core, /createAsyncMediaExecutionApi\([\s\S]{0,1800}connectionProjection/);
    assert.doesNotMatch(core, /updateAllConnections\(\)/);
    assert.doesNotMatch(asyncMedia, /updateAllConnections\(\)/);
    assert.match(core, /ImageGenerate:[\s\S]{0,20000}nodeGeometryChanged\(id\)/);
    assert.match(core, /TextChat:[\s\S]{0,15000}nodeGeometryChanged\(id\)/);
    assert.match(core, /ImageMerge:[\s\S]{0,1500}nodeGeometryChanged\(node\.id\)/);
    assert.match(core, /TextMerge:[\s\S]{0,1200}nodeGeometryChanged\(node\.id\)/);
    assert.match(core, /Text:[\s\S]{0,1800}nodeGeometryChanged\(node\.id\)/);
    assert.match(core, /CameraControl:[\s\S]{0,1200}nodeGeometryChanged\(node\.id\)/);
    assert.match(core, /TextSplit:[\s\S]{0,3000}nodeGeometryChanged\(node\.id\)/);
    assert.match(asyncMedia, /function finalizeAsyncImageGeneration[\s\S]{0,5000}nodeGeometryChanged\(node\.id\)/);
    assert.match(asyncMedia, /function runAsyncImageGeneration[\s\S]{0,12000}nodeGeometryChanged\(id\)/);
    assert.match(asyncMedia, /resumeVideoGeneration[\s\S]{0,9000}nodeGeometryChanged\(nodeId\)/);
    assert.match(asyncMedia, /function runVideoGenerateNode[\s\S]{0,18000}nodeGeometryChanged\(id\)/);

    const combined = [runner, core, asyncMedia].join('\n');
    assert.doesNotMatch(combined, /\b(?:force|immediate|settle)\s*:/);
});
