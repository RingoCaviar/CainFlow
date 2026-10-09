import assert from 'node:assert/strict';
import test from 'node:test';

test('desktop bridge waits until pywebview has injected its required methods', async () => {
    const previous = {
        pywebview: globalThis.pywebview,
        location: globalThis.location,
        document: globalThis.document,
        addEventListener: globalThis.addEventListener,
        setTimeout: globalThis.setTimeout,
        desktop: globalThis.__cainflowDesktop
    };
    let readyListener;
    let timeoutListener;
    try {
        globalThis.pywebview = { api: {} };
        globalThis.location = { search: '?desktop=1', href: 'http://127.0.0.1:8767/' };
        globalThis.document = { addEventListener() {}, hasFocus: () => true, hidden: false };
        globalThis.addEventListener = (type, listener) => {
            if (type === 'pywebviewready') readyListener = listener;
        };
        globalThis.setTimeout = (listener) => {
            timeoutListener = listener;
            return 1;
        };

        const { initializeDesktopBridge } = await import(`../js/services/desktop-bridge.js?readiness=${Date.now()}`);
        const initialization = initializeDesktopBridge();
        await Promise.resolve();

        assert.equal(typeof readyListener, 'function');
        assert.equal(typeof timeoutListener, 'function');
        readyListener();
        globalThis.pywebview.api.get_runtime_info = async () => ({ desktop: true, platform: 'win32' });
        readyListener();

        assert.deepEqual(await initialization, { desktop: true, platform: 'win32' });
        assert.equal(globalThis.__cainflowDesktop.info.desktop, true);
    } finally {
        Object.assign(globalThis, {
            pywebview: previous.pywebview,
            location: previous.location,
            document: previous.document,
            addEventListener: previous.addEventListener,
            setTimeout: previous.setTimeout,
            __cainflowDesktop: previous.desktop
        });
    }
});

test('desktop bridge gives up after the readiness timeout when the API never appears', async () => {
    const previous = {
        pywebview: globalThis.pywebview,
        location: globalThis.location,
        document: globalThis.document,
        addEventListener: globalThis.addEventListener,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        desktop: globalThis.__cainflowDesktop
    };
    try {
        let timeoutListener;
        globalThis.pywebview = { api: {} };
        globalThis.location = { search: '?desktop=1', href: 'http://127.0.0.1:8767/' };
        globalThis.document = { addEventListener() {}, hasFocus: () => true, hidden: false };
        globalThis.addEventListener = () => {};
        globalThis.setTimeout = (listener) => {
            timeoutListener = listener;
            return 1;
        };
        globalThis.clearTimeout = () => {};

        const { initializeDesktopBridge } = await import(`../js/services/desktop-bridge.js?timeout=${Date.now()}`);
        const initialization = initializeDesktopBridge();
        await Promise.resolve();
        timeoutListener();

        assert.equal(await initialization, null);
        assert.equal(globalThis.__cainflowDesktop, previous.desktop);
    } finally {
        Object.assign(globalThis, previous);
    }
});
