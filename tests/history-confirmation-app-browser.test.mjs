import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = { autoCheckUpdatesOnLoad: false, nodes: [], connections: [], providers: [{ id: 'p', name: 'test', endpoint: 'https://controlled.test/v1', apikey: 'test' }], models: [{ id: 'chat', name: 'test', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }] };

test('history batch button toggles selection and toolbar fits narrow sidebars', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        await writeFile(join(app.server.dataDir, 'exports', 'select-me.png'), await readFile(new URL('./fixtures/reference-red.png', import.meta.url)));
        await app.send('Emulation.setDeviceMetricsOverride', { width: 954, height: 809, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.getElementById('btn-history').click()");
        await app.waitFor("!!document.querySelector('#history-list .history-card')");
        await app.evaluate("document.getElementById('btn-history-batch').click()");
        await app.waitFor("!!document.querySelector('#history-list .multi-select-mode')");
        await app.evaluate("document.querySelector('#history-list .history-card').click()");
        await app.waitFor("document.getElementById('selected-count').textContent === '1'");
        await app.evaluate("document.getElementById('btn-history-batch').click()");
        await app.waitFor("!document.querySelector('#history-list .multi-select-mode')");
        assert.equal(await app.evaluate("document.getElementById('history-batch-toolbar').classList.contains('hidden')"), true);
        assert.equal(await app.evaluate("document.getElementById('btn-history-batch').getAttribute('aria-pressed')"), 'false');
        await app.evaluate("document.getElementById('btn-history-batch').click()");
        await app.waitFor("document.getElementById('selected-count').textContent === '0'");
        for (const columns of [2, 1]) {
            if (columns === 1) await app.evaluate("document.getElementById('btn-col-decrease').click()");
            assert.equal(await app.evaluate(`(() => {
                const toolbar = document.getElementById('history-batch-toolbar');
                const bounds = toolbar.getBoundingClientRect();
                return toolbar.scrollWidth <= toolbar.clientWidth &&
                    [...toolbar.querySelectorAll('button, .history-batch-summary > span')].every(element => {
                        const rect = element.getBoundingClientRect();
                        return rect.left >= bounds.left && rect.right <= bounds.right && rect.height <= 40;
                    });
            })()`), true, `${columns} columns: toolbar fits without crushed labels`);
        }
        await app.evaluate("document.getElementById('btn-batch-cancel').click()");
        await app.waitFor("!document.querySelector('#history-list .multi-select-mode')");
        assert.equal(await app.evaluate("document.getElementById('btn-history-batch').getAttribute('aria-pressed')"), 'false');
    });
});

test('history deletion preserves the file on cancel and deletes it once after confirmation', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const directory = join(app.server.dataDir, 'exports');
        await writeFile(join(directory, 'delete-me.png'), await readFile(new URL('./fixtures/reference-red.png', import.meta.url)));
        await app.evaluate(`window.deletions = 0; const originalFetch = fetch;
            window.fetch = (url, options = {}) => {
                if (String(url).startsWith('/api/storage/library/') && options.method === 'DELETE') deletions++;
                return originalFetch(url, options);
            };
            window.confirm = () => { throw new Error('Native confirmation is forbidden'); };
            document.getElementById('btn-history').click()`);
        await app.waitFor("!!document.querySelector('#history-list .delete-btn')");
        await app.evaluate("document.querySelector('#history-list .delete-btn').click()");
        await app.waitFor("!!document.querySelector('#app-action-dialog:not(.hidden)')");
        assert.equal(await app.evaluate('deletions'), 0);
        await app.evaluate("document.querySelector('#app-action-dialog [data-dialog-style-1-action=cancel]').click()");
        assert.deepEqual(await readdir(directory), ['delete-me.png']);
        await app.evaluate("document.querySelector('#history-list .delete-btn').click()");
        await app.waitFor("!!document.querySelector('#app-action-dialog:not(.hidden)')");
        await app.evaluate("const button = document.querySelector('#app-action-dialog [data-dialog-style-1-action=confirm]'); button.click(); button.click()");
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length === 0");
        assert.equal(await app.evaluate('deletions'), 1);
        assert.deepEqual(await readdir(directory), []);
    });
});

