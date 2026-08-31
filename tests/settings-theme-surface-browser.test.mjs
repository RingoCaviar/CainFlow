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
        assert.deepEqual(
            measurement.actual,
            measurement.semantic,
            `${measurement.themeId} settings surfaces must render from the semantic palette`,
        );
        assert.equal(
            measurement.semanticRolesPresent,
            true,
            `${measurement.themeId} must provide the shared panel and text roles`,
        );
    }
});
