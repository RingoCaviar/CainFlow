import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = chromeCandidates.find(existsSync);
const fixturePath = new URL('./fixtures/settings-theme-surface.html', import.meta.url);

function parseColor(color) {
    const channels = color.match(/[\d.]+/g).map(Number);
    return [channels[0], channels[1], channels[2], channels[3] ?? 1];
}

function composite(foreground, background) {
    const alpha = foreground[3];
    return [
        foreground[0] * alpha + background[0] * (1 - alpha),
        foreground[1] * alpha + background[1] * (1 - alpha),
        foreground[2] * alpha + background[2] * (1 - alpha),
        1,
    ];
}

function luminance(color) {
    const linear = color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

function opaquePageBackground(measurement) {
    const browserCanvas = [255, 255, 255, 1];
    const root = composite(parseColor(measurement.actual.rootBackground), browserCanvas);
    return composite(parseColor(measurement.actual.pageBackground), root);
}

function firstShadowColor(shadow) {
    const color = shadow.match(/rgba?\([^)]*\)/)?.[0];
    assert.ok(color, `focus shadow must expose a computed color: ${shadow}`);
    return parseColor(color);
}

function renderFixture() {
    assert.ok(chromePath, 'Chrome or Chromium is required for settings theme surface tests');
    const profileDir = mkdtempSync(join(tmpdir(), 'cainflow-settings-theme-'));
    try {
        const result = spawnSync(chromePath, [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-extensions',
            `--user-data-dir=${profileDir}`,
            '--virtual-time-budget=1000',
            '--dump-dom',
            fixturePath.href,
        ], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        const match = result.stdout.match(/<pre id="surface-result">([^<]+)<\/pre>/);
        assert.ok(match, 'settings theme fixture should publish computed styles');
        return JSON.parse(match[1].replaceAll('&quot;', '"'));
    } finally {
        rmSync(profileDir, { recursive: true, force: true });
    }
}

test('settings surfaces render from the semantic palette in every supported theme', () => {
    const measurements = renderFixture();
    assert.equal(measurements.length, 7);

    for (const measurement of measurements) {
        const {
            rootBackground: _rootBackground,
            pageBackground: _pageBackground,
            overlayBackground: _overlayBackground,
            ...surfaceActual
        } = measurement.actual;
        assert.deepEqual(
            surfaceActual,
            measurement.semantic,
            `${measurement.themeId} settings surfaces must render from the semantic palette`,
        );
        assert.equal(
            measurement.semanticRolesPresent,
            true,
            `${measurement.themeId} must provide the shared panel and text roles`,
        );
        assert.equal(measurement.controlStates.length, 10);
        const pageBackground = opaquePageBackground(measurement);
        const overlayBackground = composite(parseColor(measurement.actual.overlayBackground), pageBackground);
        const panelBackground = composite(parseColor(measurement.actual.panelBackground), overlayBackground);
        const cardBackground = composite(parseColor(measurement.actual.cardBackground), panelBackground);
        const bodyText = composite(parseColor(measurement.actual.bodyTextColor), cardBackground);
        const bodyRatio = contrastRatio(bodyText, cardBackground);
        assert.ok(
            bodyRatio >= 4.5,
            `${measurement.themeId} settings body text contrast ${bodyRatio.toFixed(2)} must meet WCAG AA`,
        );
        for (const control of measurement.controlStates) {
            assert.deepEqual(
                control.actual,
                control.semantic,
                `${measurement.themeId} ${control.kind} ${control.state} must use the semantic state`,
            );
            if (control.state !== 'disabled') {
                const controlBackground = composite(parseColor(control.actual.background), cardBackground);
                const foreground = composite(parseColor(control.actual.color), controlBackground);
                const ratio = contrastRatio(foreground, controlBackground);
                assert.ok(
                    ratio >= 4.5,
                    `${measurement.themeId} ${control.kind} ${control.state} contrast ${ratio.toFixed(2)} must meet WCAG AA`,
                );
            }
        }
        for (const kind of ['input', 'select']) {
            const normal = measurement.controlStates.find((control) => control.kind === kind && control.state === 'normal');
            const focus = measurement.controlStates.find((control) => control.kind === kind && control.state === 'focus');
            assert.notEqual(focus.actual.shadow, 'none', `${measurement.themeId} ${kind} focus ring must be visible`);
            assert.notDeepEqual(
                { border: focus.actual.border, shadow: focus.actual.shadow },
                { border: normal.actual.border, shadow: normal.actual.shadow },
                `${measurement.themeId} ${kind} focus must be visually distinct from normal`,
            );
            const focusRing = composite(firstShadowColor(focus.actual.shadow), cardBackground);
            const focusRatio = contrastRatio(focusRing, cardBackground);
            assert.ok(
                focusRatio >= 3,
                `${measurement.themeId} ${kind} focus ring contrast ${focusRatio.toFixed(2)} must meet WCAG 2.2 non-text contrast`,
            );
        }
    }
});
