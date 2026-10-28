import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const camera = { id: 'camera-card', type: 'CameraControl', x: 610, y: 40, width: 400, height: 350, userResized: true,
    customTitle: '保留视角标题', pitch: 23, yaw: -47, distance: 7.2, fov: 66, roll: -9, cameraViewMode: 'thirdPerson' };
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'ImageImport', x: 50, y: 40, width: 300, height: 300, userResized: true }, camera],
    connections: [{ id: 'camera-reference', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'camera-card', port: 'image' }, type: 'image' }]
};
async function open(app, id = 'camera-card') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`document.getElementById('image-parameter-panel')?.dataset.nodeId===${JSON.stringify(id)} && !document.getElementById('image-parameter-panel').hidden`);
}
const geometry = app => app.evaluate("(()=>{const node=document.getElementById('camera-card');return [node.style.left,node.style.top,node.offsetWidth,node.offsetHeight]})()");
const summary = app => app.evaluate("[...document.querySelectorAll('#image-parameter-panel [data-camera-summary]')].map(item=>[item.dataset.cameraSummary,item.textContent])");

test('camera retains the dedicated editor button and preview while its reference input and derived read-only summaries follow the lower panel', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('camera-card').classList.contains('image-first-card')"), true);
        await open(app);
        assert.deepEqual(await geometry(app), ['610px', '40px', 400, 350]);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#camera-card .node-port[data-direction=input]')].filter(port=>port.getClientRects().length).map(port=>port.dataset.port)"), ['auto']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#camera-card .node-port[data-direction=output]')].map(port=>[port.dataset.port,port.dataset.type,port.querySelector('.port-label').textContent.trim()])"), [['text', 'text', '相机提示词']]);
        assert.equal(await app.evaluate("document.getElementById('camera-card').contains(document.getElementById('camera-card-camera-open')) && document.getElementById('camera-card').contains(document.getElementById('camera-card-camera-preview'))"), true);
        assert.equal(await app.evaluate("!!document.querySelector('#image-parameter-panel .camera-control-note') && !document.querySelector('#camera-card .camera-control-note')"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').textContent"), '编辑视角');
        assert.equal(await app.evaluate("document.querySelectorAll('#image-parameter-panel input, #image-parameter-panel textarea').length"), 0, 'the lower panel summarizes existing camera state without adding duplicate editable controls');
        assert.deepEqual(await summary(app), [['pitch', '23°'], ['yaw', '-47°'], ['distance', '7.2'], ['fov', '66°'], ['roll', '-9°'], ['viewMode', '第三人称']]);
        assert.match(await app.evaluate("document.querySelector('#image-parameter-panel .image-camera-prompt-summary').textContent"), /yaw -47°.*pitch 23°.*distance 7\.2.*FOV 66°.*roll -9°/);
        await app.evaluate("window.originalCameraElements=['camera-open','camera-preview'].map(suffix=>document.getElementById('camera-card-'+suffix));document.querySelector('#image-parameter-panel [data-parameter-action=close]').click();document.getElementById('source').click()");
        await open(app);
        assert.equal(await app.evaluate("originalCameraElements.every(element=>document.getElementById(element.id)===element)"), true);
        const readable = await app.evaluate("[document.getElementById('image-parameter-panel').getBoundingClientRect().width,getComputedStyle(document.querySelector('#image-parameter-panel [data-camera-summary=pitch]')).fontSize]");
        await app.evaluate("document.querySelector('#canvas-navigation .canvas-zoom-menu>summary').click();document.querySelector('#canvas-navigation [data-zoom=\"0.5\"]').click()");
        await app.waitFor("document.getElementById('zoom-level').textContent==='50%'");
        assert.deepEqual(await app.evaluate("[document.getElementById('image-parameter-panel').getBoundingClientRect().width,getComputedStyle(document.querySelector('#image-parameter-panel [data-camera-summary=pitch]')).fontSize]"), readable);
        await reloadAppBrowser(app);
        await open(app);
        assert.deepEqual(await geometry(app), ['610px', '40px', 400, 350]);
        assert.deepEqual(await summary(app), [['pitch', '23°'], ['yaw', '-47°'], ['distance', '7.2'], ['fov', '66°'], ['roll', '-9°'], ['viewMode', '第三人称']]);
    });
});

test('the lower panel delegates to the original camera editor and preserves all camera changes and its generated snapshot', { timeout: 45000 }, async () => {
    await withAppBrowser(session, async app => {
        assert.equal(await app.evaluate("document.getElementById('camera-card').classList.contains('image-first-card')"), true);
        await open(app);
        await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').click()");
        await app.waitFor("!!document.querySelector('.camera-control-editor-overlay .camera-control-canvas')");
        assert.equal(await app.evaluate("document.querySelectorAll('.camera-control-editor-overlay').length"), 1);
        const settings = { pitch: -15, yaw: 73, distance: 4.6, fov: 85, roll: 17 };
        await app.evaluate(`(()=>{for(const [key,value]of Object.entries(${JSON.stringify(settings)})){const field=document.querySelector('[data-camera-value="'+key+'"]');field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('[data-camera-view-mode=firstPerson]').click();document.querySelector('.camera-control-editor-close').click();})()`);
        await app.waitFor("!document.querySelector('.camera-control-editor-overlay')");
        await app.waitFor("document.querySelector('#camera-card-camera-preview img')?.naturalWidth>0");
        assert.equal(await app.evaluate("getComputedStyle(document.querySelector('#camera-card-camera-preview img')).objectFit"), 'contain');
        await open(app);
        assert.deepEqual(await summary(app), [['pitch', '-15°'], ['yaw', '73°'], ['distance', '4.6'], ['fov', '85°'], ['roll', '17°'], ['viewMode', '第一人称']]);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>{const node=record.value?.nodes.find(node=>node.id==='camera-card');return node?.yaw===73 && node?.roll===17 && node?.cameraViewMode==='firstPerson' && !!node?.cameraPreviewImage})");
        await reloadAppBrowser(app);
        await open(app);
        assert.deepEqual(await summary(app), [['pitch', '-15°'], ['yaw', '73°'], ['distance', '4.6'], ['fov', '85°'], ['roll', '17°'], ['viewMode', '第一人称']]);
        assert.deepEqual(await geometry(app), ['610px', '40px', 400, 350]);
    });
});

test('camera clones keep parameter editing locked while their image reference controls remain available', { timeout: 30000 }, async () => {
    await withAppBrowser({ ...session, nodes: [...session.nodes, { ...camera, id: 'camera-clone', x: 1030, isClone: true, cloneSourceId: 'camera-card' }],
        connections: [...session.connections, { ...session.connections[0], id: 'clone-reference', to: { nodeId: 'camera-clone', port: 'image' } }] }, async app => {
        assert.equal(await app.evaluate("document.getElementById('camera-clone').classList.contains('image-first-card')"), true);
        await open(app, 'camera-clone');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').disabled"), true);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-input-action=disconnect]').disabled"), false);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-camera-prompt-summary').getAttribute('contenteditable')"), null);
    });
});
