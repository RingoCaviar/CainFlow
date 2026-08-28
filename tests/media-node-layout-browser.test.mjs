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
    '/usr/bin/chromium-browser'
].filter(Boolean);

const chromePath = chromeCandidates.find(existsSync);
const fixturePath = new URL('./fixtures/media-node-layout.html', import.meta.url);
const EXPECTED_MEASUREMENT_COUNT = 6;
const MIN_VISIBLE_PORTRAIT_WIDTH_RATIO = 0.4;

function renderFixture() {
    assert.ok(chromePath, 'Chrome or Chromium is required for media-node layout tests');
    const profileDir = mkdtempSync(join(tmpdir(), 'cainflow-media-layout-'));
    try {
        const result = spawnSync(chromePath, [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-extensions',
            `--user-data-dir=${profileDir}`,
            '--virtual-time-budget=1000',
            '--dump-dom',
            fixturePath.href
        ], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        const match = result.stdout.match(/<pre id="layout-result">([^<]+)<\/pre>/);
        assert.ok(match, 'layout fixture should publish browser measurements');
        return JSON.parse(match[1].replaceAll('&quot;', '"'));
    } finally {
        rmSync(profileDir, { recursive: true, force: true });
    }
}

test('portrait media stays complete and substantial in image-bearing nodes', () => {
    const measurements = renderFixture();
    assert.equal(measurements.length, EXPECTED_MEASUREMENT_COUNT);
    for (const measurement of measurements) {
        assert.equal(measurement.objectFit, 'contain', `${measurement.kind} should show the complete portrait at ${measurement.zoom} zoom`);
        assert.ok(measurement.visibleWidthRatio >= MIN_VISIBLE_PORTRAIT_WIDTH_RATIO, `${measurement.kind} portrait should not collapse into a thin strip at ${measurement.zoom} zoom`);
        assert.equal(measurement.controlsInsideNode, true, `${measurement.kind} controls should remain inside the node`);
    }
});
