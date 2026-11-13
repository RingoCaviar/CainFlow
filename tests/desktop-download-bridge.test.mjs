import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeDesktopBridge } from '../js/services/desktop-bridge.js';

test('desktop directory exports pass one authorization and original bytes to the native bridge', async () => {
    const previous = {
        pywebview: globalThis.pywebview,
        __cainflowDesktop: globalThis.__cainflowDesktop,
        open: globalThis.open
    };
    const calls = [];
    globalThis.pywebview = { api: {
        get_runtime_info: async () => ({ desktop: true }),
        begin_directory_save: async () => {
            calls.push(['folder']);
            return 'chosen-folder';
        },
        save_file_to_directory: async (token, name, payload) => {
            calls.push(['write', token, name, payload]);
            return 'exports/' + name;
        },
        end_directory_save: async token => calls.push(['end', token])
    } };

    try {
        await initializeDesktopBridge();
        const desktop = globalThis.__cainflowDesktop;
        const token = await desktop.beginDirectorySave();
        assert.equal(await desktop.saveFileToDirectory(token, 'image.png', new Blob(['abc'])), 'exports/image.png');
        assert.equal(await desktop.saveFileToDirectory(token, 'video.webm', 'data:video/webm;base64,AAEC'), 'exports/video.webm');
        await desktop.endDirectorySave(token);
        assert.deepEqual(calls, [
            ['folder'],
            ['write', 'chosen-folder', 'image.png', { encoding: 'base64', data: 'YWJj' }],
            ['write', 'chosen-folder', 'video.webm', { encoding: 'base64', data: 'AAEC' }],
            ['end', 'chosen-folder']
        ]);
    } finally {
        Object.assign(globalThis, previous);
    }
});

test('programmatic download links join the document before they are clicked', async () => {
    const sources = await Promise.all([
        '../js/features/persistence/project-io.js',
        '../js/features/workflow/workflow-manager.js',
        '../js/features/settings/protocol-developer-panel.js',
        '../js/features/ui/ui-controller.js'
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

    for (const source of sources) {
        assert.match(source, /body\?\.appendChild\((?:a|link|anchor)\)[\s\S]{0,180}(?:a|link|anchor)\.click\(\)/);
    }
});
