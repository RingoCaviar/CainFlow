import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

export const chromePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find(existsSync);

export function parseColor(color) {
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        const expanded = hex.length === 3 ? [...hex].map((value) => value + value).join('') : hex;
        return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)).concat(1);
    }
    const values = color.match(/[\d.]+/g).map(Number);
    return [values[0], values[1], values[2], values[3] ?? 1];
}

export function composite(foreground, background) {
    const alpha = foreground[3];
    return [
        foreground[0] * alpha + background[0] * (1 - alpha),
        foreground[1] * alpha + background[1] * (1 - alpha),
        foreground[2] * alpha + background[2] * (1 - alpha), 1,
    ];
}

function luminance(color) {
    const channels = color.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
}

function decodePng(buffer) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const chunks = [];
    for (let offset = 8; offset < buffer.length;) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
    }
    const packed = inflateSync(Buffer.concat(chunks));
    const stride = width * 4;
    const pixels = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => {
        const p = a + b - c;
        const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        return distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
    };
    for (let y = 0, source = 0; y < height; y += 1) {
        const filter = packed[source++];
        for (let x = 0; x < stride; x += 1) {
            const raw = packed[source++];
            const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
            const up = y ? pixels[(y - 1) * stride + x] : 0;
            const upperLeft = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
            const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
            pixels[y * stride + x] = (raw + prediction) & 255;
        }
    }
    return { width, height, pixels };
}

export function pixelDifference(actualBuffer, baselineBuffer) {
    const actual = decodePng(actualBuffer);
    const baseline = decodePng(baselineBuffer);
    assert.deepEqual([actual.width, actual.height], [baseline.width, baseline.height], 'visual baseline dimensions must match');
    let changed = 0;
    for (let index = 0; index < actual.pixels.length; index += 4) {
        const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(actual.pixels[index + channel] - baseline.pixels[index + channel])));
        if (delta > 8) changed += 1;
    }
    return changed / (actual.width * actual.height);
}

export function verifyScreenshotMatrix({ fixtureUrl, baselineDirectoryUrl, profilePrefix, themeIds, threshold = 0.03, windowSize = '1280,960' }) {
    assert.ok(chromePath, 'Chrome or Chromium is required for theme screenshots');
    const outputDir = mkdtempSync(join(tmpdir(), profilePrefix));
    const screenshots = [];
    try {
        for (const themeId of themeIds) {
            const screenshotPath = join(outputDir, `${themeId}.png`);
            const url = new URL(fixtureUrl);
            url.searchParams.set('theme', themeId);
            const result = spawnSync(chromePath, [
                '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
                `--user-data-dir=${join(outputDir, `profile-${themeId}`)}`,
                `--window-size=${windowSize}`, '--virtual-time-budget=1000',
                `--screenshot=${screenshotPath}`, url.href,
            ], { encoding: 'utf8', timeout: 15000 });
            assert.equal(result.status, 0, result.stderr);
            const screenshot = readFileSync(screenshotPath);
            assert.ok(screenshot.length > 10_000, `${themeId} screenshot must contain the rendered state matrix`);
            const baseline = readFileSync(new URL(`${themeId}.png`, baselineDirectoryUrl));
            const difference = pixelDifference(screenshot, baseline);
            assert.ok(difference <= threshold, `${themeId} screenshot difference ${(difference * 100).toFixed(3)}% exceeds threshold`);
            screenshots.push(screenshot.toString('base64'));
        }
        assert.equal(new Set(screenshots).size, themeIds.length, 'each theme screenshot must retain a distinct visual identity');
    } finally {
        rmSync(outputDir, { recursive: true, force: true });
    }
}

export function renderComputedFixture(fixtureUrl, profilePrefix) {
    assert.ok(chromePath, 'Chrome or Chromium is required for browser surface tests');
    const profile = mkdtempSync(join(tmpdir(), profilePrefix));
    try {
        const result = spawnSync(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', `--user-data-dir=${profile}`, '--virtual-time-budget=1000', '--dump-dom', fixtureUrl.href], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        const match = result.stdout.match(/<pre id="surface-result">([^<]+)<\/pre>/);
        assert.ok(match, 'fixture must publish computed styles');
        return JSON.parse(match[1].replaceAll('&quot;', '"'));
    } finally {
        rmSync(profile, { recursive: true, force: true });
    }
}
