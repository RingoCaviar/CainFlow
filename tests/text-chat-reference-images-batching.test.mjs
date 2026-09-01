import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildInputBatches,
    shouldRunNodeForEachInput
} from '../js/features/execution/workflow-runner.js';

test('TextChat keeps multiple reference images in one request batch', () => {
    const node = { type: 'TextChat' };
    const inputs = {
        referenceImages: ['first-image', 'second-image']
    };

    assert.equal(shouldRunNodeForEachInput(node, inputs), false);
    assert.deepEqual(buildInputBatches(node, inputs), [inputs]);
});

test('TextChat still runs once per ordinary batch input while preserving reference images', () => {
    const node = { type: 'TextChat' };
    const inputs = {
        prompt: ['first prompt', 'second prompt'],
        referenceImages: ['first-image', 'second-image']
    };

    assert.equal(shouldRunNodeForEachInput(node, inputs), true);
    assert.deepEqual(buildInputBatches(node, inputs), [
        { prompt: 'first prompt', referenceImages: ['first-image', 'second-image'] },
        { prompt: 'second prompt', referenceImages: ['first-image', 'second-image'] }
    ]);
});
