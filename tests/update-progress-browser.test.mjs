import test from 'node:test';
import assert from 'node:assert/strict';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('download progress is visible in settings, update dialog and persistent notice across themes', async () => {
    const result = await runUiFixture('tests/fixtures/update-progress.html');
    assert.equal(result.error, undefined, result.error);
    for (const sample of result.samples) {
        assert.ok(sample.height >= 8, `${sample.theme}/${sample.surface}: visible track`);
        assert.ok(sample.barHeight >= 8, `${sample.theme}/${sample.surface}: visible fill`);
        assert.ok(Math.abs(sample.ratio - 0.42) < 0.01, `${sample.theme}/${sample.surface}: 42% width`);
        assert.equal(sample.percent, '42%');
        assert.match(sample.detail, /42.00 MB.*100.00 MB.*2.00 MB\/s/s);
    }
    for (const sample of result.unknown) {
        assert.equal(sample.percent, '计算中');
        assert.equal(sample.indeterminate, true);
        assert.ok(sample.height >= 8);
        if (!result.reducedMotion) assert.notEqual(sample.animation, 'none', 'functional progress survives disabled decorative animation');
        assert.equal(sample.value, null, 'unknown progress has no numeric accessibility value');
    }
    assert.deepEqual(result.derived, ['42%', '42%', '42%']);
    assert.deepEqual(result.zero, ['0%', '0%', '0%']);
});
