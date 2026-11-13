import assert from 'node:assert/strict';
import test from 'node:test';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('history image preview unfolds actions and zooms or fits using the lower-right controls', async () => {
    const result = await runUiFixture('tests/fixtures/history-preview-controls.html');
    assert.deepEqual(result, { folded: true, revealed: true, download: true, zoomIn: true, zoomOut: true, fit: true, closed: true });
});

test('history image preview remembers the information disclosure through navigation and reload', { timeout: 30000 }, async () => {
    const session = {
        autoCheckUpdatesOnLoad: false,
        nodes: [],
        connections: [],
        models: [{ id: 'chat', modelId: 'chat', name: 'test', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: 'test', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
    };
    await withAppBrowser(session, async app => {
        const [videoId, olderId, newerId] = await app.evaluate(`(async () => {
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            const storage = createDiskStorageApi(() => ({}));
            const canvas = document.createElement('canvas');
            canvas.width = 80;
            canvas.height = 60;
            const context = canvas.getContext('2d');
            const stream = canvas.captureStream(10);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const chunks = [];
            const video = new Promise(resolve => {
                recorder.ondataavailable = event => chunks.push(event.data);
                recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
            });
            recorder.start();
            context.fillRect(0, 0, 80, 60);
            await new Promise(resolve => setTimeout(resolve, 120));
            recorder.stop();
            const videoBlob = await video;
            stream.getTracks().forEach(track => track.stop());

            const savedVideo = await storage.saveHistoryEntry({ videoBlob, prompt: '历史视频' });
            const older = await storage.saveHistoryEntry({ image: canvas.toDataURL(), prompt: '第二张图片' });
            context.fillStyle = 'blue';
            context.fillRect(0, 0, 80, 60);
            const newer = await storage.saveHistoryEntry({ image: canvas.toDataURL(), prompt: '第一张图片', model: 'test-model' });
            return [savedVideo.fileId, older.fileId, newer.fileId];
        })()`);

        const toggle = "document.getElementById('btn-toggle-history-preview-info')";
        const info = "document.getElementById('history-preview-info-content')";
        const previewOpen = "!document.getElementById('history-preview-modal').classList.contains('hidden')";
        const nextPreviewReady = "!document.getElementById('btn-next-preview').classList.contains('disabled')";
        const panelArea = () => app.evaluate(`(() => {
            const { width, height } = document.querySelector('#history-preview-modal .preview-info').getBoundingClientRect();
            return width * height;
        })()`);
        const press = async (key, keyCode) => {
            await app.send('Input.dispatchKeyEvent', {
                type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode,
                ...(key === 'Enter' ? { text: '\r' } : {})
            });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
        };
        const openHistory = async () => {
            await app.evaluate("document.getElementById('btn-history').click()");
            await app.waitFor("document.querySelectorAll('#history-list .history-card').length === 3");
        };
        const openItem = async (id, prompt) => {
            await app.evaluate(`document.querySelector('#history-list .history-card[data-id="${id}"]').click()`);
            await app.waitFor(`${previewOpen} && document.getElementById('preview-prompt').textContent === '${prompt}'`);
        };
        const reloadHistory = async () => {
            await app.evaluate(`(async () => {
                const { diskStorage } = await import('/js/services/storage-documents.js');
                await diskStorage.flushPromise;
                if (diskStorage.lastError) throw diskStorage.lastError;
            })()`);
            await reloadAppBrowser(app);
            await openHistory();
        };

        await openHistory();
        await openItem(newerId, '第一张图片');
        await app.waitFor(nextPreviewReady);
        assert.equal(await app.evaluate(`${toggle}?.getAttribute('aria-expanded')`), 'true');
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-controls')`), 'history-preview-info-content');
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-label')`), '收起图片信息');
        assert.equal(await app.evaluate(`${info}.getClientRects().length > 0`), true);
        assert.equal(await app.evaluate(`${info}.querySelector('#history-image-result-actions button').getClientRects().length > 0`), true);
        const expandedArea = await panelArea();

        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 1, mobile: false });
        await app.waitFor('innerWidth === 360 && innerHeight === 420');
        await app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        assert.deepEqual(await app.evaluate(`(() => {
            const controls = ['btn-copy-prompt', 'btn-next-preview', 'btn-preview-fit', 'btn-toggle-history-preview-info'];
            return controls.filter(id => {
                const button = document.getElementById(id);
                const { x, y, width, height } = button.getBoundingClientRect();
                return !button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
            });
        })()`), [], 'copy, navigation, zoom, and disclosure remain clickable in a narrow and short window');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });

        const position = await app.evaluate(`(() => {
            const { x, y, width, height } = ${toggle}.getBoundingClientRect();
            return { x: x + width / 2, y: y + height / 2 };
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position, button: 'left', clickCount: 1 });
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-expanded')`), 'false');
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-label')`), '展开图片信息');
        assert.equal(await app.evaluate(`${info}.getClientRects().length`), 0);
        assert.ok(await panelArea() < expandedArea / 2, 'the collapsed panel covers substantially less of the image');
        assert.equal(await app.evaluate(previewOpen), true);

        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 1, mobile: false });
        assert.equal(await app.evaluate(`(() => {
            const button = ${toggle}.getBoundingClientRect();
            const zoom = document.querySelector('#history-preview-modal .preview-zoom-controls').getBoundingClientRect();
            return button.width > 0 && button.height > 0 && button.left >= 0 && button.right <= innerWidth &&
                (button.right <= zoom.left || zoom.right <= button.left || button.bottom <= zoom.top || zoom.bottom <= button.top);
        })()`), true, 'the collapsed toggle remains visible and clear of zoom controls in a narrow window');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });

        await app.waitFor(nextPreviewReady);
        await press('ArrowRight', 39);
        await app.waitFor("document.getElementById('preview-prompt').textContent === '第二张图片'");
        assert.equal(await app.evaluate(`${info}.getClientRects().length`), 0);
        await app.evaluate(`${toggle}.focus()`);
        await press('ArrowRight', 39);
        await app.waitFor("document.getElementById('preview-prompt').textContent === '历史视频'");
        assert.equal(await app.evaluate(`${toggle}.getClientRects().length`), 0);
        assert.equal(await app.evaluate(`${info}.getClientRects().length > 0`), true);
        assert.equal(await app.evaluate("document.activeElement.id"), 'btn-preview-fit');
        await press('Escape', 27);
        await app.waitFor(`!(${previewOpen})`);
        await openItem(olderId, '第二张图片');
        assert.equal(await app.evaluate(`${info}.getClientRects().length`), 0);

        await reloadHistory();
        await openItem(newerId, '第一张图片');
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-expanded')`), 'false');
        assert.equal(await app.evaluate(`${info}.getClientRects().length`), 0);
        await app.evaluate(`${toggle}.focus()`);
        await press('Enter', 13);
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-expanded')`), 'true');
        assert.equal(await app.evaluate(`${info}.getClientRects().length > 0`), true);
        assert.equal(await app.evaluate(`${toggle} === document.activeElement`), true);

        await reloadHistory();
        await openItem(olderId, '第二张图片');
        assert.equal(await app.evaluate(`${toggle}.getAttribute('aria-expanded')`), 'true');
    });
});
