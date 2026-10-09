import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromePath } from './browser-theme-fixture.mjs';

export async function runUiFixture(fixturePath, { screenshotPath = null } = {}) {
    assert.ok(chromePath, 'Chrome is required for UI interaction verification');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const server = createServer(async (request, response) => {
        const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
        if (!path.startsWith(root)) { response.writeHead(403).end(); return; }
        try {
            const content = await readFile(path);
            response.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(path)] || 'application/octet-stream');
            response.end(content);
        } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const profile = await mkdtemp(join(tmpdir(), 'cainflow-ui-'));
    try {
        const url = `http://127.0.0.1:${server.address().port}/${fixturePath}`;
        const output = await new Promise((resolve, reject) => {
            const browser = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', `--user-data-dir=${profile}`, '--window-size=1280,960', '--virtual-time-budget=3000', '--dump-dom',
                ...(screenshotPath ? [`--screenshot=${screenshotPath}`] : []), url]);
            let stdout = '', stderr = '';
            const timeout = setTimeout(() => { browser.kill(); reject(new Error('UI fixture timed out')); }, 20000);
            browser.stdout.on('data', (data) => { stdout += data; });
            browser.stderr.on('data', (data) => { stderr += data; });
            browser.on('error', reject);
            browser.on('exit', (code) => {
                clearTimeout(timeout);
                code === 0 ? resolve(stdout) : reject(new Error(stderr));
            });
        });
        const result = output.match(/<pre id="surface-result">([^<]+)<\/pre>/);
        assert.ok(result, output.slice(-3000));
        return JSON.parse(result[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(profile, { recursive: true, force: true });
    }
}
