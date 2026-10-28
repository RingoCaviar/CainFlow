import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { configuration, recordPlayableVideo, controlProviders, upload, openParameters, runNode, saved } from './helpers/image-first-integrated-fixture.mjs';

async function disconnect(app, id, edgeId) {
    await openParameters(app, id);
    await app.evaluate(`document.querySelector('#image-parameter-panel [data-input-action=disconnect][data-input-edge-id="${edgeId}"]').click()`);
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>!document.value.connections.some(edge=>edge.id===${JSON.stringify(edgeId)}))`);
}

const geometry = node => ({ x: node.x, y: node.y, width: node.width, height: node.height });

for (const omitted of ['video', 'image']) {
    test(`a completed background Save retains its ${omitted} result while identifying the other input as updated`, { timeout: 90000 }, async () => {
        await withAppBrowser({ ...configuration, nodes: [
            { id: 'source', type: 'ImageImport', x: 50, y: 150, width: 300, height: 260, userResized: true },
            { id: 'preview', type: 'ImagePreview', x: 410, y: 150, width: 300, height: 260, userResized: true },
            { id: 'save', type: 'ImageSave', x: 770, y: 150, width: 300, height: 300, userResized: true },
            { id: 'video', type: 'VideoGenerate', x: 50, y: 600, width: 300, apiConfigId: 'video', providerId: 'p', prompt: 'retained native clip' }
        ], connections: [
            { id: 'preview-image', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'preview', port: 'image' }, type: 'image' },
            { id: 'save-image', from: { nodeId: 'source', port: 'image' }, to: { nodeId: 'save', port: 'image' }, type: 'image' },
            { id: 'save-video', from: { nodeId: 'video', port: 'video' }, to: { nodeId: 'save', port: 'video' }, type: 'video' }
        ] }, async app => {
            const video = await recordPlayableVideo(app);
            await controlProviders(app, { video });
            await upload(app);
            await app.evaluate("document.getElementById('btn-run').click()");
            await app.waitFor("document.getElementById('btn-stop').disabled && fetch('/api/storage/documents/session').then(response=>response.json()).then(document=>{const node=document.value.nodes.find(node=>node.id==='save');return node?.mediaAssetKeys?.length===1&&node?.videos?.length===1})");
            const initial = (await saved(app)).nodes.find(node => node.id === 'save');
            assert.equal(await app.evaluate("document.getElementById('save-save-preview').dataset.saveState"), 'current');
            await disconnect(app, 'save', `save-${omitted}`);
            await runNode(app, 'save', true);
            const message = omitted === 'video' ? '视频输入未更新，保留原视频；图片已更新' : '图片输入未更新，保留原图片；视频已更新';
            await app.waitFor(`document.getElementById('btn-stop').disabled && document.getElementById('save-save-preview').dataset.saveMessage===${JSON.stringify(message)}`);
            const after = (await saved(app)).nodes.find(node => node.id === 'save');
            assert.equal(await app.evaluate("document.getElementById('save-save-preview').dataset.saveState"), 'stale');
            assert.deepEqual(after.mediaAssetKeys, initial.mediaAssetKeys);
            assert.deepEqual(after.videos.map(item => item.assetKey), initial.videos.map(item => item.assetKey));
            assert.deepEqual(geometry(after), geometry(initial));
            if (omitted === 'video') {
                await disconnect(app, 'preview', 'preview-image');
                await runNode(app, 'preview', true);
                await app.waitFor("document.getElementById('btn-stop').disabled && document.querySelector('#preview .image-preview-input-status')?.textContent==='未更新 · 当前无输入'");
                assert.deepEqual((await saved(app)).nodes.find(node => node.id === 'preview').mediaAssetKeys, initial.mediaAssetKeys);
                assert.ok(await app.evaluate("document.querySelector('#preview-preview img')?.naturalWidth>0"));
            }
        });
    });
}
