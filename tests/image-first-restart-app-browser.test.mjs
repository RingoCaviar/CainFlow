import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, unlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { startCainflowServer } from './helpers/browser-theme-fixture.mjs';
import { withAppBrowser, reloadAppBrowser, delay, waitForAutosave } from './helpers/app-browser.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const png = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));

test('the isolated backend really exits and starts a new PID at the same origin using the same persisted directories', { timeout: 20000 }, async () => {
    const server = await startCainflowServer({ session: { restartSentinel: 'original-document', nodes: [], connections: [] } });
    try {
        assert.equal(typeof server.restart, 'function');
        const previous = { pid: server.pid, baseUrl: server.baseUrl, dataDir: server.dataDir, workflowsDir: server.workflowsDir };
        assert.ok(Number.isInteger(previous.pid));
        assert.equal((await fetch(`${server.baseUrl}/api/workflows/Restart%20fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId: 'restart-helper-workflow', nodes: [], connections: [], extension: { original: true } }) })).ok, true);
        const assetResponse = await fetch(`${server.baseUrl}/api/storage/media-assets`, { method: 'PUT',
            headers: { 'Content-Type': 'image/png', 'X-CainFlow-Media-Owner-Type': 'test-restart', 'X-CainFlow-Media-Owner-Id': 'restart-helper' }, body: png });
        assert.equal(assetResponse.ok, true); const asset = (await assetResponse.json()).asset;
        await server.stopProcess();
        assert.throws(() => process.kill(previous.pid, 0), /ESRCH|not found|no such process/i);
        await assert.rejects(fetch(`${server.baseUrl}/`));
        const restarted = await server.restart();
        assert.notEqual(server.pid, previous.pid); assert.equal(restarted.pid, server.pid);
        for (const field of ['baseUrl', 'dataDir', 'workflowsDir']) assert.equal(server[field], previous[field]);
        assert.equal((await fetch(`${server.baseUrl}/api/storage/documents/session`).then(response => response.json())).value.restartSentinel, 'original-document');
        const workflow = await fetch(`${server.baseUrl}/api/workflows/Restart%20fixture`).then(response => response.json());
        assert.equal(workflow.workflowId, 'restart-helper-workflow'); assert.deepEqual(workflow.extension, { original: true });
        const restored = await fetch(`${server.baseUrl}/api/storage/assets/${encodeURIComponent(asset.asset_key)}`);
        assert.equal(restored.ok, true); assert.equal(digest(Buffer.from(await restored.arrayBuffer())), digest(png));
    } finally { await server.stop(); }
    await assert.rejects(access(server.dataDir)); await assert.rejects(access(server.workflowsDir));
});

const colors = ['red', 'orange', 'blue', 'green'];
const originals = await Promise.all(colors.map(color => readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))));
const configuration = { autoCheckUpdatesOnLoad: false, autoRetry: false,
    models: [{ id: 'chat', modelId: 'chat', name: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: 'controlled image', protocol: 'openai-image', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }], nodes: [], connections: [] };
const connection = (id, source, target, port, extra = {}) => ({ id, type: 'image', from: { nodeId: source, port: 'image' }, to: { nodeId: target, port }, ...extra });
const workflowA = { workflowId: 'restart-workflow-a', nodes: [
    { id: 'source', type: 'ImageGenerate', x: 30, y: 90, width: 330, height: 280, userResized: true, customTitle: 'A complete originals', apiConfigId: 'image', providerId: 'p',
        prompt: 'workflow-a complete originals', generationCount: 3, imageDescriptions: ['red original', 'orange original', 'blue original'], customExtension: { preserved: 'source-A' } },
    { id: 'imported', type: 'ImageImport', x: 30, y: 460, width: 300, height: 260, userResized: true, customTitle: 'A imported green' },
    { id: 'compare', type: 'ImageCompare', x: 440, y: 460, width: 300, height: 260, userResized: true, comparePosition: 73 },
    { id: 'merge', type: 'ImageMerge', x: 450, y: 90, width: 350, height: 300, userResized: true, inputCount: 12, customExtension: { preserved: 'merge-A' } },
    { id: 'save', type: 'ImageSave', x: 900, y: 90, width: 330, height: 300, userResized: true, filename: 'archive-A' }
], connections: [
    connection('source-merge-second', 'source', 'merge', 'image_2', { extension: { order: 'full-three' } }),
    connection('import-merge-tenth', 'imported', 'merge', 'image_10', { extension: { order: 'fourth-original' } }),
    connection('compare-a', 'imported', 'compare', 'imageA'), connection('compare-b', 'source', 'compare', 'imageB'),
    connection('merge-save', 'merge', 'save', 'image')
] };
const workflowB = { workflowId: 'restart-workflow-b', nodes: [
    { id: 'source', type: 'ImageGenerate', x: 80, y: 160, width: 300, height: 270, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'workflow-b must remain untouched', generationCount: 1 },
    { id: 'save', type: 'ImageSave', x: 600, y: 160, width: 300, height: 270, userResized: true, filename: 'archive-B' }
], connections: [connection('b-source-save', 'source', 'save', 'image')] };
const saved = app => app.evaluate("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value)");
const file = (app, name) => app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)})).then(response=>response.json())`);
async function activate(app, name, workflowId) {
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`!!document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')`);
    await app.evaluate(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]').click()`);
    await app.waitFor(`document.querySelector('.workflow-item[data-name=${JSON.stringify(name)}]')?.classList.contains('is-active')`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor(`fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.activeWorkflowId===${JSON.stringify(workflowId)})`);
}
async function ownerKeys(app, workflowId, nodeId) {
    return app.evaluate(`fetch('/api/storage/media-owners?workflowId='+encodeURIComponent(${JSON.stringify(workflowId)})).then(response=>response.json()).then(record=>record.owners.find(owner=>owner.ownerType==='workflow-node'&&owner.ownerId===${JSON.stringify(nodeId)})?.assetKeys||[])`);
}
async function exported(directory, expectedCount) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const files = await readdir(directory).catch(() => []);
        if (files.length === expectedCount) return files.sort();
        await delay(50);
    }
    throw new Error(`Expected ${expectedCount} files in ${directory}: ${JSON.stringify(await readdir(directory).catch(() => []))}`);
}
async function assetHash(app, key) {
    const response = await fetch(`${app.server.baseUrl}/api/storage/assets/${encodeURIComponent(key)}`);
    assert.equal(response.ok, true, key); return digest(Buffer.from(await response.arrayBuffer()));
}
async function saveA(app, expectedKeys) {
    await waitForAutosave(app);
    await app.waitFor(`fetch('/api/workflows/Restart%20A').then(response=>response.json()).then(graph=>graph.nodes.find(node=>node.id==='source')?.imagePreviewIndex===1&&graph.nodes.find(node=>node.id==='merge')?.imagePreviewIndex===2&&JSON.stringify(graph.nodes.find(node=>node.id==='save')?.mediaAssetKeys)===${JSON.stringify(JSON.stringify(expectedKeys))})`);
}
async function restart(app, whileStopped = async () => {}) {
    const previous = { pid: app.server.pid, baseUrl: app.server.baseUrl, dataDir: app.server.dataDir, workflowsDir: app.server.workflowsDir };
    await app.send('Page.navigate', { url: 'about:blank' });
    await app.waitFor("location.href==='about:blank'");
    await app.server.stopProcess(); assert.throws(() => process.kill(previous.pid, 0), /ESRCH|not found|no such process/i);
    await assert.rejects(fetch(`${previous.baseUrl}/`));
    await whileStopped();
    const result = await app.server.restart(); assert.notEqual(result.pid, previous.pid);
    for (const field of ['baseUrl', 'dataDir', 'workflowsDir']) assert.equal(app.server[field], previous[field]);
    await app.send('Page.navigate', { url: app.server.baseUrl });
    await app.waitFor("window.__cainflowAppReady===true&&document.getElementById('prompt-agent-model')?.options.length>0");
    await delay(500);
    assert.equal(await app.evaluate('restartRequests.length'), 0, 'backend startup and page restoration never call the image provider');
    return [previous.pid, result.pid];
}

test('real backend restarts retain background A originals, ordered roles and owners while same-ID B and missing batch positions remain isolated', { timeout: 90000 }, async t => {
    await withAppBrowser(configuration, async app => {
        const directory = join(app.server.dataDir, 'restart-exports');
        assert.equal(await app.evaluate(`fetch('/api/storage/export-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory:${JSON.stringify(directory)}})}).then(response=>response.ok)`), true);
        await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.restartRequests=[];window.restartHeld=false;const restartFetch=fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(typeof body.prompt==='string'){const index=restartRequests.length;restartRequests.push(body);if(index===0){restartHeld=true;await new Promise(resolve=>window.releaseRestartSource=resolve);}return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(originals.slice(0, 3).map(bytes => bytes.toString('base64')))}[index%3]}]}),{headers:{'Content-Type':'application/json'}});}}return restartFetch(url,options)};` });
        await reloadAppBrowser(app);
        for (const [name, graph] of [['Restart A', workflowA], ['Restart B', workflowB]]) assert.equal(await app.evaluate(`fetch('/api/workflows/'+encodeURIComponent(${JSON.stringify(name)}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(graph)})}).then(response=>response.ok)`), true);
        await activate(app, 'Restart A', workflowA.workflowId);
        await app.evaluate(`(async()=>{const input=document.getElementById('imported-file'),files=new DataTransfer();files.items.add(new File([await(await fetch('data:image/png;base64,${originals[3].toString('base64')}')).blob()],'green.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='imported')?.mediaAssetKeys?.length===1)");
        await app.evaluate("document.getElementById('save').click()");
        await app.waitFor("document.getElementById('image-parameter-panel').dataset.nodeId==='save'&&!document.getElementById('image-parameter-panel').hidden");
        assert.equal(await app.evaluate("document.getElementById('save-filename').value"), 'archive-A');
        await app.evaluate("document.querySelector('[data-parameter-action=close]').click();document.getElementById('btn-run').click()"); await app.waitFor('restartHeld===true');
        await activate(app, 'Restart B', workflowB.workflowId); await app.evaluate('releaseRestartSource()');
        await app.waitFor("!document.querySelector('.workflow-item[data-name=\"Restart A\"]').classList.contains('is-running')");
        const names = await exported(directory, 3);
        const exportedHashes = await Promise.all(names.map(async name => digest(await readFile(join(directory, name)))));
        assert.deepEqual(exportedHashes.slice().sort(), originals.slice(0, 3).map(digest).sort(), 'generation archives its three originals without re-exporting the imported reference through the retired Save node');
        const untouchedB = await saved(app); assert.equal(untouchedB.nodes.find(node => node.id === 'source').prompt, workflowB.nodes[0].prompt);
        assert.ok(untouchedB.nodes.every(node => !node.mediaAssetKeys?.length)); assert.deepEqual(untouchedB.connections, workflowB.connections);
        await activate(app, 'Restart A', workflowA.workflowId);
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>record.value.nodes.find(node=>node.id==='save')?.mediaAssetKeys?.length===4)");
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count')?.textContent.endsWith('/ 3')");
        await app.evaluate("document.querySelector('#source-image-results .image-node-result-count').click()");
        await app.waitFor("document.querySelector('#source-image-results [data-result-index=\"1\"]')?.getClientRects().length>0");
        await app.evaluate("document.querySelector('#source-image-results [data-result-index=\"1\"]').click();document.querySelector('#source-image-results .image-node-result-count').click();document.querySelector('#merge-merge-preview .image-save-preview-counter').click()");
        await app.waitFor("document.querySelector('#merge-merge-preview [data-preview-batch-index=\"2\"]')?.getClientRects().length>0");
        await app.evaluate("document.querySelector('#merge-merge-preview [data-preview-batch-index=\"2\"]').click()");
        await app.waitFor("fetch('/api/storage/documents/session').then(response=>response.json()).then(record=>{const nodes=record.value.nodes;return nodes.find(node=>node.id==='source')?.imagePreviewIndex===1&&nodes.find(node=>node.id==='merge')?.imagePreviewIndex===2})");
        const before = await saved(app), keys = [...before.nodes.find(node => node.id === 'source').mediaAssetKeys, ...before.nodes.find(node => node.id === 'imported').mediaAssetKeys];
        assert.deepEqual(before.connections, workflowA.connections);
        assert.deepEqual(before.nodes.find(node => node.id === 'merge').mediaAssetKeys, keys); assert.deepEqual(before.nodes.find(node => node.id === 'save').mediaAssetKeys, keys);
        await saveA(app, keys); const savedA = await file(app, 'Restart A'), savedB = await file(app, 'Restart B');
        for (const [nodeId, expected] of [['source', keys.slice(0, 3)], ['merge', keys], ['save', keys], ['compare', [keys[0]]]]) assert.deepEqual(await ownerKeys(app, workflowA.workflowId, nodeId), expected);
        assert.deepEqual(await ownerKeys(app, workflowB.workflowId, 'save'), []);
        await activate(app, 'Restart B', workflowB.workflowId); const firstPids = await restart(app);
        assert.equal((await saved(app)).activeWorkflowId, workflowB.workflowId); assert.equal((await saved(app)).nodes.find(node => node.id === 'save').filename, 'archive-B');
        assert.ok((await saved(app)).nodes.every(node => !node.mediaAssetKeys?.length)); assert.deepEqual(await file(app, 'Restart B'), savedB);
        await activate(app, 'Restart A', workflowA.workflowId);
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count')?.textContent==='2 / 3'&&document.querySelector('#merge-merge-preview .image-save-preview-counter')?.textContent==='3/4'");
        const restored = await saved(app);
        for (const nodeId of ['source', 'imported', 'compare', 'merge', 'save']) {
            const previous = before.nodes.find(node => node.id === nodeId), current = restored.nodes.find(node => node.id === nodeId);
            for (const field of ['x', 'y', 'width', 'height', 'userResized', 'customTitle', 'customExtension', 'inputCount', 'comparePosition', 'filename', 'imageDescriptions']) assert.deepEqual(current[field], previous[field], `${nodeId}.${field}`);
            assert.deepEqual(current.mediaAssetKeys, previous.mediaAssetKeys, `${nodeId} complete original identities`);
        }
        assert.deepEqual(restored.connections, savedA.connections);
        for (let index = 0; index < keys.length; index++) assert.equal(await assetHash(app, keys[index]), digest(originals[index]));
        assert.deepEqual(await ownerKeys(app, workflowA.workflowId, 'save'), keys);
        assert.equal(await app.evaluate("fetch('/api/storage/export-directory').then(response=>response.json()).then(value=>value.directory)"), directory);
        assert.deepEqual(await exported(directory, 3), names);
        const firstPath = resolve(join(app.server.dataDir, 'assets', digest(originals[0]).slice(0, 2), digest(originals[0]) + '.png'));
        assert.ok(firstPath.startsWith(resolve(app.server.dataDir) + sep));
        const missingPids = await restart(app, () => unlink(firstPath)); assert.notEqual(missingPids[1], firstPids[1]);
        await app.waitFor("document.querySelector('#source-image-results .image-node-result-count')?.textContent==='2 / 3'");
        await app.evaluate("document.querySelector('#source-image-results .image-node-result-count').click()");
        await app.waitFor("document.querySelector('#source-image-results [data-result-index=\"0\"]')?.textContent.includes('原图缺失')");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#source-image-results [data-result-index]')].map(item=>Number(item.dataset.resultIndex))"), [0, 1, 2]);
        await app.evaluate("document.querySelector('#source-image-results [data-result-index=\"1\"]').click();document.querySelector('#source-image-results .image-node-result-count').click();document.querySelector('#source-image-results [data-result-action=preview]').click()");
        await app.waitFor("document.querySelector('.fullscreen-overlay img')?.naturalWidth>0");
        assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"), `data:image/png;base64,${originals[1].toString('base64')}`);
        assert.equal(await app.evaluate('restartRequests.length'), 0); await assert.rejects(access(firstPath));
        assert.equal((await fetch(`${app.server.baseUrl}/api/storage/assets/${encodeURIComponent(keys[0])}`)).status, 404);
        assert.equal(await assetHash(app, keys[1]), digest(originals[1]));
        assert.deepEqual((await file(app, 'Restart A')).nodes.find(node => node.id === 'source').mediaAssetKeys, keys.slice(0, 3));
        assert.deepEqual(await ownerKeys(app, workflowA.workflowId, 'source'), keys.slice(0, 3)); assert.deepEqual(await ownerKeys(app, workflowA.workflowId, 'save'), keys);
        assert.deepEqual(await exported(directory, 3), names);
        t.diagnostic(`same-origin backend PIDs ${firstPids[0]} → ${firstPids[1]} → ${missingPids[1]}; source=3, merge/save=4; four original hashes and persistent owners retained; missing slot 0 remains missing`);
    });
});
