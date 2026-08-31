import assert from 'node:assert/strict';
import test from 'node:test';
import { renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('real node surfaces and controls layer above the continuous border shell', () => {
    const fixture = new URL('./fixtures/node-border-continuity.html', import.meta.url);
    const result = renderComputedFixture(fixture, 'cainflow-node-border-');

    assert.equal(result.shell, '0');
    assert.equal(result.header, '1');
    assert.equal(result.body, '1');
    assert.equal(result.ports, '1');
    assert.ok(Number(result.port) > Number(result.shell));
    assert.ok(Number(result.resize) > Number(result.shell));
});
