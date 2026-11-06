import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { beginAgentResultDrag, takeAgentResultDrag, endAgentResultDrag } from '../js/features/prompt-agent/prompt-agent-result-drag.js';

test('restored Agent results drag original images to Agent and canvas exactly once while preserving preview', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-result-drag.html');
    assert.equal(result.error, undefined);
    for (const name of ['agentImport', 'singleConsumption', 'dragDoesNotPreview', 'clickPreview', 'keyboardPreview', 'canvasImport', 'dragEnabled', 'workflowFence']) assert.equal(result[name], true, name);
});

test('drag completion clears originals and external URL payloads are not imported', async () => {
    const values = new Map();
    const transfer = { setData: (key, value) => values.set(key, value), getData: (key) => values.get(key) };
    const token = beginAgentResultDrag(transfer, { dataUrl: 'data:image/png;base64,YQ==', name: '原图' });
    assert.ok(token);
    endAgentResultDrag(token);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(takeAgentResultDrag(transfer), null);
    assert.equal(beginAgentResultDrag(transfer, { dataUrl: 'https://example.test/image.png' }), null);
});

test('Agent drag bitmaps preserve decoded image proportions with bounded one-time drawing and token-only payloads', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        const cases = await app.evaluate(`(async () => {
            const { beginAgentResultDrag, takeAgentResultDrag, endAgentResultDrag, AGENT_RESULT_DRAG_TYPE } = await import('/js/features/prompt-agent/prompt-agent-result-drag.js');
            const cases = [];
            for (const [width, height, cancel] of [[320, 640, false], [640, 320, false], [4000, 3000, false], [48, 32, true]]) {
                const source = document.createElement('canvas'); source.width = width; source.height = height;
                const pixels = source.getContext('2d');
                pixels.fillStyle = '#ff0000'; pixels.fillRect(0, 0, width / 2, height);
                pixels.fillStyle = '#0000ff'; pixels.fillRect(width / 2, 0, width / 2, height);
                const original = source.toDataURL('image/png');
                const image = document.createElement('img'); image.src = original;
                // A portrait and landscape use the same letterboxed panel box.
                image.style.cssText = 'width:280px;height:240px;object-fit:contain';
                document.body.appendChild(image); await image.decode();
                const transfer = new DataTransfer();
                transfer.setData('text/html', '<img src="' + original + '">');
                transfer.setData('text/uri-list', original); transfer.setData('text/plain', original);
                const nativeDragImage = transfer.setDragImage.bind(transfer);
                const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
                let bitmap, drawing = 0, reusedDecodedImage = true;
                transfer.setDragImage = (element, x, y) => {
                    bitmap = element;
                    nativeDragImage(element, x, y);
                };
                CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
                    drawing++; reusedDecodedImage &&= source === image;
                    return nativeDrawImage.call(this, source, ...args);
                };
                try {
                    const token = beginAgentResultDrag(transfer, { dataUrl: original, name: 'ratio test', image });
                    const drawn = bitmap.getContext('2d');
                    const left = [...drawn.getImageData(1, 1, 1, 1).data];
                    const right = [...drawn.getImageData(bitmap.width - 2, bitmap.height - 2, 1, 1).data];
                    for (let i = 0; i < 120; i++) window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
                    if (cancel) endAgentResultDrag(token);
                    await new Promise(resolve => setTimeout(resolve, 0));
                    const taken = takeAgentResultDrag(transfer);
                    cases.push({ width, height, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height,
                        types: [...transfer.types], tokenOnly: transfer.getData(AGENT_RESULT_DRAG_TYPE) === token,
                        drawing, reusedDecodedImage, left, right, cleaned: !bitmap.isConnected,
                        originalPreserved: cancel ? taken === null : taken?.dataUrl === original,
                        consumedOnce: takeAgentResultDrag(transfer) === null });
                } finally {
                    CanvasRenderingContext2D.prototype.drawImage = nativeDrawImage;
                    image.remove(); bitmap?.remove(); source.width = source.height = 0;
                }
            }
            return cases;
        })()`);
        for (const result of cases) {
            const context = `${result.width}×${result.height}`;
            assert.ok(Math.max(result.bitmapWidth, result.bitmapHeight) <= 192, context);
            assert.equal(result.bitmapWidth / result.bitmapHeight, result.width / result.height, `${context}: the bitmap uses original proportions rather than the panel box`);
            assert.equal(result.drawing, 1, `${context}: moving the drag does not rasterize again`);
            assert.equal(result.reusedDecodedImage, true, context);
            assert.deepEqual(result.left, [255, 0, 0, 255], `${context}: no letterbox or clipping on the left`);
            assert.deepEqual(result.right, [0, 0, 255, 255], `${context}: no letterbox or clipping on the right`);
            assert.deepEqual(result.types, ['application/x-cainflow-agent-result'], `${context}: browser defaults must not carry original base64 payloads`);
            for (const key of ['tokenOnly', 'cleaned', 'originalPreserved', 'consumedOnce']) assert.equal(result[key], true, `${context}: ${key}`);
        }
        assert.deepEqual([cases[3].bitmapWidth, cases[3].bitmapHeight], [48, 32], 'small images are not enlarged');
    });
});
