import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { startHistoryDownload } from '../js/features/history/history-download.js';

test('history image download reports a started request', () => {
    const downloaded = [];
    const started = startHistoryDownload(
        { id: 7, image: 'data:image/png;base64,image' },
        { downloadImage: (...args) => { downloaded.push(args); return true; } }
    );

    assert.equal(started, true);
    assert.deepEqual(downloaded, [['data:image/png;base64,image', 'cainflow_7.png']]);
});

test('history download reports failure for missing media and rejected download requests', () => {
    assert.equal(startHistoryDownload({ id: 8 }, { downloadImage: () => true }), false);
    assert.equal(startHistoryDownload(
        { id: 9, image: 'data:image/png;base64,image' },
        { downloadImage: () => false }
    ), false);
});

test('all history save entry points use the shared request-result helper', async () => {
    const files = await Promise.all([
        readFile(new URL('../js/features/history/history-preview.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/features/history/history-fullscreen.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/features/ui/ui-controller.js', import.meta.url), 'utf8')
    ]);

    for (const source of files) {
        assert.match(source, /startHistoryDownload/);
        assert.match(source, /已开始保存到本地/);
    }
});

test('download feedback stays visible above an open history preview', async () => {
    const css = await readFile(new URL('../css/modules/13-drawers-history-log.css', import.meta.url), 'utf8');

    assert.match(css, /#history-preview-modal:not\(\.hidden\)\s*~\s*#toast-container\s*\{[\s\S]*?z-index:\s*calc\(var\(--layer-modal\)\s*\+\s*1\)/);
});
