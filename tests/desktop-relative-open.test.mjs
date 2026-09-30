import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeDesktopBridge } from '../js/services/desktop-bridge.js';

test('desktop WebView opens a relative media URL in the external browser', async () => {
    const previous = {
        pywebview: globalThis.pywebview,
        location: globalThis.location,
        document: globalThis.document,
        open: globalThis.open,
        desktop: globalThis.__cainflowDesktop
    };
    const opened = [];
    try {
        globalThis.pywebview = { api: {
            get_runtime_info: async () => ({ desktop: true }),
            open_external: async (url) => { opened.push(url); return true; }
        } };
        globalThis.location = { search: '?desktop=1', href: 'http://127.0.0.1:8767/' };
        globalThis.document = { addEventListener() {}, hasFocus: () => true, hidden: false };
        globalThis.open = () => null;
        await initializeDesktopBridge();

        globalThis.open('/api/storage/assets/media%3Avideo-1', '_blank');
        await Promise.resolve();

        assert.deepEqual(opened, ['http://127.0.0.1:8767/api/storage/assets/media%3Avideo-1']);
    } finally {
        Object.assign(globalThis, {
            pywebview: previous.pywebview,
            location: previous.location,
            document: previous.document,
            open: previous.open,
            __cainflowDesktop: previous.desktop
        });
    }
});
