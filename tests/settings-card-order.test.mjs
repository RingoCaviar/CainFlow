import assert from 'node:assert/strict';
import test from 'node:test';

import {
    reorderItemsById,
    toggleOrderedId
} from '../js/features/settings/settings-card-order.js';

test('card order follows the committed ids without cloning configurations', () => {
    const first = { id: 'first', name: 'First' };
    const second = { id: 'second', name: 'Second' };
    const third = { id: 'third', name: 'Third' };

    const reordered = reorderItemsById([first, second, third], ['third', 'first', 'second']);

    assert.deepEqual(reordered, [third, first, second]);
    assert.equal(reordered[0], third);
});

test('unknown or missing ids cannot discard configurations', () => {
    const items = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];

    assert.deepEqual(
        reorderItemsById(items, ['unknown', 'second']),
        [items[1], items[0], items[2]]
    );
});

test('editing provider bindings preserves their existing request priority', () => {
    assert.deepEqual(toggleOrderedId(['provider-b', 'provider-a'], 'provider-c'), [
        'provider-b',
        'provider-a',
        'provider-c'
    ]);
    assert.deepEqual(toggleOrderedId(['provider-b', 'provider-a'], 'provider-a'), ['provider-b']);
});
