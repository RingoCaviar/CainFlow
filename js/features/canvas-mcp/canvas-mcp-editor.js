const EDITOR_ENDPOINT = '/api/canvas-mcp/editor';
const SETTINGS_CHANGED_EVENT = 'cainflow:canvas-mcp-changed';
const POLL_INTERVAL_MS = 250;
const LEASE_RETRY_MS = 1000;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 10000;
const MAX_EDITOR_BYTES = 6_100_000; // Matches the editor HTTP request limit.
const RESULT_TOO_LARGE = '画布结果超过 MCP 传输上限';

export function startCanvasMcpEditor({ dispatch, fetchImpl = globalThis.fetch, windowRef = window, documentRef = document }) {
    // Only a top-level editor at the server's canonical local origin can take the lease.
    if (windowRef.top !== windowRef || windowRef.location.protocol !== 'http:'
        || windowRef.location.hostname !== '127.0.0.1') return () => {};
    const editorId = windowRef.crypto?.randomUUID?.();
    if (!editorId) return () => {};

    let stopped = false;
    let paused = false;
    let generation = 0;
    let frozen = false;
    let seenVisible = false;
    let activate = false;
    let timer = null;
    let busy = false;
    let request = null;
    let completion = null;
    let retryMs = INITIAL_RETRY_MS;

    const isVisible = () => !frozen && documentRef.visibilityState === 'visible';

    function clearTimer() {
        if (timer === null) return;
        windowRef.clearTimeout(timer);
        timer = null;
    }

    function schedule(delay) {
        if (stopped || paused || frozen || busy || (!completion && !isVisible())) return;
        clearTimer();
        timer = windowRef.setTimeout(poll, delay);
    }

    const errorBody = (id, error) => JSON.stringify({ action: 'complete', editorId, id, error });

    async function dispatchCommand({ id, method, args }) {
        let body;
        try {
            const result = await dispatch(method, args);
            body = JSON.stringify({ action: 'complete', editorId, id, result: result ?? null });
            if (body.length > MAX_EDITOR_BYTES || new TextEncoder().encode(body).byteLength > MAX_EDITOR_BYTES) {
                body = errorBody(id, RESULT_TOO_LARGE);
            }
        } catch (error) {
            const message = typeof error?.message === 'string' && error.message ? error.message.slice(0, 2000) : '画布命令执行失败';
            body = errorBody(id, message);
        }
        return { id, body };
    }

    async function poll() {
        timer = null;
        if (stopped || paused || frozen || (!completion && !isVisible())) return;

        const completing = completion !== null;
        const body = completion?.body ?? JSON.stringify({ action: 'poll', editorId, activate });
        if (!completing) activate = false;
        const controller = new AbortController();
        request = { controller, completing };
        busy = true;
        let delay = POLL_INTERVAL_MS;
        try {
            const response = await fetchImpl(EDITOR_ENDPOINT, {
                method: 'POST', credentials: 'same-origin', redirect: 'error',
                headers: { 'Content-Type': 'application/json', 'X-CainFlow-Canvas-MCP': 'editor' },
                signal: controller.signal,
                body
            });
            if (controller.signal.aborted) return;
            if (response.status === 204) {
                pause();
                return;
            }
            if (response.status === 403 || response.status === 404) {
                stop();
                return;
            }
            if (response.status === 409) {
                if (completing) completion = null;
                retryMs = INITIAL_RETRY_MS;
                delay = LEASE_RETRY_MS;
                return;
            }
            if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
                if (!completing) {
                    stop();
                } else if (completion.fallback) {
                    completion = null;
                } else {
                    const { id } = completion;
                    const message = response.status === 413 ? RESULT_TOO_LARGE : `画布结果提交失败（HTTP ${response.status}）`;
                    completion = { id, body: errorBody(id, message), fallback: true };
                    delay = 0;
                }
                return;
            }
            if (!response.ok) throw new Error(`Canvas MCP editor HTTP ${response.status}`);
            if (completing) {
                completion = null;
                retryMs = INITIAL_RETRY_MS;
                return;
            }

            const { command } = await response.json();
            if (controller.signal.aborted || !isVisible()) return;
            if (command && (typeof command.id !== 'string' || typeof command.method !== 'string')) {
                throw new Error('Invalid canvas command');
            }
            retryMs = INITIAL_RETRY_MS;
            if (!command) return;
            request = null;
            const commandGeneration = generation;
            const result = await dispatchCommand(command);
            if (!stopped && commandGeneration === generation) completion = result;
            delay = 0;
        } catch {
            if (!controller.signal.aborted) {
                delay = retryMs;
                retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
            }
        } finally {
            request = null;
            busy = false;
            schedule(!completion && activate && isVisible() ? 0 : delay);
        }
    }

    function wake() {
        if (!isVisible()) return;
        if (!seenVisible) {
            seenVisible = true;
            activate = true;
        }
        schedule(0);
    }

    function onFocus() {
        if (!isVisible()) return;
        paused = false;
        activate = true;
        wake();
    }

    function pause() {
        paused = true;
        generation++;
        activate = false;
        completion = null;
        clearTimer();
        request?.controller.abort();
    }

    function onSettingsChanged(event) {
        if (event.detail?.enabled === false) {
            pause();
        } else if (event.detail?.enabled === true) {
            if (request && !request.completing) request.controller.abort();
            paused = false;
            activate = true;
            wake();
        }
    }

    function onVisibilityChange() {
        if (isVisible()) {
            wake();
            return;
        }
        activate = false;
        if (!completion) clearTimer();
        if (request && !request.completing) request.controller.abort();
    }

    function onPageHide(event) {
        if (!event.persisted) {
            stop();
            return;
        }
        frozen = true;
        seenVisible = false;
        activate = false;
        clearTimer();
        request?.controller.abort();
    }

    function onPageShow() {
        if (!frozen) return;
        frozen = false;
        onFocus();
    }

    function stop() {
        stopped = true;
        completion = null;
        clearTimer();
        request?.controller.abort();
        documentRef.removeEventListener('visibilitychange', onVisibilityChange);
        windowRef.removeEventListener('focus', onFocus);
        windowRef.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
        windowRef.removeEventListener('pagehide', onPageHide);
        windowRef.removeEventListener('pageshow', onPageShow);
    }

    documentRef.addEventListener('visibilitychange', onVisibilityChange);
    windowRef.addEventListener('focus', onFocus);
    windowRef.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged);
    windowRef.addEventListener('pagehide', onPageHide);
    windowRef.addEventListener('pageshow', onPageShow);
    wake();
    return stop;
}
