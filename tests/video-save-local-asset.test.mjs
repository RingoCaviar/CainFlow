import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadGeneratedVideo } from '../js/features/media/video/video-download.js';

test('saving a persistent video reads its local Media asset instead of proxying the local URL', async () => {
    const calls = [];
    const mp4 = new Uint8Array(1024);
    mp4.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

    const blob = await downloadGeneratedVideo('/api/storage/assets/media%3Avideo-a', {}, {
        fetchRef: async (url, options = {}) => {
            calls.push({ url, options });
            if (url === '/api/storage/assets/media%3Avideo-a') {
                return new Response(mp4, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
            }
            return new Response('local URLs cannot be proxied', { status: 400 });
        },
        formatProxyErrorMessage: (_status, body) => body,
        addLog: () => {},
        windowRef: { location: { href: 'http://localhost/' } }
    });

    assert.equal(blob.size, 1024);
    assert.deepEqual(calls.map(({ url }) => url), ['/api/storage/assets/media%3Avideo-a']);
});
