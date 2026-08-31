import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseColor } from './helpers/browser-theme-fixture.mjs';

const themeIds = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];
const portRoles = ['image', 'text', 'params', 'any'];

function token(stylesheet, role) {
    const match = stylesheet.match(new RegExp(`--${role}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(match, `${role} must resolve to an opaque hex token`);
    return parseColor(match[1]);
}

test('every theme keeps type ports and status semantics distinguishable', async () => {
    for (const themeId of themeIds) {
        const stylesheet = await readFile(new URL(`../css/themes/${themeId}.css`, import.meta.url), 'utf8');
        const ports = portRoles.map((role) => token(stylesheet, `port-${role}`));
        const statuses = ['accent-green', 'accent-orange', 'accent-red'].map((role) => token(stylesheet, role));

        assert.equal(new Set(ports.map((color) => color.join(','))).size, ports.length, `${themeId} port types must remain distinct`);
        assert.equal(new Set(statuses.map((color) => color.join(','))).size, statuses.length, `${themeId} success, warning, and failure remain distinct`);
    }
});
