import assert from 'node:assert/strict';
import test from 'node:test';

import { createEditedImageImport } from '../js/features/media/image-painter-output.js';

function sourceNode() {
    return {
        type: 'ImageSave', x: 120, y: 85, width: 220,
        imageData: 'original-image',
        el: { getBoundingClientRect: () => ({ width: 300 }) }
    };
}

test('confirmed save-node edit creates and loads a separate image import', async () => {
    const source = sourceNode();
    const calls = [];
    const created = await createEditedImageImport({
        sourceNode: source,
        dataUrl: 'data:image/png;base64,edited',
        addNode: (...args) => { calls.push(['add', ...args]); return 'import-1'; },
        loadImageData: async (...args) => { calls.push(['load', ...args]); return true; },
        removeNode: async () => { assert.fail('successful import must not be removed'); },
        selectNode: (...args) => { calls.push(['select', ...args]); }
    });

    assert.equal(created, true);
    assert.deepEqual(calls, [
        ['add', 'ImageImport', 420, 85],
        ['load', 'import-1', 'data:image/png;base64,edited'],
        ['select', 'import-1', false]
    ]);
    assert.equal(source.imageData, 'original-image');
});

test('failed edited-image persistence removes only the newly created import', async () => {
    const calls = [];
    const created = await createEditedImageImport({
        sourceNode: sourceNode(), dataUrl: 'data:image/png;base64,edited',
        addNode: () => 'import-2',
        loadImageData: async () => false,
        removeNode: async (...args) => { calls.push(args); },
        selectNode: () => { assert.fail('failed import must not be selected'); }
    });

    assert.equal(created, false);
    assert.deepEqual(calls, [['import-2', { onlyId: true, skipHistory: true, showToast: false }]]);
});
