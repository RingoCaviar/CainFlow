import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, delay } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

async function callCanvas(server, token, method, args = {}) {
    const response = await fetch(`${server.baseUrl}/api/canvas-mcp/call`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, args })
    });
    return { status: response.status, ...await response.json() };
}

test('MCP edits a canvas in place, restores it through history and stops a targeted run', { timeout: 60000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const workflowId = 'general-canvas-operations';
    const nodes = [
        { id: 'source', type: 'Text', x: 100, y: 120, text: 'source' },
        { id: 'chat', type: 'TextChat', customTitle: '答复', x: 500, y: 120, apiConfigId: 'chat-model', providerId: 'provider',
            prompt: 'Return the controlled text.', fixed: false },
        { id: 'commerce', type: 'ECommerceImageSet', x: 100, y: 350,
            commerceImageSet: { productInfo: { name: '旧名称', audience: '通勤人群' }, autoProductInfo: { name: '旧名称' } } }
    ];
    const canvas = { x: -280, y: -660, zoom: 0.75 };
    const data = { workflowId, nodes, connections: [], canvas };
    const fixture = { ...data, autoCheckUpdatesOnLoad: false, activeWorkflowName: 'Canvas operations', activeWorkflowId: workflowId,
        workflowTabs: [{ name: 'Canvas operations', workflowId, data }],
        models: [{ id: 'chat-model', modelId: 'canvas-chat', name: 'Chat', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Test', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };
    const initScript = `window.canvasRunRequests = 0;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options={}) => {
            if (String(url) !== '/proxy' || !options.body || JSON.parse(options.body).model !== 'canvas-chat') return nativeFetch(url, options);
            window.canvasRunRequests++;
            if (window.canvasRunRequests > 1) {
                return Promise.resolve(Response.json({ error: { message: 'Incorrect API key provided: private-provider-detail' } }, { status: 401 }));
            }
            return new Promise((resolve,reject) => {
                const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
                if (options.signal?.aborted) abort();
                else options.signal?.addEventListener('abort', abort, {once:true});
            });
        };`;
    try {
        await withAppBrowser(fixture, async app => {
            const call = async (method, args) => {
                let reply;
                for (let attempt = 0; attempt < 20; attempt++) {
                    reply = await callCanvas(app.server, token, method, args);
                    if (reply.status !== 409 || /no longer current/i.test(reply.error || '')) break;
                    await delay(150);
                }
                assert.equal(reply.status, 200, reply.error);
                assert.equal(reply.error, undefined, reply.error);
                return reply.result;
            };
            const scope = ({ editorId, workflowId, revision }) => ({ editorId, workflowId, revision });
            const before = await call('read_canvas');
            const next = await call('read_canvas', { ...scope(before), offset: 1 });
            assert.equal(next.revision, before.revision);
            assert.deepEqual(next.nodes.map(node => node.id), before.nodes.slice(1).map(node => node.id));
            const viewport = await app.evaluate(`import('/js/app/bootstrap.js').then(async module => {
                const { x, y, zoom } = (await module.bootstrapCainFlowApp()).state.canvas;
                const { width, height } = document.getElementById('canvas-container').getBoundingClientRect();
                return { canvas: { x, y, zoom }, width, height };
            })`);
            assert.deepEqual(viewport.canvas, canvas);
            assert.ok(before.creatableTypes.includes('TextMerge'));
            const commerce = snapshot => snapshot.nodes.find(node => node.id === 'commerce');
            assert.deepEqual(commerce(before).parameters.productInfo, { name: '旧名称', audience: '通勤人群' });
            assert.equal(commerce(before).parameters.copyLanguage, 'auto');
            assert.ok(commerce(before).parameterOptions.copyLanguage.includes('ja'));
            await call('edit_canvas', { ...scope(before), plan: { version: 1, steps: [
                { id: 'patch-source', type: 'Text', nodeId: 'source', execute: false, patch: { title: '已改名', x: -120, y: 320, enabled: false } },
                { id: 'add-merge', type: 'TextMerge', execute: false },
                { id: 'edit-product', type: 'ECommerceImageSet', nodeId: 'commerce', execute: false,
                    parameters: { productInfo: { name: '随行杯', sellingPoints: ['带可拆杯盖'] }, copyLanguage: 'ja' } }
            ] } });
            const stalePage = await callCanvas(app.server, token, 'read_canvas', { ...scope(before), offset: 1 });
            assert.equal(stalePage.errorCode, 'stale_revision');
            assert.match(stalePage.error, /画布已修改/);
            const edited = await call('read_canvas');
            const source = edited.nodes.find(node => node.id === 'source');
            assert.equal(source.name, '已改名');
            assert.equal(source.enabled, false);
            assert.deepEqual([source.position.x, source.position.y], [-120, 320]);
            assert.equal(edited.nodes.filter(node => node.type === 'Text').length, 1);
            assert.equal(edited.totalNodes, 4);
            const merge = edited.nodes.find(node => node.type === 'TextMerge');
            const placement = await app.evaluate(`import('/js/app/bootstrap.js').then(async module => {
                const { state } = await module.bootstrapCainFlowApp();
                const { x, y, el } = state.nodes.get(${JSON.stringify(merge.id)});
                return { x, y, width: el.offsetWidth, height: el.offsetHeight };
            })`);
            assert.deepEqual([merge.position.x, merge.position.y], [placement.x, placement.y]);
            // Applying a plan focuses the new node. Project its center into the viewport from before the edit.
            const screenX = canvas.x + (placement.x + placement.width / 2) * canvas.zoom;
            const screenY = canvas.y + (placement.y + placement.height / 2) * canvas.zoom;
            assert.ok(Math.abs(screenX / viewport.width - 0.5) < 0.18, `new standalone node center x = ${screenX}`);
            assert.ok(Math.abs(screenY / viewport.height - 0.5) < 0.18, `new standalone node center y = ${screenY}`);
            assert.deepEqual(commerce(edited).parameters.productInfo, { name: '随行杯', audience: '通勤人群', sellingPoints: ['带可拆杯盖'] });
            assert.equal(commerce(edited).parameters.copyLanguage, 'ja');
            assert.equal((await call('undo_canvas', scope(edited))).changed, true);
            const undone = await call('read_canvas');
            assert.equal(undone.totalNodes, 3);
            assert.equal(undone.nodes.find(node => node.id === 'source').enabled, true);
            assert.deepEqual(commerce(undone).parameters, commerce(before).parameters);
            assert.equal((await call('redo_canvas', scope(undone))).changed, true);
            const redone = await call('read_canvas');
            assert.equal(redone.nodes.find(node => node.id === 'source').name, '已改名');
            assert.deepEqual(commerce(redone).parameters, commerce(edited).parameters);
            const run = await call('run_workflow', { ...scope(redone), targetNodeId: 'chat' });
            await app.waitFor('window.canvasRunRequests === 1');
            assert.ok((await call('stop_workflow', scope(await call('read_canvas')))).stopped > 0);
            const waitForRun = async runId => {
                for (let attempt = 0; attempt < 30; attempt++) {
                    const result = await call('get_workflow_run', { editorId: redone.editorId, workflowId, runId });
                    if (result.status !== 'running') return result;
                    await delay(150);
                }
                assert.fail('MCP run did not finish');
            };
            const result = await waitForRun(run.runId);
            assert.ok(['stopped', 'cancelled'].includes(result.status), result.status);
            const failed = await call('run_workflow', { ...scope(await call('read_canvas')), targetNodeId: 'chat' });
            const failure = (await waitForRun(failed.runId)).nodeResults.find(node => node.nodeId === 'chat');
            assert.equal(failure.succeeded, false);
            assert.equal(failure.errorCode, 'node_invalid_api_key');
            assert.match(failure.error, /检查配置/);
            assert.ok(!JSON.stringify(failure).includes('private-provider-detail'));
        }, { initScript });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});

test('Agent and MCP import history originals and apply the correct saved prompt fields', { timeout: 60000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const workflowId = 'scoped-history-preset';
    const nodes = [
        { id: 'prompt-text', type: 'Text', text: 'Before preset', x: 40, y: 80 },
        { id: 'hero', type: 'ImageGenerate', customTitle: '主图', prompt: 'Local fallback',
            apiConfigId: 'gpt', providerId: 'provider', x: 400, y: 80 }
    ];
    const connections = [{ id: 'keep-prompt-edge', from: { nodeId: 'prompt-text', port: 'text' },
        to: { nodeId: 'hero', port: 'prompt' }, type: 'text' }];
    const data = { workflowId, nodes, connections };
    const fixture = { ...data, autoCheckUpdatesOnLoad: false, activeWorkflowName: 'History preset', activeWorkflowId: workflowId,
        workflowTabs: [{ name: 'History preset', workflowId, data }],
        models: [{ id: 'gpt', modelId: 'gpt-image-1', name: 'Image', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Test', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };
    try {
        await withAppBrowser(fixture, async app => {
            const call = async (method, args) => {
                let reply;
                for (let attempt = 0; attempt < 20; attempt++) {
                    reply = await callCanvas(app.server, token, method, args);
                    if (reply.status !== 409 || /no longer current/i.test(reply.error || '')) break;
                    await delay(150);
                }
                assert.equal(reply.status, 200, reply.error);
                assert.equal(reply.error, undefined, reply.error);
                return reply.result;
            };
            const sendLocal = async text => {
                await app.evaluate(`(() => {
                    if (!document.getElementById('prompt-agent-panel').classList.contains('active')) document.getElementById('btn-prompt-agent').click();
                    const input = document.getElementById('prompt-agent-input');
                    input.value = ${JSON.stringify(text)};
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                })()`);
                assert.equal(await app.evaluate("document.getElementById('prompt-agent-send').disabled"), false);
                await app.evaluate("document.getElementById('prompt-agent-send').click()");
            };
            const scope = ({ editorId, workflowId, revision }) => ({ editorId, workflowId, revision });
            const historyId = await app.evaluate(`(async () => {
                const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
                window.historyImportOriginal = document.createElement('canvas').toDataURL();
                return (await createDiskStorageApi(() => ({})).saveHistoryEntry({ image: historyImportOriginal })).fileId;
            })()`);
            const { items: [history] } = await call('list_history', { id: historyId });
            const beforeImport = scope(await call('read_canvas'));
            const imported = await call('import_history', { ...beforeImport, items: [{ id: history.id, fileVersion: history.fileVersion }] });
            const importedNode = imported.imported[0].nodeId;
            assert.ok(importedNode);
            await app.waitFor(`!!document.getElementById(${JSON.stringify(importedNode)})`);
            const samePixels = await app.evaluate(`(async () => {
                const app = await import('/js/app/bootstrap.js').then(m => m.bootstrapCainFlowApp());
                const node = app.state.nodes.get(${JSON.stringify(importedNode)});
                const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
                return (await createDiskStorageApi(() => ({})).getImageAsset(node.data.imageImportAssetKey)) === historyImportOriginal;
            })()`);
            assert.equal(samePixels, true);
            const stale = await callCanvas(app.server, token, 'import_history', {
                ...beforeImport, items: [{ id: history.id, fileVersion: history.fileVersion }]
            });
            assert.match(stale.error, /画布已修改/);
            await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
            await app.waitFor(`!document.getElementById(${JSON.stringify(importedNode)})`);
            await app.waitFor("document.body.textContent.includes('已撤回上一步操作')");
            await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
            await app.waitFor(`!!document.getElementById(${JSON.stringify(importedNode)})`);
            await app.waitFor("document.body.textContent.includes('已重做上一步操作')");

            await sendLocal(`把历史图片 ID ${history.id} 导入当前画布`);
            await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已导入 1 张历史原图')");
            const afterBothImports = await call('read_canvas');
            assert.equal(afterBothImports.nodes.filter(node => node.type === 'ImageImport').length, 2);

            const preset = await call('save_prompt', { name: '白底规则', content: '保留标签，使用白底' });
            await sendLocal('把库里的「白底规则」套用到「主图」的普通提示词');
            await app.waitFor("!!document.querySelector('.prompt-agent-canvas-plan')");
            assert.equal(await app.evaluate("document.getElementById('prompt-text-text').value"), 'Before preset');
            await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan button')].find(button=>button.textContent==='仅应用').click()");
            await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
            const afterOrdinary = await call('read_canvas');
            assert.equal(afterOrdinary.nodes.find(node => node.id === 'prompt-text').parameters.text, preset.content);
            assert.equal(afterOrdinary.nodes.find(node => node.id === 'hero').parameters.prompt, 'Local fallback');
            assert.equal(afterOrdinary.totalNodes, afterBothImports.totalNodes);
            assert.deepEqual(afterOrdinary.connections, afterBothImports.connections);

            const applied = await call('apply_prompt', { ...scope(afterOrdinary), nodeId: 'hero', promptId: preset.id, target: 'system' });
            assert.equal(applied.appliedNodeId, 'hero');
            await reloadAppBrowser(app);
            const reloaded = await call('read_canvas');
            assert.equal(reloaded.nodes.find(node => node.id === 'hero').parameters.protocolParams.systemPrompt, preset.content);
            assert.equal(reloaded.nodes.filter(node => node.type === 'ImageImport').length, 2);
        });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});

test('Agent and MCP share blank workflows, history notes and durable prompt presets without a Provider', { timeout: 60000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const nodes = [{ id: 'keep-me', type: 'Text', text: 'Existing content', x: 40, y: 50 }];
    const data = { workflowId: 'app-actions-original', nodes, connections: [] };
    const fixture = { ...data, autoCheckUpdatesOnLoad: false, models: [], providers: [],
        activeWorkflowName: 'Original', activeWorkflowId: data.workflowId,
        workflowTabs: [{ name: 'Original', workflowId: data.workflowId, data }] };
    try {
        await withAppBrowser(fixture, async app => {
            const call = async (method, args) => {
                let reply;
                for (let attempt = 0; attempt < 20; attempt++) {
                    reply = await callCanvas(app.server, token, method, args);
                    if (reply.status !== 409 || /no longer current/i.test(reply.error || '')) break;
                    await delay(150);
                }
                assert.equal(reply.status, 200, reply.error);
                return reply.result;
            };
            const sendLocal = async text => {
                await app.evaluate(`(() => {
                    if (!document.getElementById('prompt-agent-panel').classList.contains('active')) document.getElementById('btn-prompt-agent').click();
                    const input = document.getElementById('prompt-agent-input');
                    input.value = ${JSON.stringify(text)};
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                })()`);
                assert.equal(await app.evaluate("document.getElementById('prompt-agent-send').disabled"), false);
                await app.evaluate("document.getElementById('prompt-agent-send').click()");
            };
            const original = await call('read_canvas');
            assert.equal(original.workflowId, data.workflowId);
            const fileId = await app.evaluate(`(async () => {
                const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
                const image = document.createElement('canvas').toDataURL();
                return (await createDiskStorageApi(() => ({})).saveHistoryEntry({image, prompt: 'Image prompt'})).fileId;
            })()`);
            const history = await call('list_history');
            const image = history.items.find(item => String(item.id) === String(fileId));
            assert.ok(image?.fileVersion);
            assert.equal(image.prompt, 'Image prompt');
            assert.ok(!Object.hasOwn(image, 'fileUrl') && !Object.hasOwn(image, 'relativePath'));
            await sendLocal('给最新一张历史图片加备注：正面样片');
            await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已保存历史图片备注')");
            assert.equal((await call('list_history', { id: image.id })).items[0].note, '正面样片');
            await call('annotate_history', { id: image.id, fileVersion: image.fileVersion, note: '由 MCP 更新' });

            await sendLocal('保存提示词『白底规则』：保留包装文字');
            await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已保存到提示词库')");
            const saved = (await call('list_prompts', { query: '白底规则' })).prompts[0];
            assert.equal(saved.content, '保留包装文字');
            const updated = await call('save_prompt', { name: '白底规则', content: '保留标签并使用柔光' });
            assert.equal(updated.id, saved.id);
            const blank = await call('create_workflow', { name: 'MCP blank' });
            const newCanvas = await call('read_canvas');
            assert.equal(newCanvas.workflowId, blank.workflowId);
            assert.equal(newCanvas.totalNodes, 0);
            assert.equal(newCanvas.totalConnections, 0);
            await sendLocal('新建空白工作流，命名为『Agent blank』');
            await app.waitFor("document.body.textContent.includes('已新建空白工作流「Agent blank」')");
            assert.notEqual((await call('read_canvas')).workflowId, blank.workflowId);

            assert.equal(await app.evaluate('window.externalAppActionRequests'), 0);
            await reloadAppBrowser(app);
            assert.equal((await call('list_prompts', { query: '白底规则' })).prompts[0].content, '保留标签并使用柔光');
            assert.equal((await call('list_history', { id: image.id })).items[0].note, '由 MCP 更新');
            assert.equal(await app.evaluate('window.externalAppActionRequests'), 0);
        }, { initScript: `window.externalAppActionRequests = 0;
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (String(url) === '/proxy') window.externalAppActionRequests++;
                return nativeFetch(url, options);
            };` });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});

test('local MCP bridge reads, edits, undoes and runs the active editor canvas', { timeout: 45000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const workflowId = 'mcp-workflow';
    const nodes = [
        { id: 'note', type: 'Text', x: 100, y: 120, text: 'Before MCP' },
        { id: 'chat', type: 'TextChat', x: 100, y: 480, apiConfigId: 'chat-model', providerId: 'provider',
            prompt: 'Return the controlled text.', fixed: false }
    ];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const generatedText = '这是该次运行生成的文本。';
    const initScript = `window.testImageRequests=0; window.testChatRequests=0; const nativeFetch=window.fetch.bind(window);
        window.fetch=(url,options)=>{
            if(String(url)==='/proxy'&&options?.body) {
                if(JSON.parse(options.body).model==='mcp-test-chat') {
                    window.testChatRequests++;
                    return Promise.resolve(Response.json({choices:[{message:{content:${JSON.stringify(generatedText)}}}]}));
                }
                window.testImageRequests++;
                return Promise.resolve(Response.json({data:[{b64_json:${JSON.stringify(png)}}]}));
            }
            return nativeFetch(url,options);
        };`;
    try {
        await withAppBrowser({ nodes, connections: [], autoCheckUpdatesOnLoad: false,
            models: [
                { id: 'img', modelId: 'gpt-image-1', name: 'Test Image', taskType: 'image', protocol: 'openai', providerIds: ['provider'] },
                { id: 'chat-model', modelId: 'mcp-test-chat', name: 'Test Chat', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }
            ],
            providers: [{ id: 'provider', name: 'Test Provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }], workflowTabs: [{
            name: 'MCP', workflowId, data: { workflowId, nodes, connections: [] }
        }], activeWorkflowName: 'MCP', activeWorkflowId: workflowId }, async ({ server, evaluate, waitFor }) => {
            const call = (method, args) => callCanvas(server, token, method, args);
            let canvas;
            for (let attempt = 0; attempt < 20; attempt++) {
                canvas = await call('read_canvas');
                if (canvas.status !== 409) break;
                await delay(150);
            }
            assert.equal(canvas.status, 200);
            assert.equal(canvas.result.workflowId, workflowId);
            assert.equal(canvas.result.nodes.find(node => node.id === 'note').parameters.text, 'Before MCP');
            assert.ok(canvas.result.revision);
            assert.ok(canvas.result.editorId);
            const target = { editorId: canvas.result.editorId, workflowId, revision: canvas.result.revision };
            const plan = { version: 1, steps: [
                { id: 'note_step', nodeId: 'note', type: 'Text', parameters: { text: 'After MCP' } },
                { id: 'image_step', type: 'ImageGenerate', title: 'MCP image', parameters: { prompt: 'Fallback prompt' } }
            ], connections: [{ from: { ref: 'note_step', port: 'text' }, to: { ref: 'image_step', port: 'prompt' } }] };
            const edited = await call('edit_canvas', { ...target, plan });
            assert.equal(edited.status, 200, edited.error);
            assert.equal(edited.error, undefined, edited.error);
            assert.equal(edited.result.bindings.note_step, 'note');
            const imageId = edited.result.bindings.image_step;
            assert.ok(imageId);
            await waitFor(`document.getElementById(${JSON.stringify(imageId)}) && document.getElementById('note-text').value==='After MCP'`);
            assert.equal(await evaluate('window.testImageRequests'), 0);
            const stale = await call('edit_canvas', { ...target, plan });
            assert.match(stale.error, /画布已修改|stale_revision/);

            await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
            await waitFor("document.getElementById('note-text').value==='Before MCP' && document.querySelectorAll('#nodes-layer .node').length===2");
            await waitFor("document.body.textContent.includes('已撤回上一步操作')");
            await evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
            await waitFor(`document.getElementById(${JSON.stringify(imageId)}) && document.getElementById('note-text').value==='After MCP'`);
            await waitFor("document.body.textContent.includes('已重做上一步操作')");
            const afterRedo = await call('read_canvas');
            assert.equal(afterRedo.result.connections[0].to.nodeId, imageId);

            const started = await call('run_workflow', { ...target, revision: afterRedo.result.revision, nodeIds: [imageId, 'chat'] });
            assert.equal(started.status, 200, started.error);
            assert.equal(started.error, undefined, started.error);
            const run = { editorId: target.editorId, workflowId, runId: started.result.runId };
            let result;
            for (let attempt = 0; attempt < 50; attempt++) {
                result = await call('get_workflow_run', run);
                assert.equal(result.status, 200, result.error);
                assert.equal(result.error, undefined, result.error);
                if (result.result.status !== 'running') break;
                await delay(150);
            }
            assert.equal(result.result.status, 'completed');
            assert.equal(result.result.nodeResults.find(node => node.nodeId === imageId).imageCount, 1);
            assert.deepEqual(result.result.nodeResults.find(node => node.nodeId === 'chat').texts, [generatedText]);
            assert.equal(await evaluate('window.testImageRequests'), 1);
            assert.equal(await evaluate('window.testChatRequests'), 1);
            const image = await call('get_run_image', { ...run, nodeId: imageId, index: 0 });
            assert.equal(image.status, 200, image.error);
            assert.equal(image.error, undefined, image.error);
            assert.equal(image.result.mimeType, 'image/png');
            assert.equal(image.result.data, png);

            const configure = enabled => evaluate(`(async () => {
                const response = await fetch('/api/canvas-mcp/settings', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CainFlow-Canvas-MCP': 'settings' },
                    body: JSON.stringify({ action: 'set_enabled', enabled: ${enabled} })
                });
                const result = await response.json();
                if (response.ok) window.dispatchEvent(new CustomEvent('cainflow:canvas-mcp-changed', { detail: { enabled: result.enabled } }));
                return result.enabled;
            })()`);
            const timeOrigin = await evaluate('performance.timeOrigin');
            assert.equal(await configure(false), false);
            assert.equal((await call('read_canvas')).status, 404);
            assert.equal(await configure(true), true);
            for (let attempt = 0; attempt < 20; attempt++) {
                canvas = await call('read_canvas');
                if (canvas.status !== 409) break;
                await delay(150);
            }
            assert.equal(canvas.status, 200, canvas.error);
            assert.equal(canvas.result.workflowId, workflowId);
            assert.equal(await evaluate('performance.timeOrigin'), timeOrigin);
        }, { initScript });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});

test('MCP builds and runs separate image branches with one shared prompt and configured model', { timeout: 45000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const workflowId = 'mcp-image-batch';
    const sourceNodeIds = ['red', 'blue'];
    const images = await Promise.all(sourceNodeIds.map(async color =>
        (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    const nodes = [
        ...sourceNodeIds.map((id, index) => ({ id, type: 'ImageImport', x: 100, y: 120 + index * 350 })),
        { id: 'unrelated', type: 'ImageGenerate', x: 700, y: 120, apiConfigId: 'gemini', providerId: 'provider', prompt: 'Unrelated' }
    ];
    const initScript = `window.batchRequests=[];const nativeFetch=window.fetch;
        window.fetch=async(url,options={})=>{
            if(String(url)==='/proxy'&&options.body) {
                const body=JSON.parse(options.body);
                window.batchRequests.push(body);
                return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:${JSON.stringify(images[0])}}}]}}]});
            }
            return nativeFetch(url,options);
        };`;
    try {
        await withAppBrowser({ nodes, connections: [], autoCheckUpdatesOnLoad: false, autoRetry: false,
            models: [{ id: 'gemini', modelId: 'gemini-3-pro-image-preview', name: 'MCP Image', taskType: 'image',
                protocol: 'google', providerIds: ['provider'] }],
            providers: [{ id: 'provider', name: 'MCP Provider', endpoint: 'https://controlled.test/v1', apikey: 'secret-for-test' }],
            workflowTabs: [{ name: 'MCP', workflowId, data: { workflowId, nodes, connections: [] } }],
            activeWorkflowName: 'MCP', activeWorkflowId: workflowId }, async app => {
            for (const [index, id] of sourceNodeIds.entries()) await uploadImageOriginal(app, id, `data:image/png;base64,${images[index]}`);
            const call = (method, args) => callCanvas(app.server, token, method, args);
            const inventory = await call('list_models');
            assert.equal(inventory.status, 200, inventory.error);
            assert.equal(inventory.result.models[0].id, 'gemini');
            assert.equal(inventory.result.models[0].providers[0].id, 'provider');
            assert.ok(inventory.result.models[0].providers[0].parameters.resolution.enum.includes('2K'));
            assert.doesNotMatch(JSON.stringify(inventory.result), /secret-for-test|controlled\.test/);

            const canvas = await call('read_canvas');
            assert.equal(canvas.status, 200, canvas.error);
            const { editorId, revision } = canvas.result;
            const prompt = 'Use a neutral background and keep the object.';
            const batch = await call('generate_image_batch', { editorId, workflowId, revision, sourceNodeIds,
                prompt, modelId: 'gemini', providerId: 'provider', parameters: { aspect: '16:9', resolution: '2K' }, run: true });
            assert.equal(batch.status, 200, batch.error);
            assert.equal(batch.result.nodeIds.length, 4);
            assert.ok(batch.result.run?.runId, batch.result.runError);

            const run = { editorId, workflowId, runId: batch.result.run.runId };
            let status;
            for (let attempt = 0; attempt < 50; attempt++) {
                status = await call('get_workflow_run', run);
                assert.equal(status.status, 200, status.error);
                if (status.result.status !== 'running') break;
                await delay(150);
            }
            assert.equal(status.result.status, 'completed');
            assert.deepEqual(new Set(status.result.nodeResults.map(node => node.nodeId)), new Set(batch.result.nodeIds));
            assert.ok(status.result.nodeResults.every(node => node.succeeded));
            const requests = await app.evaluate('window.batchRequests');
            assert.equal(requests.length, 2);
            assert.deepEqual(requests.map(request => {
                const parts = request.contents.at(-1).parts;
                assert.equal(parts.find(part => part.text)?.text, prompt);
                assert.deepEqual(request.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '2K' });
                const references = parts.filter(part => part.inlineData);
                assert.equal(references.length, 1);
                return references[0].inlineData.data;
            }).sort(), [...images].sort());

            await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
            await app.waitFor("document.querySelectorAll('#nodes-layer .node').length===3");
        }, { initScript });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});

test('MCP disconnects one existing image reference and preserves survivor order', { timeout: 60000 }, async () => {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    const workflowId = 'exact-reference-edit';
    const colors = ['red', 'blue', 'green'];
    const nodes = [
        ...colors.map((id, index) => ({ id, type: 'ImageImport', x: 100, y: 100 + index * 300 })),
        { id: 'prompt', type: 'Text', text: 'Keep the original colors', x: 100, y: 1000 },
        { id: 'generator', type: 'ImageGenerate', x: 520, y: 120 }
    ];
    const connections = [
        ...colors.map((nodeId, order) => ({
            id: `reference-${nodeId}`, order, type: 'image',
            from: { nodeId, port: 'image' }, to: { nodeId: 'generator', port: 'referenceImages' }
        })),
        { id: 'prompt-edge', from: { nodeId: 'prompt', port: 'text' },
            to: { nodeId: 'generator', port: 'prompt' }, type: 'text' }
    ];
    const data = { workflowId, nodes, connections };
    const fixture = { ...data, autoCheckUpdatesOnLoad: false, activeWorkflowName: 'Exact reference edits', activeWorkflowId: workflowId,
        workflowTabs: [{ name: 'Exact reference edits', workflowId, data }] };
    try {
        await withAppBrowser(fixture, async app => {
            for (const color of colors) {
                const image = await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url));
                await uploadImageOriginal(app, color, `data:image/png;base64,${image.toString('base64')}`);
            }
            const call = async (method, args) => {
                let reply;
                for (let attempt = 0; attempt < 20; attempt++) {
                    reply = await callCanvas(app.server, token, method, args);
                    if (reply.status !== 409 || /no longer current/i.test(reply.error || '')) break;
                    await delay(150);
                }
                assert.equal(reply.status, 200, reply.error);
                assert.equal(reply.error, undefined, reply.error);
                return reply.result;
            };
            const scope = ({ editorId, workflowId, revision }) => ({ editorId, workflowId, revision });
            const referenceOrder = canvas => canvas.connections
                .filter(link => link.to.nodeId === 'generator' && link.to.port === 'referenceImages')
                .sort((left, right) => left.order - right.order)
                .map(link => [link.id, link.from.nodeId, link.order]);
            const before = await call('read_canvas');
            assert.deepEqual(referenceOrder(before), colors.map((color, order) => [`reference-${color}`, color, order]));
            await call('edit_canvas', { ...scope(before), plan: { version: 1,
                steps: [{ id: 'edit-generator', type: 'ImageGenerate', nodeId: 'generator', execute: false }],
                disconnects: [{ ref: 'edit-generator', port: 'referenceImages', connectionId: 'reference-blue' }]
            } });
            const edited = await call('read_canvas');
            assert.deepEqual(referenceOrder(edited), [['reference-red', 'red', 0], ['reference-green', 'green', 2]]);
            assert.deepEqual(edited.connections.find(link => link.id === 'prompt-edge'), before.connections.find(link => link.id === 'prompt-edge'));
            assert.deepEqual(edited.nodes.map(node => node.id).sort(), before.nodes.map(node => node.id).sort());
            assert.equal((await call('undo_canvas', scope(edited))).changed, true);
            assert.deepEqual(referenceOrder(await call('read_canvas')), referenceOrder(before));
        });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
});
