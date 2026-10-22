import { startCainflowServer, chromePath } from './browser-theme-fixture.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function withAppBrowser(session, task) {
    const server = await startCainflowServer({ session });
    const profile = await mkdtemp(join(tmpdir(), 'cainflow-canvas-browser-'));
    const browser = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
    let socket;
    try {
        let port;
        for (let i = 0; i < 100; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); } }
        assert.ok(port, 'Chrome debugging port ready');
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
        socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
        await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
        let sequence = 0; const pending = new Map(), errors = [];
        socket.addEventListener('message', event => { const value = JSON.parse(event.data);
            if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
            if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') errors.push(value.params.args.map(arg => arg.description || arg.value).join(' '));
            if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } });
        const send = async (method, params = {}) => {
            const id = ++sequence;
            const response = await new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
            if (response.error) throw new Error(response.error.message); return response.result;
        };
        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value;
        };
        const waitFor = async expression => {
            for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(50); }
            throw new Error(`Timed out: ${expression}\n${errors.slice(-8).join('\n')}\n${await evaluate('window.__cainflowBootstrapError')}\n${await evaluate('document.body.innerText.slice(-5000)')}`);
        };
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Page.navigate', { url: server.baseUrl });
        await waitFor("Boolean(document.getElementById('prompt-agent-model')?.options.length)"); await delay(500);
        return await task({ evaluate, send, waitFor, server });
    } finally {
        socket?.close(); browser.kill();
        await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve));
        assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
        try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } finally { await server.stop(); }
    }
}
