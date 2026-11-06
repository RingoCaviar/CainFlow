import { startCainflowServer, chromePath } from './browser-theme-fixture.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { sanitizeDetails } from '../../js/services/api-client.js';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Startup can intentionally wait for a user decision (for example retiring Save
// nodes). Such a dialog is already an interactive boundary for its test.
const appInteractive = "window.__cainflowAppReady===true || Boolean(document.querySelector('#app-action-dialog:not(.hidden)'))";
export async function waitForAutosave({ waitFor }) {
    // The session cache itself is debounced; don't read its previous clean
    // snapshot before the new edit has reached it.
    await delay(3100);
    await waitFor("import('/js/app/bootstrap.js').then(module=>module.bootstrapCainFlowApp()).then(app=>!app.workflowManagerApi.hasPendingAutosave())");
    await waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>!document.value?.workflowTabs?.some(tab=>tab.dirty || tab.identityPendingSave))");
}
export async function reloadAppBrowser({ evaluate, send, waitFor }) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    // Let the product finish autosaving before navigating; otherwise Chromium
    // correctly opens its native beforeunload protection dialog.
    await waitForAutosave({ waitFor });
    const previous = await evaluate('performance.timeOrigin');
    const ready = `performance.timeOrigin!==${previous} && (${appInteractive})`;
    const waitUntilReady = async () => {
        try { await waitFor(ready); }
        catch (error) {
            if (!String(error).includes('Inspected target navigated or closed')) throw error;
            await waitFor(ready);
        }
    };
    await send('Page.reload', { ignoreCache: true });
    try { await waitUntilReady(); }
    catch (error) {
        if (!String(error).includes('Failed to fetch dynamically imported module')) throw error;
        await send('Page.reload', { ignoreCache: true });
        await waitUntilReady();
    }
    await delay(500);
}

