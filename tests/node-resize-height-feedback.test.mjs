import assert from 'node:assert/strict';
import test from 'node:test';

import { withMinimumMeasurementHeights } from '../js/nodes/node-minimum-measurement.js';
import { settleNodeContentLayout } from '../js/nodes/node-layout-settlement.js';

function createElement({ tagName = 'TEXTAREA', height = '900px', minHeight = '72px', response = false } = {}) {
    return {
        tagName,
        style: { height },
        classList: { contains: (name) => response && name === 'chat-response-area' },
        minHeight
    };
}

test('repeated minimum measurements cannot feed distributed textarea growth back into node height', () => {
    const textarea = createElement();
    const response = createElement({ tagName: 'DIV', height: '1200px', minHeight: '96px', response: true });
    const measured = [];

    for (let index = 0; index < 100; index += 1) {
        measured.push(withMinimumMeasurementHeights(
            [textarea, response],
            () => parseFloat(textarea.style.height) + parseFloat(response.style.height),
            (element) => ({ minHeight: element.minHeight })
        ));
    }

    assert.deepEqual(new Set(measured), new Set([192]));
    assert.equal(textarea.style.height, '900px');
    assert.equal(response.style.height, '1200px');
});

test('settled startup layout always reports final node geometry', () => {
    const events = [];
    settleNodeContentLayout('node-1', {
        ensureVisible: () => events.push('fit'),
        reportGeometry: (nodeId) => events.push(`geometry:${nodeId}`)
    });
    assert.deepEqual(events, ['fit', 'geometry:node-1']);
});