test('sidebar and fullscreen history each choose one download folder and report completed saves', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const directory = join(app.server.dataDir, 'exports');
        const imageHashes = [];
        for (const color of ['red', 'green', 'blue']) {
            const image = await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url));
            await writeFile(join(directory, `${color}.png`), image);
            imageHashes.push(createHash('sha256').update(image).digest('hex'));
        }
        await app.evaluate(`
            window.historySave = { cancel: true, directoryPicks: 0, singleSaves: 0, writes: [], closed: [] };
            window.__cainflowDesktop = {
                saveFile: async () => { historySave.singleSaves++; return 'unexpected-single-save.png'; },
                beginDirectorySave: async () => {
                    historySave.directoryPicks++;
                    return historySave.cancel ? null : 'folder-' + historySave.directoryPicks;
                },
                saveFileToDirectory: async (folder, name, source) => {
                    const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
                    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
                    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                    historySave.writes.push({ folder, name, hash });
                    const failed = await new Promise(resolve => { historySave.finishWrite = resolve; });
                    if (failed) throw new Error('controlled write failure');
                    return folder + '/' + name;
                },
                endDirectorySave: async folder => { historySave.closed.push(folder); }
            };
            document.getElementById('btn-history').click();
        `);

        const dialog = '.history-download-progress[open]';
        const progress = `document.querySelector('${dialog} progress')`;
        const done = `document.querySelector('${dialog} button')`;
        const click = id => `document.getElementById('${id}').click()`;
        const fullscreenOpen = "!document.getElementById('history-fullscreen-modal').classList.contains('hidden')";
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length === 3");
        await app.evaluate(`${click('btn-history-batch')}; ${click('btn-batch-select-all')}`);
        await app.waitFor("document.getElementById('selected-count').textContent === '3'");
        await app.evaluate(click('btn-batch-download'));
        await app.waitFor('historySave.directoryPicks === 1 || historySave.singleSaves === 3');
        assert.deepEqual(await app.evaluate('[historySave.directoryPicks, historySave.singleSaves]'), [1, 0],
            'batch download opens a folder picker once instead of one save dialog per image');
        assert.equal(await app.evaluate('historySave.writes.length'), 0);
        assert.equal(await app.evaluate(`!!document.querySelector('${dialog}')`), false);
        assert.equal(await app.evaluate("document.getElementById('selected-count').textContent"), '3');
        await app.evaluate('historySave.cancel = false');

        for (const batch of [
            { button: 'btn-batch-download', folder: 'folder-2', offset: 0, failSecondWrite: false },
            { button: 'btn-history-fullscreen-download', folder: 'folder-3', offset: 3, failSecondWrite: true },
        ]) {
            if (batch.offset) {
                await app.evaluate(click('btn-expand-history'));
                await app.waitFor("document.querySelectorAll('#history-fullscreen-list .history-card').length === 3");
                await app.evaluate(`${click('btn-history-fullscreen-batch')}; ${click('btn-history-fullscreen-select-all')}`);
                await app.waitFor("document.getElementById('history-fullscreen-selected-count').textContent === '3'");
            }
            await app.evaluate(`${click(batch.button)}; ${click(batch.button)}`);
            for (let completed = 0; completed < 3; completed++) {
                await app.waitFor(`historySave.writes.length === ${batch.offset + completed + 1}`);
                assert.deepEqual(await app.evaluate(`[${progress}.value, ${progress}.max, ${done}.disabled]`), [completed, 3, true]);
                if (batch.offset && completed === 0) {
                    await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
                    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
                    assert.equal(await app.evaluate(fullscreenOpen), true, 'Escape must leave the fullscreen history open while saving');
                    assert.equal(await app.evaluate(`!!${progress}`), true, 'Escape must leave the active progress visible');
                }
                await app.evaluate(`historySave.finishWrite(${batch.failSecondWrite && completed === 1})`);
            }
            await app.waitFor(`${done}?.disabled === false`);
            assert.equal(await app.evaluate(`${progress}.value`), 3);
            assert.equal(await app.evaluate('historySave.closed.at(-1)'), batch.folder);
            const writes = await app.evaluate(`historySave.writes.slice(${batch.offset})`);
            assert.equal(new Set(writes.map(write => write.name)).size, 3);
            assert.ok(writes.every(write => write.folder === batch.folder && write.name.endsWith('.png')));
            assert.deepEqual(writes.map(write => write.hash).sort(), imageHashes.toSorted());
            if (batch.failSecondWrite) {
                assert.match(await app.evaluate(`document.querySelector('${dialog}').innerText`), /已保存\s*2.*(?:失败\s*1|1\s*项失败)/s);
            }
            const position = await app.evaluate(`(() => {
                const { x, y, width, height } = ${done}.getBoundingClientRect();
                return { x: x + width / 2, y: y + height / 2 };
            })()`);
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
            assert.equal(await app.evaluate(`!!document.querySelector('${dialog}')`), false, `${batch.folder}: a pointer click dismisses the completed progress`);
            if (batch.offset) assert.equal(await app.evaluate(fullscreenOpen), true);
        }
        assert.deepEqual(await app.evaluate('[historySave.directoryPicks, historySave.singleSaves, historySave.closed]'),
            [3, 0, ['folder-2', 'folder-3']]);
    });
});

