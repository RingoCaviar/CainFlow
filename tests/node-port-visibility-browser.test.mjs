import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('save and preview nodes keep straight shell borders behind unoutlined half-circle ports', async () => {
    const result = await runUiFixture('tests/fixtures/node-port-visibility.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.map(({ type, ports }) => [type, ports.length]), [
        ['ImageSave', 4], ['ImagePreview', 2]
    ]);
    for (const card of result) {
        assert.equal(card.nodeOverflow, 'visible', `${card.type} must not clip its ports`);
        assert.equal(card.mediaOverflow, 'hidden', `${card.type} must still clip its media preview`);
        assert.equal(card.stateBordersUnmasked, true, `${card.type} masks a port border in a node state`);
        for (const gap of card.verticalGaps) {
            assert.ok(Math.abs(gap - 6) <= 0.1, `${card.type} has a ${gap}px vertical gap between adjacent ports`);
        }
        for (const { above, below } of card.dividerGaps) {
            assert.ok(above > 0 && below > 0, `${card.type} has a divider touching a port label`);
            assert.ok(Math.abs(above - below) <= 0.2, `${card.type} divider is ${above}px above and ${below}px below its labels`);
        }
        for (const { above, below } of card.rowBandGaps) {
            assert.ok(Math.abs(above - below) <= 0.2, `${card.type} port is ${above}px above and ${below}px below its center`);
        }
        for (const port of card.ports) {
            assert.equal(port.outerHit, true, `${card.type} ${port.direction} ${port.name} is clipped`);
            assert.equal(port.innerHit, false, `${card.type} ${port.direction} ${port.name} overlaps the card`);
            assert.ok(Math.abs(port.edgeOffset) <= 0.5, `${card.type} ${port.direction} ${port.name} is ${port.edgeOffset}px off the edge`);
            assert.ok(Math.abs(port.labelInset - 12) <= 0.5, `${card.type} ${port.direction} ${port.name} label is ${port.labelInset}px from the edge`);
            assert.ok(Math.abs(port.labelDotCenterOffset) <= 0.2, `${card.type} ${port.direction} ${port.name} label is ${port.labelDotCenterOffset}px off the circle center`);
            assert.equal(port.hasUnmaskedBorder, true, `${card.type} ${port.name} has an outline or masks the shell border`);
        }
    }
});
