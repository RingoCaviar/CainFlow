import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { startCanvasMcpEditor } from '../js/features/canvas-mcp/canvas-mcp-editor.js';

function browserWindow(url = 'http://127.0.0.1:8767/') {
    const windowRef = Object.assign(new EventTarget(), { location: new URL(url), crypto: webcrypto, setTimeout, clearTimeout });
    windowRef.top = windowRef;
    return windowRef;
}

test('the visible canvas editor dispatches a command and sends its result on the same lease', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const command = { id: 'read-1', method: 'read_canvas', args: { includeNodes: true } };
    const requests = [];
    const completed = Promise.withResolvers();
    const dispatched = [];
    const stop = startCanvasMcpEditor({
        windowRef, documentRef,
        dispatch: (method, args) => {
            dispatched.push({ method, args });
            return { workflowId: 'workflow-1' };
        },
        fetchImpl: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            if (body.action === 'poll') return Response.json({ command });
            completed.resolve();
            return Response.json({ ok: true });
        }
    });
    try {
        await completed.promise;
        assert.deepEqual(dispatched, [{ method: 'read_canvas', args: { includeNodes: true } }]);
        const [poll, complete] = requests;
        assert.equal(poll.url, '/api/canvas-mcp/editor');
        assert.equal(poll.options.method, 'POST');
        assert.equal(poll.options.credentials, 'same-origin');
        assert.equal(poll.options.redirect, 'error');
        assert.equal(new Headers(poll.options.headers).get('X-CainFlow-Canvas-MCP'), 'editor');
        assert.equal(new Headers(poll.options.headers).get('Content-Type'), 'application/json');
        assert.equal(poll.body.activate, true);
        assert.match(poll.body.editorId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.deepEqual(complete.body, {
            action: 'complete', editorId: poll.body.editorId, id: 'read-1', result: { workflowId: 'workflow-1' }
        });
    } finally {
        stop();
    }
});

test('a poll from before the tab was hidden cannot apply a queued command when the tab returns', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const firstPoll = Promise.withResolvers();
    const queuedResponse = Promise.withResolvers();
    const nextPoll = Promise.withResolvers();
    const dispatched = [];
    let polled = false;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: method => dispatched.push(method),
        fetchImpl: async (url, { body, signal }) => {
            if (!polled) {
                polled = true;
                firstPoll.resolve(signal);
                return queuedResponse.promise;
            }
            nextPoll.resolve(JSON.parse(body));
            return new Response(null, { status: 404 });
        }
    });
    try {
        const signal = await firstPoll.promise;
        documentRef.visibilityState = 'hidden';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        assert.equal(signal.aborted, true);
        documentRef.visibilityState = 'visible';
        documentRef.dispatchEvent(new Event('visibilitychange'));
        queuedResponse.resolve(Response.json({ command: { id: 'stale', method: 'edit_canvas', args: {} } }));
        assert.equal((await nextPoll.promise).activate, false, 'visibility alone does not retake ownership');
        assert.deepEqual(dispatched, []);
    } finally {
        stop();
    }
});

test('a transient completion failure resends the error without running the command twice', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const completed = Promise.withResolvers();
    const completions = [];
    let dispatches = 0;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef,
        dispatch: () => {
            dispatches++;
            throw new Error('工作流已切换');
        },
        fetchImpl: async (url, { body }) => {
            const request = JSON.parse(body);
            if (request.action === 'poll') return Response.json({ command: { id: 'edit-1', method: 'edit_canvas', args: {} } });
            completions.push(request);
            if (completions.length === 1) return new Response(null, { status: 503 });
            completed.resolve();
            return Response.json({ ok: true });
        }
    });
    try {
        await completed.promise;
        assert.equal(dispatches, 1);
        assert.equal(completions[1].id, 'edit-1');
        assert.equal(completions[1].error, '工作流已切换');
        assert.deepEqual(completions[1], completions[0]);
    } finally {
        stop();
    }
});

test('a disabled canvas bridge makes one new probe on focus without continuous polling', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const contacted = Promise.withResolvers();
    let requests = 0;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: () => {},
        fetchImpl: async () => {
            requests++;
            contacted.resolve();
            return new Response(null, { status: 204 });
        }
    });
    try {
        await contacted.promise;
        await new Promise(setImmediate);
        windowRef.dispatchEvent(new Event('focus'));
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(requests, 2);
    } finally {
        stop();
    }
});

