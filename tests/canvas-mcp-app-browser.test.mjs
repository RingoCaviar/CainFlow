import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';

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
            const call = async (method, args = {}) => {
                const response = await fetch(`${server.baseUrl}/api/canvas-mcp/call`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ method, args })
                });
                return { status: response.status, ...await response.json() };
            };
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
