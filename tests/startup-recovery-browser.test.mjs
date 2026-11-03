import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

for (const blockedPath of ['/index.js', '/js/app/bootstrap.js', '/js/app/bootstrap-impl.js']) {
test(`load failure at ${blockedPath} does not leave an empty canvas without recovery`, async () => {
    const result = await runUiFixture('tests/fixtures/startup-recovery.html', {
        blockedPaths: [blockedPath]
    });
    assert.equal(result.nodes, 0);
    assert.equal(result.ready, false);
    assert.equal(result.visible, true);
    assert.match(result.message, /启动失败/);
    assert.equal(result.error, undefined);
    assert.equal(result.opened, true);
    assert.equal(result.cancelled, true);
    assert.equal(result.escapeCancelled, true);
    assert.equal(result.focusReturned, true);
});
}
