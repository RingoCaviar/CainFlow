import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../js/core/state.js';

test('全新应用不预置供应商或模型', () => {
    const state = createInitialState();

    assert.deepEqual(state.providers, []);
    assert.deepEqual(state.models, []);
});
