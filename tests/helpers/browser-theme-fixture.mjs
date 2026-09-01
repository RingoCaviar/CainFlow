import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
    const srgb = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
    if (srgb) return srgb.slice(1, 4).map((value) => Number(value) * 255).concat(Number(srgb[4] ?? 1));
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectToPage(port, expectedUrl) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
            const page = targets.find((target) => target.type === 'page' && target.url === expectedUrl.href);
            if (page) return page.webSocketDebuggerUrl;
        } catch {}
        await delay(25);
    }
    throw new Error('Chrome did not expose a debugging page');
}

async function createCdpClient(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        const resolve = pending.get(message.id);
        if (resolve) {
            pending.delete(message.id);
            resolve(message);
        }
    });
    return {
        async send(method, params = {}) {
            const id = ++sequence;
            const response = await new Promise((resolve, reject) => {
                pending.set(id, resolve);
                socket.send(JSON.stringify({ id, method, params }));
                setTimeout(() => {
                    if (pending.delete(id)) reject(new Error(`CDP command timed out: ${method}`));
                }, 5000);
            });
            if (response.error) throw new Error(response.error.message);
            return response.result;
        },
        close() { socket.close(); },
    };
}

export async function renderHoveredFixture(fixtureUrl, profilePrefix) {
    assert.ok(chromePath, 'Chrome or Chromium is required for browser surface tests');
    const profile = mkdtempSync(join(tmpdir(), profilePrefix));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const browser = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
        `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1280,960', fixtureUrl.href,
    ], { stdio: 'ignore' });
    let client;
    try {
        client = await createCdpClient(await connectToPage(port, fixtureUrl));
        let fixtureReady = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const ready = await client.send('Runtime.evaluate', { expression: 'document.readyState === "complete" && Boolean(document.getElementById("hovered"))' });
            if (ready.result.value) {
                fixtureReady = true;
                break;
            }
            await delay(25);
        }
        assert.ok(fixtureReady, 'hover fixture must finish loading');
        const bounds = await client.send('Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("hovered").getBoundingClientRect().toJSON())', returnByValue: true });
        const rectangle = JSON.parse(bounds.result.value);
        const normal = await client.send('Runtime.evaluate', { expression: 'JSON.stringify({ border: getComputedStyle(document.querySelector("#hovered .node-glass-bg")).borderTopColor, shadow: getComputedStyle(document.querySelector("#hovered .node-glass-bg")).boxShadow })', returnByValue: true });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none', pointerType: 'mouse' });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2, button: 'none', pointerType: 'mouse' });
        await delay(250);
        const hovered = await client.send('Runtime.evaluate', { expression: 'JSON.stringify({ matchesHover: document.getElementById("hovered").matches(":hover"), border: getComputedStyle(document.querySelector("#hovered .node-glass-bg")).borderTopColor, shadow: getComputedStyle(document.querySelector("#hovered .node-glass-bg")).boxShadow })', returnByValue: true });
        return { ...JSON.parse(hovered.result.value), normal: JSON.parse(normal.result.value) };
    } finally {
        client?.close();
        browser.kill();
        await new Promise((resolve) => browser.once('exit', resolve));
        rmSync(profile, { recursive: true, force: true });
    }
}
