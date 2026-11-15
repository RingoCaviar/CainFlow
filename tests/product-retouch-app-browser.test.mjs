import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { key, nativeClick, openParameters, saved } from './helpers/image-first-integrated-fixture.mjs';

const panel = '#image-parameter-panel';
const runButton = `document.querySelector('${panel} [data-retouch-action=run]')`;
const field = selector => `document.querySelector('${panel} [data-retouch-field=${selector}]')`;
const background = value => `document.querySelector('${panel} [data-retouch-field=background][value=${value}]')`;
const inspect = `${panel} [data-retouch-inspect]`;
const compareStage = '#retouch .product-retouch-compare-stage';
const compareSlider = '#retouch [data-retouch-compare-slider]';
const compareDialog = '.product-retouch-compare-dialog[role="dialog"]';
const dialogImage = `${compareDialog} img[data-retouch-dialog-image]`;
const red = [255, 0, 0];
const blue = [0, 0, 255];

async function selectOption(app, name, value) {
    await app.evaluate(`(() => {
        const control = ${field(name)};
        control.value = ${JSON.stringify(value)};
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
}

const outputIsBlue = selector => `(() => {
    const image = document.querySelector(${JSON.stringify(selector)});
    if (!image?.checkVisibility() || !image.complete || !image.naturalWidth) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return red === 0 && green === 0 && blue === 255;
})()`;

async function sampleRenderedImageColors(app, selector) {
    const points = await app.evaluate(`(() => {
        const image = document.querySelector(${JSON.stringify(selector)});
        const { x, y, width, height } = image.getBoundingClientRect();
        return [0.25, 0.75].map(position => [Math.round(x + width * position), Math.round(y + height * 0.45)]);
    })()`);
    await app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const { data } = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return app.evaluate(`(async () => {
        const snapshot = await (await fetch('data:image/png;base64,${data}')).blob();
        const image = await createImageBitmap(snapshot);
        const canvas = new OffscreenCanvas(2, 1);
        const context = canvas.getContext('2d');
        return ${JSON.stringify(points)}.map(([x, y], index) => {
            context.drawImage(image, x, y, 1, 1, index, 0, 1, 1);
            return [...context.getImageData(index, 0, 1, 1).data].slice(0, 3);
        });
    })()`);
}

function assertRenderedColor(pixels, color) {
    for (const pixel of pixels) {
        assert.ok(pixel.every((channel, index) => Math.abs(channel - color[index]) <= 8),
            `expected ${pixel} to show fixture color ${color}`);
    }
}

async function openComparison(app) {
    await app.waitFor(`document.querySelector('${inspect}')?.textContent.trim() === '查看对照'`);
    await nativeClick(app, inspect);
    await app.waitFor(`document.querySelector('${dialogImage}')?.checkVisibility()
        && getComputedStyle(document.querySelector('${compareDialog}')).opacity === '1'`);
    assert.match(await app.evaluate(`document.querySelector('${compareDialog}').textContent`), /原图与精修对照/);
}

async function closeComparison(app) {
    await key(app, 'Escape');
    await app.waitFor(`!document.querySelector('${compareDialog}') && document.activeElement.matches('${inspect}')`);
}

async function comparisonImageColors(app, view) {
    await nativeClick(app, `${compareDialog} [data-retouch-view=${view}]`);
    await app.waitFor(`document.querySelector('${dialogImage}')?.complete && document.querySelector('${dialogImage}')?.naturalWidth`);
    return sampleRenderedImageColors(app, dialogImage);
}

test('product retouch sends the chosen finish and keeps the actual original paired with its one downstream result', { timeout: 60000 }, async () => {
    const source = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const replacement = (await readFile(new URL('./fixtures/reference-orange.png', import.meta.url))).toString('base64');
    const result = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const workflowId = 'retouch-fixture';
    const nodes = [
        { id: 'retouch', type: 'ProductRetouch', x: 350, y: 110 },
        { id: 'result', type: 'ImagePreview', x: 740, y: 110 },
        { id: 'retouch-clone', type: 'ProductRetouch', x: 350, y: 500, isClone: true, cloneSourceId: 'retouch' }
    ];
    const connections = [
        { id: 'output', from: { nodeId: 'retouch', port: 'image' }, to: { nodeId: 'result', port: 'image' }, type: 'image' }
    ];
    const initScript = `window.retouchRequests = [];
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (url === '/api/storage/media-assets' && options?.method === 'PUT' && window.rejectUpload) {
                return Response.json({ error: 'Fixture upload failure' }, { status: 500 });
            }
            if (url !== '/proxy') return originalFetch(url, options);
            const body = options?.body;
            if (!(body instanceof FormData)) {
                window.retouchRequests.push({ multipart: false });
                return Response.json({ error: { message: 'Expected a multipart image edit request' } }, { status: 400 });
            }
            const images = [...body].filter(([key]) => key === 'image' || key === 'image[]');
            const references = await Promise.all(images.map(async ([, file]) =>
                btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))));
            window.retouchRequests.push({ references, prompt: body.get('prompt'), model: body.get('model'),
                urlHeader: new Headers(options.headers).get('x-target-url-b64') });
            if (window.rejectRetouch) {
                await new Promise(resolve => { window.releaseFailedRetouch = resolve; });
                return Response.json({ data: [{ b64_json: 'YnJva2Vu' }] });
            }
            if (window.wideRetouch) {
                const canvas = document.createElement('canvas');
                canvas.width = 48;
                canvas.height = 24;
                const context = canvas.getContext('2d');
                context.fillStyle = '#0000ff';
                context.fillRect(0, 0, 48, 24);
                return Response.json({ data: [{ b64_json: canvas.toDataURL('image/png').split(',')[1] }] });
            }
            return Response.json({ data: [{ b64_json: ${JSON.stringify(result)} }] });
        };`;

    await withAppBrowser({
        autoCheckUpdatesOnLoad: false, autoRetry: false, nodes, connections,
        activeWorkflowId: workflowId, activeWorkflowName: '商品精修',
        workflowTabs: [{ workflowId, name: '商品精修', data: { workflowId, nodes, connections } }],
        models: [
            { id: 'image', modelId: 'gpt-image-1', name: '受控精修模型', taskType: 'image', protocol: 'openai', providerIds: ['p'] },
            { id: 'generate-only', modelId: 'dall-e-3', name: '仅生图模型', taskType: 'image', protocol: 'openai', providerIds: ['p'] }
        ],
        providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(`document.querySelector('${panel}').dataset.mode`), 'docked');
        assert.equal(await app.evaluate(`${background('white')}.checked`), true);
        assert.equal(await app.evaluate(`${runButton}.disabled`), true);
        assert.equal(await app.evaluate(`${field('modelId')}.querySelector('option[value=generate-only]') === null`), true);

        await app.evaluate(`${background('black')}.click()`);
        await selectOption(app, 'finish', 'polished');
        const uploadReference = () => app.evaluate(`(async () => {
                const image = await (await fetch('data:image/png;base64,${source}')).blob();
                const files = new DataTransfer();
                files.items.add(new File([image], 'product.png', { type: 'image/png' }));
                const upload = document.querySelector('${panel} input[data-retouch-upload]');
                upload.files = files.files;
                upload.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
        const status = `document.querySelector('${panel} .product-retouch-footer [role=status]')`;
        await app.evaluate('window.rejectUpload = true');
        await uploadReference();
        await app.waitFor(`${status}.textContent.includes('参考图保存失败')`);
        assert.equal(await app.evaluate(`document.querySelector('${panel} [data-retouch-action=upload]').checkVisibility()`), true);
        assert.equal(await app.evaluate(`${runButton}.disabled`), true);
        await app.evaluate('window.rejectUpload = false');
        await app.step('从产品精修节点重新上传商品参考图', async () => {
            await uploadReference();
            await app.waitFor(`fetch('/api/storage/documents/session').then(r => r.json()).then(({ value }) => {
                const reference = value.connections.find(edge => edge.to.nodeId === 'retouch' && edge.to.port === 'image');
                const source = value.nodes.find(node => node.id === reference?.from.nodeId && node.type === 'ImageImport');
                return reference?.from.port === 'image' && source?.mediaAssetKeys?.length === 1;
            })`, 7500, { interval: 200 });
        }, { failOnRequests: ['/api/storage/media-assets', '/api/storage/documents/session'] });
        await openParameters(app, 'retouch');
        await app.waitFor(`${status}.textContent.includes('请选择精修模型')`);
        assert.equal(await app.evaluate(`${runButton}.disabled`), true, 'an original alone cannot run without an edit model');
        assert.equal(await app.evaluate('retouchRequests.length'), 0);
        await selectOption(app, 'modelId', 'image');
        await selectOption(app, 'providerId', 'p');
        await app.waitFor(`${runButton}.checkVisibility() && !${runButton}.disabled`);
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor('retouchRequests.length > 0');
        const [request] = await app.evaluate('retouchRequests');
        assert.deepEqual(request.references, [source]);
        assert.equal(request.model, 'gpt-image-1');
        assert.equal(Buffer.from(request.urlHeader, 'base64url').toString(), 'https://fixture.test/v1/images/edits');
        assert.match(request.prompt, /背景[^。]*纯黑|黑(?:色背景|底)/);
        assert.match(request.prompt, /抛光/);

        const cardResult = '#retouch .product-retouch-card img';
        const downstreamResult = '#result-preview img';
        await app.waitFor(outputIsBlue(cardResult));
        await app.waitFor(outputIsBlue(downstreamResult));
        assert.equal(await app.evaluate('retouchRequests.length'), 1);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'split'
            && Array.from(document.querySelectorAll('${compareStage} img')).filter(image => image.complete && image.naturalWidth).length === 2`);
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '50');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, blue]);
        const sliderGeometry = await app.evaluate(`(() => {
            const { x, y, width, height } = document.querySelector('${compareSlider}').getBoundingClientRect();
            return { x: x + width / 2, y: y + height / 2, endX: x + width * 0.72 };
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sliderGeometry.x, y: sliderGeometry.y, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sliderGeometry.endX, y: sliderGeometry.y, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sliderGeometry.endX, y: sliderGeometry.y, button: 'left', clickCount: 1 });
        assert.ok(Number(await app.evaluate(`document.querySelector('${compareSlider}').value`)) < 40, 'the divider follows the pointer to the right');
        await app.evaluate(`document.querySelector('${compareSlider}').focus()`);
        await key(app, 'Home');
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '0');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, red]);
        await key(app, 'End');
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '100');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [blue, blue]);

        const sourceId = (await saved(app)).connections.find(edge => edge.to.nodeId === 'retouch' && edge.to.port === 'image').from.nodeId;
        await uploadImageOriginal(app, sourceId, `data:image/png;base64,${replacement}`);
        await openParameters(app, 'retouch');

        await app.evaluate('window.rejectRetouch = true');
        await app.waitFor(`!${runButton}.disabled`);
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor('typeof window.releaseFailedRetouch === "function"');
        await openComparison(app);
        await app.evaluate('window.releaseFailedRetouch()');
        await app.waitFor(`${status}.textContent.includes('已保留上次结果')`);
        assert.equal(await app.evaluate('retouchRequests.length'), 2);
        assert.deepEqual(await app.evaluate('retouchRequests[1].references'), [replacement]);
        assert.equal(await app.evaluate(outputIsBlue(cardResult)), true);
        assert.equal(await app.evaluate(outputIsBlue(downstreamResult)), true);
        await app.waitFor("document.getElementById('modal-error').checkVisibility()");
        await key(app, 'Escape');
        await app.waitFor("!document.getElementById('modal-error').checkVisibility()");
        assert.equal(await app.evaluate(`document.querySelector('${compareDialog}').inert`), false, 'closing the provider error restores the underlying comparison');
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red], 'a failed rerun must keep the last successfully paired original');
        await closeComparison(app);

        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(`${background('black')}.checked`), true);
        assert.equal(await app.evaluate(`${field('finish')}.value`), 'polished');
        assert.equal(await app.evaluate(`${field('modelId')}.value`), 'image');
        assert.equal(await app.evaluate(`${field('providerId')}.value`), 'p');
        await app.waitFor(outputIsBlue(cardResult));
        await app.waitFor(outputIsBlue(downstreamResult));
        assert.equal(await app.evaluate('retouchRequests.length'), 0);
        const workflow = await saved(app);
        const resultKeys = id => workflow.nodes.find(node => node.id === id)?.mediaAssetKeys;
        assert.equal(resultKeys('retouch')?.length, 1, 'the original is a comparison asset outside the node output');
        assert.deepEqual(resultKeys('result'), resultKeys('retouch'), 'the downstream preview receives only the processed result');

        await app.send('Emulation.setDeviceMetricsOverride', { width: 620, height: 560, deviceScaleFactor: 1, mobile: false });
        await openComparison(app);
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red]);
        assert.deepEqual(await comparisonImageColors(app, 'result'), [blue, blue]);
        await closeComparison(app);
        await nativeClick(app, `${panel} [data-parameter-action=close]`);
        const originalToggle = '#retouch [data-retouch-card-view=original]';
        const resultToggle = '#retouch [data-retouch-card-view=result]';
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').checkVisibility()`), false);
        await nativeClick(app, originalToggle);
        assertRenderedColor(await sampleRenderedImageColors(app, compareStage), red);
        await nativeClick(app, resultToggle);
        assertRenderedColor(await sampleRenderedImageColors(app, compareStage), blue);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 820, deviceScaleFactor: 1, mobile: false });

        const originalAssetKey = workflow.nodes.find(node => node.id === 'retouch').productRetouchComparison.originalAssetKey;
        await app.send('Network.setCacheDisabled', { cacheDisabled: true });
        await app.send('Network.setBlockedURLs', { urls: [`*/api/storage/assets/${encodeURIComponent(originalAssetKey)}*`] });
        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        const comparisonHint = `${panel} [data-retouch-comparison-status]`;
        await app.waitFor(`document.querySelector('${comparisonHint}').checkVisibility()`);
        assert.equal(await app.evaluate(`document.querySelector('${inspect}').textContent.trim()`), '查看精修结果');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [blue, blue]);
        await app.send('Network.setBlockedURLs', { urls: [] });
        await nativeClick(app, `${panel} [data-retouch-retry-original]`);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'split'`);
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, blue]);
        await openComparison(app);
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red]);
        await closeComparison(app);

        await app.evaluate('window.wideRetouch = true');
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'switch'`);
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').checkVisibility()`), false);
        await nativeClick(app, originalToggle);
        assert.deepEqual(await app.evaluate(`(() => {
            const original = document.querySelector('${compareStage} [data-retouch-original]');
            const result = document.querySelector('${compareStage} [data-retouch-result]');
            return [original.naturalWidth / original.naturalHeight, result.naturalWidth / result.naturalHeight,
                getComputedStyle(original).objectFit, getComputedStyle(result).clipPath];
        })()`), [4 / 3, 2, 'contain', 'inset(0px 0px 0px 100%)']);

        await openParameters(app, 'retouch-clone');
        assert.equal(await app.evaluate(`${background('black')}.checked && ${background('black')}.disabled`), true);
        assert.equal(await app.evaluate(`${field('finish')}.value`), 'polished');
        assert.equal(await app.evaluate(`${field('modelId')}.value`), 'image');

        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',
            { bubbles: true, cancelable: true, clientX: 75, clientY: 380 }));`);
        const menuEntry = '#context-menu-image-nodes [data-type=ProductRetouch]';
        assert.match(await app.evaluate(`document.querySelector('${menuEntry}').textContent`), /产品精修/);
        await app.evaluate(`document.querySelector('${menuEntry}').click()`);
        await app.waitFor("document.querySelectorAll('#nodes-layer .node-product-retouch').length === 3");
    }, { initScript });
});
