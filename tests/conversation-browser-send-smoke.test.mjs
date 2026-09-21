import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { chromePath } from './helpers/browser-theme-fixture.mjs';

const enabled = process.env.CAINFLOW_BROWSER_SMOKE === '1';
const targetUrl = process.env.CAINFLOW_BROWSER_SMOKE_URL || 'http://localhost:8767/';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('browser: sending without configuration gives a visible setup next step', { skip: !enabled }, async () => {
    assert.ok(chromePath, 'Chrome or Chromium is required');
    const port = 34000 + Math.floor(Math.random() * 1000);
    const browser = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
        `--remote-debugging-port=${port}`, targetUrl
    ], { stdio: 'ignore' });
    let socket;
    try {
        let endpoint = '';
        for (let attempt = 0; attempt < 120; attempt += 1) {
            try {
                const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
                endpoint = pages.find((page) => page.type === 'page')?.webSocketDebuggerUrl || '';
                if (endpoint) break;
            } catch {}
            await delay(50);
        }
        assert.ok(endpoint, 'browser did not expose a debugging page');
        socket = new WebSocket(endpoint);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        let sequence = 0;
        const replies = new Map();
        const browserErrors = [];
        socket.addEventListener('message', ({ data }) => {
            const message = JSON.parse(data);
            if (message.method === 'Network.loadingFailed') browserErrors.push(message.params.errorText);
            if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
            const resolve = replies.get(message.id);
            if (resolve) { replies.delete(message.id); resolve(message); }
        });
        const evaluate = async (expression) => {
            const id = ++sequence;
            const reply = new Promise((resolve) => replies.set(id, resolve));
            socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
            const message = await reply;
            assert.equal(message.exceptionDetails, undefined, message.exceptionDetails?.text);
            return message.result.result.value;
        };
        await new Promise((resolve) => {
            const id = ++sequence;
            replies.set(id, resolve);
            socket.send(JSON.stringify({ id, method: 'Network.enable' }));
        });
        for (let attempt = 0; attempt < 160; attempt += 1) {
            if (await evaluate('window.__cainflowAppReady === true')) break;
            await delay(50);
        }
        const bootState = JSON.parse(await evaluate("JSON.stringify({ ready: window.__cainflowAppReady === true, error: window.__cainflowBootstrapError || '' })"));
        assert.equal(bootState.ready, true, `application must finish booting: ${bootState.error}; browser: ${browserErrors.join(' | ')}`);
        await evaluate("document.getElementById('btn-workspace-conversation').click()");
        await evaluate("document.getElementById('conversation-composer').value='浏览器发送探针'; document.getElementById('conversation-send').click()");
        await delay(400);
        const result = JSON.parse(await evaluate("JSON.stringify({ mode: document.body.dataset.workspaceMode, title: document.getElementById('conversation-title').textContent, guidance: document.getElementById('conversation-guidance').textContent, visible: !document.getElementById('conversation-guidance').hidden })"));
        assert.equal(result.mode, 'conversation');
        assert.equal(result.title, '新对话');
        assert.equal(result.visible, true);
        assert.match(result.guidance, /还没有可用的对话模型|请选择一个对话模型|Provider/);
    } finally {
        socket?.close();
        browser.kill();
        await new Promise((resolve) => browser.once('exit', resolve));
    }
});
