import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('save and preview nodes expose every outside port half while clipping only media previews', async () => {
    const result = await runUiFixture('tests/fixtures/node-port-visibility.html');
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.map(({ type, ports }) => [type, ports.length]), [
        ['ImageSave', 4], ['ImagePreview', 2]
    ]);
    for (const card of result) {
        assert.equal(card.nodeOverflow, 'visible', `${card.type} must not clip its ports`);
        assert.equal(card.mediaOverflow, 'hidden', `${card.type} must still clip its media preview`);
        for (const port of card.ports) {
            assert.equal(port.outerHit, true, `${card.type} ${port.direction} ${port.name} is clipped`);
        }
    }
});
