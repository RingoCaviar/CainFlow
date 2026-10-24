import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
    return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('workflow-editor selection callers report appearance intent without refresh strategy', async () => {
    const sources = await Promise.all([
        read('../js/canvas/selection.js'),
        read('../js/canvas/canvas-interactions.js'),
        read('../js/features/ui/context-menu-controller.js')
    ]);
    const combined = sources.join('\n');

    assert.match(sources[0], /function notifyChanged[\s\S]{0,400}connectionProjection\.nodeAppearanceChanged\(nodeIds\)/);
    assert.match(sources[1], /function syncMarqueeSelection[\s\S]{0,900}selectionApi\.setSelection\(Array\.from\(desired\)\)/);
    assert.match(sources[1], /selectionApi\.clearSelection\(\);?/);
    assert.match(sources[2], /function ensureNodeSelected[\s\S]{0,300}selectionApi\.selectNode\(nodeEl\.id\)/);
    assert.match(sources[2], /e\.target\.id === 'canvas-container'[\s\S]{0,200}clearSelection\(\)/);
    assert.match(
        await read('../js/nodes/node-lifecycle.js'),
        /function selectNode[\s\S]{0,600}selectionApi\.selectNode\(id, \{ isMulti, notify: false \}\)[\s\S]{0,600}selectionApi\.notifyChanged\(result\.changedNodeIds\)/
    );
    assert.doesNotMatch(combined, /marquee-clear-selection|marquee-selection-end|reason:\s*'marquee-selection'/);
});

test('single-node layout callers report geometry intent without refresh strategy', async () => {
    const sources = await Promise.all([
        read('../js/app/bootstrap-impl.js'),
        read('../js/nodes/node-lifecycle.js'),
        read('../js/nodes/node-dom-bindings.js'),
        read('../js/features/ui/context-menu-controller.js')
    ]);
    const combined = sources.join('\n');

    assert.match(sources[0], /function adjustTextareaHeight[\s\S]{0,500}nodeGeometryChanged/);
    assert.match(sources[1], /function scheduleNodeSizeConnectionRefresh[\s\S]{0,900}nodeGeometryChanged\(nodeIds\)/);
    assert.match(sources[1], /function refreshNodeConnectionGeometry[\s\S]{0,500}nodeGeometryChanged\(nodeId\)/);
    assert.match(sources[1], /scheduleEnsureNodeContentVisible[\s\S]{0,250}nodeGeometryChanged\(nodeId\)/);
    assert.match(sources[2], /function scheduleConnectedInputFieldLayout[\s\S]{0,900}nodeGeometryChanged\(nodeId\)/);
    assert.match(sources[2], /function toggleNodeCollapsed[\s\S]{0,1400}refreshNodesPortGeometry\(changedIds\)/);
    assert.match(
        sources[2],
        /maskPort\.setAttribute[\s\S]{0,300}nodeGeometryChanged\(id\)/
    );
    assert.match(sources[3], /function refreshReferenceImagePorts[\s\S]{0,2200}nodeGeometryChanged\(nodeId\)/);
    assert.doesNotMatch(combined, /reason:\s*'(textarea-height|node-size-observer|node-connection-geometry|node-port-geometry|nodes-port-geometry|connected-input-field-layout|node-collapse)'/);
});