// Legacy graph fixtures intentionally retain their Save nodes. Cancel only the
// retirement prompt; migration tests can opt out and exercise either response.
export async function withAppBrowser(session, task, { repoDirectory, initScript, preserveRetiredSaveNodes = true } = {}) {
    const server = await startCainflowServer({ session, repoDirectory });
    const profile = await mkdtemp(join(tmpdir(), 'cainflow-canvas-browser-'));
    const browser = spawn(chromePath, ['--headless=new', '--no-proxy-server', '--disable-gpu', '--no-sandbox', '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
    let socket, getDiagnostics = () => ({ backend: server.getDiagnostics() });
    try {
        let port;
        for (let i = 0; i < 100; i++) { try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(50); } }
        assert.ok(port, 'Chrome debugging port ready');
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
        socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
        await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
        let sequence = 0, requestSequence = 0, currentStep = null;
        const protocolListeners = new Set();
        const pending = new Map(), errors = [], networkFailures = [], httpFailures = [], requests = new Map(), completedRequests = [], workflowWrites = [];
        const publicUrl = raw => {
            try {
                const url = new URL(raw);
                return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname.slice(0, 300) : url.protocol;
            } catch { return 'invalid URL'; }
        };
        const describeRequest = ({ bodyPromise, ...record }) => record;
        getDiagnostics = () => ({ backend: server.getDiagnostics(), step: currentStep?.label,
            workflowWrites: workflowWrites.map(describeRequest), networkFailures: networkFailures.map(describeRequest), httpFailures: httpFailures.map(describeRequest) });
        const retain = (list, item, limit = 24) => { list.push(item); if (list.length > limit) list.shift(); };
        socket.addEventListener('message', event => { const value = JSON.parse(event.data);
            if (value.method === 'Network.requestWillBeSent') {
                requests.set(value.params.requestId, { sequence: ++requestSequence, requestId: value.params.requestId,
                    url: publicUrl(value.params.request.url), method: value.params.request.method, startedAt: Date.now() });
                if (value.params.request.url.startsWith(server.baseUrl + '/api/workflows/')) {
                    const record = requests.get(value.params.requestId);
                    if (record.method === 'POST') {
                        try {
                            const data = JSON.parse(value.params.request.postData || '{}');
                            record.workflowId = data.workflowId;
                            record.mediaOwnershipRevision = data.mediaOwnershipRevision;
                            record.expectedMediaOwnershipRevision = value.params.request.headers['X-CainFlow-Expected-Media-Ownership-Revision'];
                        } catch {}
                    }
                    retain(workflowWrites, record, 24);
                }
                if (requests.size > 1000) requests.delete(requests.keys().next().value);
            }
            if (value.method === 'Network.responseReceived') {
                const record = requests.get(value.params.requestId);
                if (record) {
                    record.status = value.params.response.status;
                    if (record.status >= 400) retain(httpFailures, record);
                }
            }
            if (value.method === 'Network.loadingFailed') {
                const record = requests.get(value.params.requestId) || { requestId: value.params.requestId };
                retain(networkFailures, { ...record, error: value.params.errorText, finishedAt: Date.now(),
                    canceled: value.params.canceled === true, blockedReason: value.params.blockedReason });
                requests.delete(value.params.requestId);
            }
            if (value.method === 'Network.loadingFinished') {
                const record = requests.get(value.params.requestId);
                if (record) {
                    record.finishedAt = Date.now();
                    retain(completedRequests, record, 128);
                    // Capture only bounded local API error fields, never headers,
                    // submitted images, credentials or arbitrary response bodies.
                    if (record.status >= 400 && record.url.startsWith(server.baseUrl + '/api/') && value.params.encodedDataLength < 65536) {
                        record.bodyPromise = send('Network.getResponseBody', { requestId: record.requestId }, 1000).then(body => {
                            const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
                            const payload = JSON.parse(text);
                            record.detail = sanitizeDetails({ error: payload.error, message: payload.message, detail: payload.detail });
                        }).catch(() => {});
                    }
                }
                requests.delete(value.params.requestId);
            }
            for (const listener of protocolListeners) listener(value);
            if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
            if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') errors.push(value.params.args.map(arg => arg.description || arg.value).join(' '));
            if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } });
        const send = async (method, params = {}, timeout = 15000) => {
            const id = ++sequence;
            const response = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, timeout);
                pending.set(id, value => { clearTimeout(timer); resolve(value); });
                socket.send(JSON.stringify({ id, method, params }));
            });
            if (response.error) throw new Error(response.error.message); return response.result;
        };
        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value;
        };
        const checkStep = async () => {
            if (!currentStep) return;
            const matches = record => record.sequence > currentStep.after && record.url?.startsWith(server.baseUrl + '/')
                && currentStep.failOnRequests.some(path => path.endsWith('/')
                    ? record.url.startsWith(server.baseUrl + path) : record.url === server.baseUrl + path);
            const failure = networkFailures.find(matches) || httpFailures.find(record => record.finishedAt && matches(record));
            if (failure) {
                await failure.bodyPromise;
                throw new Error(`${failure.method} ${failure.url}: ${failure.error || `HTTP ${failure.status}`} ${JSON.stringify(failure.detail || '')}`);
            }
            if (currentStep.failure) {
                const message = await evaluate(currentStep.failure);
                if (message) throw new Error(`Operation failed: ${sanitizeDetails(String(message))}`);
            }
        };
        const waitFor = async (expression, timeout = 7500, { interval = 50 } = {}) => {
            for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
                await checkStep();
                if (await (typeof expression === 'function' ? expression() : evaluate(expression))) { await checkStep(); return; }
                await delay(interval);
            }
            throw new Error(`Timed out: ${currentStep?.label || expression}\n${errors.slice(-8).join('\n')}\n${await evaluate('window.__cainflowBootstrapError')}\n${await evaluate('document.body.innerText.slice(-5000)')}`);
        };
        const step = async (label, task, { failOnRequests = [], failure = null } = {}) => {
            const previous = currentStep;
            const scope = { label, after: requestSequence, failOnRequests, failure };
            currentStep = scope;
            try {
                const result = await task({ completedRequest: (path, method) => completedRequests.some(record =>
                    record.sequence > scope.after && record.url === server.baseUrl + path && record.method === method
                    && record.status >= 200 && record.status < 300) });
                await checkStep();
                return result;
            } catch (error) {
                error.message = `[${label}] ${error.message}\nRequest diagnostics: ${JSON.stringify(getDiagnostics())}`;
                throw error;
            } finally { currentStep = previous; }
        };
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Network.enable');
        if (preserveRetiredSaveNodes) await send('Page.addScriptToEvaluateOnNewDocument', { source: `
            document.addEventListener('DOMContentLoaded', () => {
                const dismissRetirement = () => {
                    const dialog = document.querySelector('#app-action-dialog:not(.hidden)');
                    if (dialog?.querySelector('h3')?.textContent === '保存节点已弃用') {
                        dialog.querySelector('[data-dialog-style-1-action="cancel"]')?.click();
                    }
                };
                new MutationObserver(dismissRetirement).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
                dismissRetirement();
            });
        ` });
        if (initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
        await send('Page.navigate', { url: server.baseUrl });
        try {
            await waitFor(appInteractive);
        } catch (error) {
            if (!String(error).includes('Failed to fetch dynamically imported module')) throw error;
            await send('Page.reload', { ignoreCache: true });
            await waitFor(appInteractive);
        }
        await delay(500);
        return await task({ evaluate, send, waitFor, step, server, onProtocolEvent: listener => { protocolListeners.add(listener); return () => protocolListeners.delete(listener); } });
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.message += `\nBrowser/server diagnostics: ${JSON.stringify(getDiagnostics())}`;
        throw failure;
    } finally {
        socket?.close(); browser.kill();
        await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve));
        assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
        try { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } finally { await server.stop(); }
    }
}