test('browser history download writes originals to a chosen directory or downloads one ZIP', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const directory = join(app.server.dataDir, 'exports');
        const png = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
        const jpegDataUrl = await app.evaluate(`(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 2;
            return canvas.toDataURL('image/jpeg');
        })()`);
        const jpeg = Buffer.from(jpegDataUrl.split(',')[1], 'base64');
        await writeFile(join(directory, 'red.png'), png);
        await writeFile(join(directory, 'black.jpg'), jpeg);
        const originals = { '.jpg': jpeg.toString('base64'), '.png': png.toString('base64') };

        await app.evaluate(`
            window.browserSaves = { picks: [], writes: [], downloads: [] };
            window.showDirectoryPicker = async options => {
                browserSaves.picks.push({ options, userActivation: navigator.userActivation.isActive });
                return {
                    async getFileHandle(name, { create = false } = {}) {
                        if (!create) throw new DOMException('Missing file', 'NotFoundError');
                        return {
                            async createWritable() {
                                let blob;
                                return {
                                    async write(value) { blob = value; },
                                    async close() {
                                        const bytes = new Uint8Array(await blob.arrayBuffer());
                                        browserSaves.writes.push([name, btoa(String.fromCharCode(...bytes))]);
                                    },
                                    async abort() {}
                                };
                            }
                        };
                    }
                };
            };
            document.addEventListener('click', event => {
                const link = event.target.closest('a[download]');
                if (!link) return;
                event.preventDefault();
                browserSaves.downloads.push({ name: link.download, blob: fetch(link.href).then(response => response.blob()) });
            }, true);
            document.getElementById('btn-history').click();
        `);
        await app.waitFor("document.querySelectorAll('#history-list .history-card').length === 2");
        const selectAll = async () => {
            await app.evaluate(`(() => {
                const toggle = document.getElementById('btn-history-batch');
                if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
                document.getElementById('btn-batch-select-all').click();
            })()`);
            await app.waitFor("document.getElementById('selected-count').textContent === '2'");
        };
        await selectAll();
        const position = await app.evaluate(`(() => {
            const { x, y, width, height } = document.getElementById('btn-batch-download').getBoundingClientRect();
            return { x: x + width / 2, y: y + height / 2 };
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });

        const done = "document.querySelector('.history-download-progress[open] button')";
        await app.waitFor(`${done}?.disabled === false || browserSaves.downloads.length === 2`);
        assert.deepEqual(await app.evaluate('browserSaves.picks'), [{ options: { mode: 'readwrite' }, userActivation: true }]);
        assert.equal(await app.evaluate('browserSaves.downloads.length'), 0);
        const asOriginals = entries => Object.fromEntries(entries.map(([name, data]) => [name.slice(name.lastIndexOf('.')), data]));
        const directoryFiles = await app.evaluate('browserSaves.writes');
        assert.equal(directoryFiles.length, 2);
        assert.deepEqual(asOriginals(directoryFiles), originals);

        await app.waitFor("document.getElementById('selected-count').textContent === '0'");
        await app.evaluate(`${done}.click(); window.showDirectoryPicker = undefined`);
        await selectAll();
        await app.evaluate("document.getElementById('btn-batch-download').click()");
        await app.waitFor(`${done}?.disabled === false`);
        assert.deepEqual(await app.evaluate('browserSaves.downloads.map(download => download.name)'), ['cainflow_history.zip']);
        const archiveFiles = await app.evaluate(`(async () => {
            const { readConfigArchive } = await import('/js/features/settings/config-archive.js');
            const files = await readConfigArchive(await browserSaves.downloads[0].blob);
            return Array.from(files, ([name, bytes]) => [name, btoa(String.fromCharCode(...bytes))]);
        })()`);
        assert.equal(archiveFiles.length, 2);
        assert.deepEqual(asOriginals(archiveFiles), originals);
    });
});
