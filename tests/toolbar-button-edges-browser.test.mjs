import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { composite, contrastRatio, parseColor, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

test('the application loads the button edge stylesheet after theme skins', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const themeSkin = html.indexOf('href="css/features/node-canvas-theme-skin.css"');
    const buttonEdges = html.indexOf('href="css/features/button-edges.css"');
    assert.ok(themeSkin >= 0 && buttonEdges > themeSkin, 'button edges must load in the real application after theme skins');
});

test('toolbar controls have visible edges in all seven themes', () => {
    const appHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const stylesheetLinks = [...appHtml.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]
        .map(([, href]) => `<link rel="stylesheet" href="${href}">`)
        .join('\n');
    const fixtureTemplate = readFileSync(new URL('./fixtures/toolbar-button-edges.html', import.meta.url), 'utf8');
    const fixtureHtml = fixtureTemplate.replace('<!-- application styles -->',
        `<base href="${new URL('../', import.meta.url).href}">\n${stylesheetLinks}`);
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'cainflow-toolbar-app-css-'));
    let measurements;
    try {
        const fixturePath = join(fixtureDirectory, 'toolbar.html');
        writeFileSync(fixturePath, fixtureHtml);
        measurements = renderComputedFixture(pathToFileURL(fixturePath), 'cainflow-toolbar-edges-');
    } finally {
        rmSync(fixtureDirectory, { recursive: true, force: true });
    }
    assert.equal(measurements.length, 7);

    for (const measurement of measurements) {
        const root = composite(parseColor(measurement.rootBackground), [255, 255, 255, 1]);
        const page = composite(parseColor(measurement.pageBackground), root);
        const toolbar = composite(parseColor(measurement.toolbarBackground), page);
        assert.equal(measurement.toolbarGap, '8px');
        assert.equal(measurement.dividerDisplay, 'none');
        assert.equal(measurement.controls.length, 8);
        for (const control of measurement.controls) {
            assert.equal(control.height, 38, `${measurement.themeId} ${control.kind} must match toolbar control height`);
            assert.equal(control.borderWidth, '2px', `${measurement.themeId} ${control.kind} needs a clear two-pixel edge`);
            assert.equal(control.borderStyle, 'solid');
            const border = parseColor(control.borderColor);
            border[3] *= Number(control.opacity);
            const edge = composite(border, toolbar);
            const ratio = contrastRatio(edge, toolbar);
            assert.ok(ratio >= (Number(control.opacity) < 1 ? 1.5 : 1.8),
                `${measurement.themeId} ${control.kind} edge contrast ${ratio.toFixed(2)} is too faint`);
        }
        for (let index = 1; index < measurement.controls.length; index += 1) {
            const previous = measurement.controls[index - 1];
            const current = measurement.controls[index];
            if (current.top === previous.top) {
                assert.ok(Math.abs(current.left - previous.right - 8) <= 0.5,
                    `${measurement.themeId} ${previous.kind}/${current.kind} gap must be 8px`);
            } else {
                assert.ok(Math.abs(current.top - previous.top - 46) <= 0.5,
                    `${measurement.themeId} wrapped toolbar rows need the same 8px gap`);
            }
        }

    }
});
