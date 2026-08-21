import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
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
    const sources = await Promise.all([
        read('../js/canvas/selection.js'),
        read('../js/canvas/canvas-interactions.js'),
        read('../js/features/ui/context-menu-controller.js'),
        read('../js/nodes/node-lifecycle.js'),
        read('../js/nodes/node-dom-bindings.js'),
        read('../js/features/execution/workflow-runner.js'),
        read('../js/features/execution/execution-core.js'),
        read('../js/features/execution/async-media-execution.js'),
        read('../js/features/workflow/workflow-runtime-manager.js'),
        read('../js/features/settings/model-settings.js')
    ]);
    const combined = sources.join('\n');

    assert.doesNotMatch(combined, /reason:\s*'(selection-all|marquee-clear-selection|marquee-selection|marquee-selection-end|textarea-height|node-size-observer|node-connection-geometry|node-port-geometry|nodes-port-geometry|connected-input-field-layout|node-collapse)'/);
});
