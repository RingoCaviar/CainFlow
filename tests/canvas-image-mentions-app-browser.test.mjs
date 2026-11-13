import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

const image = async file => (await readFile(new URL(file, import.meta.url))).toString('base64');
const product = await image('../artifacts/prototype-image-first-canvas/assets/product.png');
const detail = await image('../artifacts/prototype-image-first-canvas/assets/scene-detail.png');
const background = await image('../artifacts/prototype-image-first-canvas/assets/scene-snow.png');
const workflowId = 'image-mention-workflow';
const generate = (id, title, x, y) => ({ id, type: 'ImageGenerate', apiConfigId: 'image-model', providerId: 'p', customTitle: title,
    x, y, prompt: id === 'target' ? '' : '目录样图' });
const session = {
    autoCheckUpdatesOnLoad: false, activeWorkflowId: workflowId, activeWorkflowName: '参考图试验',
    models: [{ id: 'image-model', modelId: 'gemini-image', name: '受控生图', taskType: 'image', protocol: 'google', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'product', type: 'ImageImport', customTitle: '户外灯正面', x: 50, y: 120 },
        { id: 'detail', type: 'ImageImport', customTitle: '灯罩细节', x: 820, y: 120 },
        generate('background', '背景样图', 50, 520), generate('target', '海报制作', 420, 140)
    ],
    connections: [{ id: 'product-to-target', type: 'image', from: { nodeId: 'product', port: 'image' },
        to: { nodeId: 'target', port: 'referenceImages' }, order: 0 }]
};
session.workflowTabs = [{ workflowId, name: session.activeWorkflowName, data: { workflowId, nodes: session.nodes, connections: session.connections } }];
const picker = '.image-mention-picker';
const options = picker + ' [data-mention-id]';

async function openParameters(app, id) {
    await app.evaluate(`document.getElementById('${id}').click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='${id}'`);
}

async function type(app, text) {
    await app.evaluate("document.getElementById('target-prompt').focus()");
    await app.send('Input.insertText', { text });
}

async function click(app, selector) {
    const point = await app.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

test('canvas @ mentions use the selected import and directory original after reopening, preserving the upstream input', { timeout: 55000 }, async () => {
    await withAppBrowser(session, async app => {
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.referenceRequests=[];const originalFetch=fetch;
            window.fetch=async(url, options={})=>{
                if(String(url)==='/proxy'&&options.body){
                    const body=JSON.parse(options.body);
                    if(body.contents){
                        referenceRequests.push(body.contents.at(-1).parts);
                        return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(background)}}}]}}]});
                    }
                }
                return originalFetch(url, options);
            };` });
        await reloadAppBrowser(app);
        await uploadImageOriginal(app, 'product', 'data:image/png;base64,' + product);
        await uploadImageOriginal(app, 'detail', 'data:image/png;base64,' + detail);
        await openParameters(app, 'background');
        await app.evaluate("document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("document.getElementById('background-run-status').dataset.status==='completed' && fetch('/api/storage/library').then(r=>r.json()).then(l=>l.count===1)");
        await openParameters(app, 'target');
        await type(app, '保留 @');
        assert.equal(await app.evaluate("document.getElementById('target-prompt').value"), '保留 @');
        assert.equal(await app.evaluate(`document.querySelector('${picker}')?.getAttribute('aria-label')`), '提及图片');
        await app.waitFor(`document.querySelectorAll('${options} .has-image img').length===1`);
        assert.equal(await app.evaluate(`document.querySelector('${options} .image-mention-name').textContent`), '户外灯正面');
        assert.equal(await app.evaluate(`document.querySelector('${picker} [data-mention-mode=upstream]').getAttribute('aria-pressed')`), 'true');
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
        await type(app, '融合 @');
        await click(app, `${picker} [data-mention-mode=scene]`);
        await app.waitFor(`document.querySelectorAll('${options} .has-image img').length===4`);
        if (process.env.CAINFLOW_MENTION_APP_SCREENSHOT) {
            const { data } = await app.send('Page.captureScreenshot', { format: 'png' });
            await writeFile(process.env.CAINFLOW_MENTION_APP_SCREENSHOT, Buffer.from(data, 'base64'));
        }
        assert.match(await app.evaluate(`document.querySelector('${picker}').innerText`), /导入图片[\s\S]*节点输出[\s\S]*目录历史/);
        await app.evaluate(`[...document.querySelectorAll('${options}')].find(row=>row.querySelector('.image-mention-name').textContent==='灯罩细节').click()`);
        await type(app, '背景参考 @');
        await click(app, `${picker} [data-mention-mode=scene]`);
        await app.waitFor(`[...document.querySelectorAll('${options}')].some(row=>row.querySelector('.image-mention-source').textContent==='目录历史')`);
        await app.evaluate(`[...document.querySelectorAll('${options}')].find(row=>row.querySelector('.image-mention-source').textContent==='目录历史').click()`);
        assert.equal(await app.evaluate("document.getElementById('target-prompt').value"), '保留 @图片1 融合 @图片2 背景参考 @图片3 ');
        await reloadAppBrowser(app);
        await openParameters(app, 'target');
        assert.equal(await app.evaluate("document.getElementById('target-prompt').value"), '保留 @图片1 融合 @图片2 背景参考 @图片3 ');
        await app.evaluate("document.querySelector('[data-parameter-action=generate]').click()");
        await app.waitFor("referenceRequests.length===1 && document.getElementById('target-run-status').dataset.status==='completed'");
        const request = await app.evaluate('referenceRequests[0]');
        assert.equal(request.find(part => part.text).text, '保留 参考图 1 融合 参考图 2 背景参考 参考图 3');
        assert.deepEqual(request.flatMap(part => part.inlineData ? [part.inlineData.data] : []), [product, detail, background]);
    });
});