test('the settings switch resumes a paused editor and cancels polling immediately when disabled', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const initial = Promise.withResolvers();
    const activated = Promise.withResolvers();
    const returnedCommand = Promise.withResolvers();
    const dispatched = [];
    let requests = 0;
    const setEnabled = enabled => windowRef.dispatchEvent(new CustomEvent('cainflow:canvas-mcp-changed', { detail: { enabled } }));
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: method => dispatched.push(method),
        fetchImpl: async (_url, { body, signal }) => {
            requests++;
            if (requests === 1) {
                initial.resolve();
                return new Response(null, { status: 204 });
            }
            activated.resolve({ poll: JSON.parse(body), signal });
            return returnedCommand.promise;
        }
    });
    try {
        await initial.promise;
        await new Promise(setImmediate);
        setEnabled(true);
        const { poll, signal } = await activated.promise;
        assert.equal(poll.activate, true);
        setEnabled(false);
        assert.equal(signal.aborted, true);
        returnedCommand.resolve(Response.json({ command: { id: 'old', method: 'edit_canvas', args: {} } }));
        await new Promise(setImmediate);
        assert.deepEqual(dispatched, []);
        assert.equal(requests, 2);
    } finally {
        stop();
    }
});

test('a network-hosted canvas never attempts to become the local MCP editor', async () => {
    const windowRef = browserWindow('https://cainflow.example.test:8767/');
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    let requests = 0;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: () => {},
        fetchImpl: async () => {
            requests++;
            return new Response(null, { status: 403 });
        }
    });
    try {
        windowRef.dispatchEvent(new Event('focus'));
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(requests, 0);
    } finally {
        stop();
    }
});

test('a framed canvas cannot take the editor lease from a top-level tab', async () => {
    const windowRef = browserWindow();
    windowRef.top = browserWindow('https://container.example.test/');
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    let requests = 0;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: () => {},
        fetchImpl: async () => {
            requests++;
            return new Response(null, { status: 204 });
        }
    });
    try {
        windowRef.dispatchEvent(new Event('focus'));
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(requests, 0);
    } finally {
        stop();
    }
});

test('an oversized UTF-8 result is reported as a bounded command error', { timeout: 2000 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const completed = Promise.withResolvers();
    const stop = startCanvasMcpEditor({
        windowRef, documentRef, dispatch: () => ({ text: '图'.repeat(2_100_000) }),
        fetchImpl: async (url, { body }) => {
            const request = JSON.parse(body);
            if (request.action === 'poll') {
                return Response.json({ command: { id: 'run-1', method: 'get_workflow_run', args: {} } });
            }
            completed.resolve({ id: request.id, error: request.error, bytes: Buffer.byteLength(body) });
            return Response.json({ ok: true });
        }
    });
    try {
        const result = await completed.promise;
        assert.equal(result.id, 'run-1');
        assert.match(result.error || '', /超过.*传输上限/);
        assert.ok(result.bytes < 1000);
    } finally {
        stop();
    }
});

test('a permanently rejected completion attempts one error response and resumes polling', { timeout: 3500 }, async () => {
    const windowRef = browserWindow();
    const documentRef = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const resumed = Promise.withResolvers();
    const completions = [];
    let delivered = false;
    let dispatches = 0;
    const stop = startCanvasMcpEditor({
        windowRef, documentRef,
        dispatch: () => {
            dispatches++;
            return { text: 'generated text' };
        },
        fetchImpl: async (url, { body }) => {
            const request = JSON.parse(body);
            if (request.action === 'poll') {
                if (delivered) {
                    resumed.resolve(true);
                    return new Response(null, { status: 204 });
                }
                delivered = true;
                return Response.json({ command: { id: 'run-2', method: 'get_workflow_run', args: {} } });
            }
            completions.push(request);
            if (completions.length === 1) return new Response(null, { status: 413 });
            if (completions.length === 2) return new Response(null, { status: 400 });
            resumed.resolve(false);
            return new Response(null, { status: 204 });
        }
    });
    try {
        assert.equal(await resumed.promise, true);
        assert.equal(dispatches, 1);
        assert.equal(completions.length, 2);
        assert.equal(completions[1].id, 'run-2');
        assert.match(completions[1].error || '', /超过.*传输上限/);
        assert.equal(Object.hasOwn(completions[1], 'result'), false);
    } finally {
        stop();
    }
});
