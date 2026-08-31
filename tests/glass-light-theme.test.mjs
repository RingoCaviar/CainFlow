import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const glassLight = await readFile(new URL('../css/themes/glass-light.css', import.meta.url), 'utf8');

test('Glass Light strong panels retain the approved minimum opacity', () => {
    assert.match(
        glassLight,
        /--panel-bg-strong:\s*var\(--glass-surface-strong\)/,
        'the shared strong-panel role must remain connected to the Glass Light strong surface',
    );

    const strongSurface = glassLight.match(
        /--glass-surface-strong:\s*rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/,
    );
    assert.ok(strongSurface, 'Glass Light must publish an explicit strong surface opacity');
    assert.ok(
        Number(strongSurface[1]) >= 0.58,
        'Glass Light strong panels must retain the approved minimum surface opacity',
    );
});
