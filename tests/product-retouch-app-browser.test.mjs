import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { nativeClick, openParameters } from './helpers/image-first-integrated-fixture.mjs';

const panel = '#image-parameter-panel';
const runButton = `document.querySelector('${panel} [data-retouch-action=run]')`;
const field = selector => `document.querySelector('${panel} [data-retouch-field=${selector}]')`;
const background = value => `document.querySelector('${panel} [data-retouch-field=background][value=${value}]')`;

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

test('product retouch sends the original reference with the chosen finish and restores the downstream result', { timeout: 45000 }, async () => {
    const source = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
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
            if (window.rejectRetouch) return Response.json({ data: [{ b64_json: 'YnJva2Vu' }] });
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

        await app.evaluate('window.rejectRetouch = true');
        await app.waitFor(`!${runButton}.disabled`);
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor(`${status}.textContent.includes('已保留上次结果')`);
        assert.equal(await app.evaluate('retouchRequests.length'), 2);
        assert.equal(await app.evaluate(outputIsBlue(cardResult)), true);
        assert.equal(await app.evaluate(outputIsBlue(downstreamResult)), true);

        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(`${background('black')}.checked`), true);
        assert.equal(await app.evaluate(`${field('finish')}.value`), 'polished');
        assert.equal(await app.evaluate(`${field('modelId')}.value`), 'image');
        assert.equal(await app.evaluate(`${field('providerId')}.value`), 'p');
        await app.waitFor(outputIsBlue(cardResult));
        await app.waitFor(outputIsBlue(downstreamResult));
        assert.equal(await app.evaluate('retouchRequests.length'), 0);

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
