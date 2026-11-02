import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    imageSaveUsePromptFilename: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'source-a', type: 'ImageImport', x: 30, y: 40, width: 240, height: 280, userResized: true },
        { id: 'save-card', type: 'ImageSave', x: 620, y: 40, width: 400, height: 390, userResized: true, customTitle: '保留保存标题', filename: 'original-prefix' },
        { id: 'note', type: 'Text', x: 1100, y: 40, text: 'selection target' }
    ],
    connections: [{ id: 'image-edge', from: { nodeId: 'source-a', port: 'image' }, to: { nodeId: 'save-card', port: 'image' }, type: 'image' }]
};
const geometry = app => app.evaluate("(()=>{const node=document.getElementById('save-card');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
async function open(app, id = 'save-card') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.dataset.nodeId===${JSON.stringify(id)} && !document.getElementById('image-parameter-panel').hidden`);
}
async function clickPreview(app, count = 1) {
    const point = await app.evaluate("(()=>{const rect=document.getElementById('save-card-save-preview').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()");
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: count });
}

test('legacy save retains its preview and separate outputs while media controls and filename use the screen-space editor', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('save-card').classList.contains('image-first-card')"), true);
        await open(app);
        assert.deepEqual(await geometry(app), ['620px', '40px', 400, 390]);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#save-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#save-card .node-port[data-direction=output]')].map(port=>[port.dataset.port,port.dataset.type,port.querySelector('.port-label').textContent.trim()])"), [['image', 'image', '图片输出'], ['video', 'video', '视频输出']]);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').contains(document.getElementById('save-card-filename')) && document.getElementById('image-parameter-panel').contains(document.getElementById('save-card-path-warning'))"), true);
        assert.equal(await app.evaluate("document.getElementById('save-card').contains(document.getElementById('save-card-save-preview')) && document.getElementById('image-parameter-panel').contains(document.getElementById('save-card-manual-save')) && document.getElementById('image-parameter-panel').contains(document.getElementById('save-card-view-full'))"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '更新媒体');
        await app.evaluate("window.originalSaveElements=['save-preview','manual-save','view-full','filename','path-warning'].map(suffix=>document.getElementById('save-card-'+suffix));const input=document.getElementById('save-card-filename');input.value='edited-prefix';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('note').click()");
        await open(app);
        assert.equal(await app.evaluate("originalSaveElements.every(element=>document.getElementById(element.id)===element && document.querySelectorAll('[id=\"'+element.id+'\"]').length===1)"), true, 'switching and closing preserve each original DOM object');
        const editorMetrics = () => app.evaluate("(()=>{const panel=document.getElementById('image-parameter-panel');return [panel.getBoundingClientRect().width,getComputedStyle(document.getElementById('save-card-filename')).fontSize]})()");
        const readable = await editorMetrics();
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await editorMetrics(), readable);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value?.nodes.find(node=>node.id==='save-card')?.filename==='edited-prefix')");
        assert.deepEqual(await geometry(app), ['620px', '40px', 400, 390]);
        await reloadAppBrowser(app);
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('save-card-filename').value"), 'edited-prefix');
        assert.deepEqual(await geometry(app), ['620px', '40px', 400, 390]);
    });
});

test('save filename controls retain explicit empty drafts and quoted Chinese text when saved and reopened', { timeout: 45000 }, async () => {
    const quoted = '中文 "图稿" & 备份';
    const edited = '后续 "调整稿" & 中文';
    await withAppBrowser({ ...session, nodes: [
        { ...session.nodes[1], filename: '' },
        { ...session.nodes[1], id: 'save-quoted', x: 100, filename: quoted }
    ], connections: [] }, async app => {
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('save-card-filename').value"), '');
        await open(app, 'save-quoted');
        assert.equal(await app.evaluate("document.getElementById('save-quoted-filename').value"), quoted);
        await app.evaluate(`(()=>{const input=document.getElementById('save-quoted-filename');input.value=${JSON.stringify(edited)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await open(app);
        await app.evaluate("const input=document.getElementById('save-card-filename');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))");
        await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value?.nodes.find(node=>node.id==='save-card')?.filename==='' && record.value?.nodes.find(node=>node.id==='save-quoted')?.filename===${JSON.stringify(edited)})`);
        await reloadAppBrowser(app);
        await open(app);
        assert.equal(await app.evaluate("document.getElementById('save-card-filename').value"), '');
        await open(app, 'save-quoted');
        assert.equal(await app.evaluate("document.getElementById('save-quoted-filename').value"), edited);
    });
});

test('save image clicks open the editor, double clicks open the original, and original manual-save controls remain usable', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('save-card').classList.contains('image-first-card')"), true);
        await app.evaluate("(async()=>{const blob=await fetch('/tests/fixtures/reference-red.png').then(response=>response.blob()),files=new DataTransfer();files.items.add(new File([blob],'red.png',{type:'image/png'}));const input=document.getElementById('source-a-file');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        await app.waitFor("document.querySelector('#save-card-save-preview img')?.naturalWidth>0");
        await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const before = await geometry(app);
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click()");
        await clickPreview(app);
        await app.waitFor("!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId==='save-card'");
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay')"), false);
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#save-card-save-preview img')).objectFit"), 'contain');
        await clickPreview(app, 2);
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        assert.equal(await app.evaluate("document.getElementById('save-card-manual-save').disabled"), false);
        await app.evaluate("document.getElementById('save-card-view-full').click()");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.waitFor("!document.querySelector('.fullscreen-overlay')");
        const downloadDirectory = join(app.server.dataDir, 'downloads');
        await mkdir(downloadDirectory, { recursive: true });
        await app.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('save-card-manual-save').click()");
        let downloaded = [];
        for (let attempt = 0; attempt < 100; attempt += 1) {
            downloaded = (await readdir(downloadDirectory)).filter(name => name.endsWith('.png'));
            if (downloaded.length) break;
            await delay(50);
        }
        assert.deepEqual(downloaded, ['original-prefix.png'], 'the original save action reads the detached filename and downloads to an isolated directory');
        const bytes = await readFile(join(downloadDirectory, downloaded[0]));
        assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.deepEqual(await geometry(app), before);
        assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>document.value.connections)"), session.connections);
    });
});
