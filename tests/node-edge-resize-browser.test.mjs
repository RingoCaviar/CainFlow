import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('node edges expose the matching resize cursors without covering ports or controls', async () => {
    const result = await runUiFixture('tests/fixtures/node-edge-resize.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.handles, [
        { edge: 'left', cursor: 'ew-resize', hit: true },
        { edge: 'right', cursor: 'ew-resize', hit: true },
        { edge: 'top', cursor: 'ns-resize', hit: true },
        { edge: 'bottom', cursor: 'ns-resize', hit: true },
        { edge: 'bottom-right', cursor: 'nwse-resize', hit: true }
    ]);
    assert.deepEqual(result.boundEdges, [
        { edge: 'left', bound: true },
        { edge: 'right', bound: true },
        { edge: 'top', bound: true },
        { edge: 'bottom', bound: true },
        { edge: 'bottom-right', bound: true }
    ]);
    assert.ok(Math.abs(result.inputPort.borderOffset) <= 1, `input port is ${result.inputPort.borderOffset}px from the border`);
    assert.ok(Math.abs(result.outputPort.borderOffset) <= 1, `output port is ${result.outputPort.borderOffset}px from the border`);
    assert.ok(Math.abs(result.inputPort.edgeOffset) <= 0.5, `input port overlaps the card by ${result.inputPort.edgeOffset}px`);
    assert.ok(Math.abs(result.outputPort.edgeOffset) <= 0.5, `output port overlaps the card by ${result.outputPort.edgeOffset}px`);
    assert.equal(result.inputPort.clipPath, 'path("M 11.2 0 A 11.2 11.2 0 0 0 11.2 22.4 Z")');
    assert.equal(result.outputPort.clipPath, 'path("M 11.2 0 A 11.2 11.2 0 0 1 11.2 22.4 Z")');
    assert.equal(result.inputPort.outerHit, true);
    assert.equal(result.outputPort.outerHit, true);
    assert.equal(result.inputPort.seamHit, false);
    assert.equal(result.outputPort.seamHit, false);
    assert.equal(result.inputPort.innerHit, false);
    assert.equal(result.outputPort.innerHit, false);
    assert.equal(result.deleteAccessible, true);
    assert.equal(result.activeCursor, 'ew-resize');
});
