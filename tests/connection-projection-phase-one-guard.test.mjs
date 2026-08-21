import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function extractBraceBlock(source, marker) {
    const markerIndex = source.indexOf(marker);
    assert.notEqual(markerIndex, -1, `missing caller marker: ${marker}`);
    const openIndex = source.indexOf('{', markerIndex);
    assert.notEqual(openIndex, -1, `missing caller block: ${marker}`);
    let depth = 0;
    for (let index = openIndex; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(markerIndex, index + 1);
    }
    assert.fail(`unterminated caller block: ${marker}`);
}

test('phase-one status and remaining node geometry callers use projection intents', async () => {
    const runtime = await read('../js/features/workflow/workflow-runtime-manager.js');
    const modelSettings = await read('../js/features/settings/model-settings.js');
    const bootstrap = await read('../js/app/bootstrap-impl.js');

    assert.match(runtime, /function applyVisibleNodeRunState[\s\S]{0,2600}nodeAppearanceChanged\(nodeId\)/);
    assert.doesNotMatch(runtime, /function applyVisibleNodeRunState[\s\S]{0,2600}updateAllConnections\(\)/);
    assert.match(modelSettings, /maskPort\.setAttribute[\s\S]{0,300}nodeGeometryChanged\(id\)/);
    assert.match(bootstrap, /function refreshImageGenerateNodes[\s\S]{0,800}nodeGeometryChanged\(nodeIds\)/);
});

test('phase-one migrated callers do not retain rendering strategy vocabulary', async () => {
    const sourceEntries = await Promise.all([
        ['../js/canvas/selection.js', ['function selectAllNodes']],
        ['../js/canvas/canvas-interactions.js', ['function syncMarqueeSelection', 'if (isMarqueeAction)']],
        ['../js/features/ui/context-menu-controller.js', ['function ensureNodeSelected', "if (e.target.id === 'canvas-container'"]],
        ['../js/nodes/node-lifecycle.js', ['function scheduleNodeSizeConnectionRefresh', 'function selectNode', 'function renameNode']],
        ['../js/nodes/node-dom-bindings.js', ['function scheduleConnectedInputFieldLayout', 'function toggleNodeCollapsed', 'function updateImageGenerateMaskPortVisibility']],
        ['../js/features/workflow/workflow-runtime-manager.js', ['function applyVisibleNodeRunState']],
        ['../js/features/settings/model-settings.js', ['function syncImageGenerateResolutionOptions']],
        ['../js/app/bootstrap-impl.js', ['function adjustTextareaHeight', 'function refreshImageGenerateNodes']]
    ].map(async ([path, markers]) => [path, markers, await read(path)]));
    const forbiddenStrategy = /\b(?:updateAllConnections|scheduleConnectionRefresh)\s*\(|\b(?:force|immediate|settle)\s*:/;

    sourceEntries.forEach(([path, markers, source]) => {
        markers.forEach((marker) => {
            assert.doesNotMatch(
                extractBraceBlock(source, marker),
                forbiddenStrategy,
                `${path}: ${marker} selects a rendering strategy`
            );
        });
    });

    const executionSources = await Promise.all([
        read('../js/features/execution/workflow-runner.js'),
        read('../js/features/execution/execution-core.js'),
        read('../js/features/execution/async-media-execution.js')
    ]);
    assert.doesNotMatch(executionSources.slice(1).join('\n'), forbiddenStrategy);
    assert.doesNotMatch(
        executionSources[0].replace(extractBraceBlock(executionSources[0], 'if (injected)'), ''),
        forbiddenStrategy
    );
});
