import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

function restoredWorkflow(name, data, settings = {}) {
    return {
        ...data, autoCheckUpdatesOnLoad: false, ...settings,
        activeWorkflowName: name, activeWorkflowId: data.workflowId,
        workflowTabs: [{ name, workflowId: data.workflowId, data }]
    };
}

async function withMcpBrowser(session, task) {
    const token = randomBytes(32).toString('hex');
    const previousToken = process.env.CAINFLOW_MCP_TOKEN;
    process.env.CAINFLOW_MCP_TOKEN = token;
    try {
        await withAppBrowser(session, async app => {
            const request = async (method, args = {}) => {
                const response = await fetch(app.server.baseUrl + '/api/canvas-mcp/call', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ method, args })
                });
                return { status: response.status, ...await response.json() };
            };
            const call = async (method, args = {}) => {
                const reply = await request(method, args);
                assert.equal(reply.status, 200, reply.error);
                assert.equal(reply.error, undefined, reply.error);
                return reply.result;
            };
            await task(app, call, request);
        });
    } finally {
        if (previousToken === undefined) delete process.env.CAINFLOW_MCP_TOKEN;
        else process.env.CAINFLOW_MCP_TOKEN = previousToken;
    }
}

const scope = ({ workflowId, revision }) => ({ workflowId, revision });

async function seedSavedWorkflow(server, name, document) {
    const response = await fetch(server.baseUrl + '/api/workflows/' + encodeURIComponent(name), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document)
    });
    assert.equal(response.status, 200);
}

async function sendLocalAgentCommand(app, text) {
    await app.evaluate(`(() => {
        if (!document.getElementById('prompt-agent-panel').classList.contains('active')) document.getElementById('btn-prompt-agent').click();
        const input = document.getElementById('prompt-agent-input');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal(await app.evaluate("document.getElementById('prompt-agent-send').disabled"), false);
    await app.evaluate("document.getElementById('prompt-agent-send').click()");
}

test('a clean editor restores newer MCP changes and cannot overwrite the next saved version with a stale draft', { timeout: 45000 }, async () => {
    const name = 'Shared saved workflow';
    const document = {
        workflowId: 'headless-shared', mediaOwnershipRevision: 1,
        nodes: [{ id: 'note', type: 'Text', text: 'Before MCP', x: 100, y: 120 }], connections: []
    };
    await withMcpBrowser(restoredWorkflow(name, document), async (app, call, request) => {
        const read = () => call('read_canvas', { workflowId: document.workflowId });
        const change = (canvas, text) => call('edit_canvas', { ...scope(canvas), plan: { version: 1, steps: [
            { id: 'note-edit', type: 'Text', nodeId: 'note', execute: false, parameters: { text } }
        ] } });
        const visibleText = () => app.evaluate("document.getElementById('note-text').value");
        await seedSavedWorkflow(app.server, name, document);
        const before = await read();
        assert.equal(before.nodes[0].parameters.text, 'Before MCP');
        const edited = await change(before, 'MCP saved A');
        assert.notEqual(edited.revision, before.revision);
        assert.equal((await read()).nodes[0].parameters.text, 'MCP saved A');
        const stale = await request('edit_canvas', { ...scope(before), plan: { version: 1, steps: [
            { id: 'note-edit', type: 'Text', nodeId: 'note', execute: false, parameters: { text: 'Stale MCP edit' } }
        ] } });
        assert.equal(stale.status, 409);
        assert.equal(stale.errorCode, 'stale_revision');
        assert.equal(await visibleText(), 'Before MCP', 'writing the saved workflow does not mutate the open editor');

        await reloadAppBrowser(app);
        assert.equal(await visibleText(), 'MCP saved A', 'the previously clean recovery tab reads the current saved graph');

        const latest = await change(await read(), 'MCP saved B');
        await app.evaluate(`(() => {
            const input = document.getElementById('note-text');
            input.value = 'Local draft after MCP saved B';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await app.waitFor("[...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('自动保存失败') && toast.textContent.includes('修改已保留'))");
        assert.equal(await visibleText(), 'Local draft after MCP saved B');
        const after = await read();
        assert.equal(after.nodes[0].parameters.text, 'MCP saved B');
        assert.equal(after.revision, latest.revision, 'the normal stale editor retry cannot publish its draft over MCP');
        await app.waitFor(`fetch('/api/storage/documents/session').then(r => r.json()).then(({ value }) =>
            value?.workflowTabs?.some(tab => tab.workflowId === 'headless-shared'
                && tab.dirty && tab.data.nodes.some(node => node.id === 'note' && node.text === 'Local draft after MCP saved B')))`);
    });
});

test('Agent and saved-workflow MCP import history originals and apply the correct saved prompt fields', { timeout: 60000 }, async () => {
    const name = 'History preset';
    const document = {
        workflowId: 'scoped-history-preset', mediaOwnershipRevision: 1,
        nodes: [
            { id: 'prompt-text', type: 'Text', text: 'Before preset', x: 40, y: 80 },
            { id: 'hero', type: 'ImageGenerate', customTitle: '主图', prompt: 'Local fallback',
                apiConfigId: 'gpt', providerId: 'provider', x: 400, y: 80 }
        ],
        connections: [{ id: 'keep-prompt-edge', from: { nodeId: 'prompt-text', port: 'text' },
            to: { nodeId: 'hero', port: 'prompt' }, type: 'text' }]
    };
    await withMcpBrowser(restoredWorkflow(name, document, {
        models: [{ id: 'gpt', modelId: 'gpt-image-1', name: 'Image', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', name: 'Test', endpoint: 'https://controlled.test/v1', apikey: 'test' }]
    }), async (app, call) => {
        const read = () => call('read_canvas', { workflowId: document.workflowId });
        await seedSavedWorkflow(app.server, name, document);
        const { fileId, original } = await app.evaluate(`(async () => {
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            const original = document.createElement('canvas').toDataURL();
            const saved = await createDiskStorageApi(() => ({})).saveHistoryEntry({ image: original });
            return { fileId: saved.fileId, original };
        })()`);
        const { items: [history] } = await call('list_history', { id: fileId });
        const before = await read();
        const imported = await call('import_history', { ...scope(before), items: [{ id: history.id, fileVersion: history.fileVersion }] });
        const importedNode = imported.imported[0].nodeId;
        assert.ok((await read()).nodes.some(node => node.id === importedNode && node.assets.length === 1));
        assert.equal((await call('undo_canvas', scope(imported))).changed, true);
        const undone = await read();
        assert.ok(!undone.nodes.some(node => node.id === importedNode));
        assert.equal((await call('redo_canvas', scope(undone))).changed, true);

        await reloadAppBrowser(app);
        const restoredPixels = await app.evaluate(`(async () => {
            const app = await import('/js/app/bootstrap.js').then(m => m.bootstrapCainFlowApp());
            const node = app.state.nodes.get(${JSON.stringify(importedNode)});
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            return createDiskStorageApi(() => ({})).getImageAsset(node.data.imageImportAssetKey);
        })()`);
        assert.equal(restoredPixels, original);

        await sendLocalAgentCommand(app, `把历史图片 ID ${history.id} 导入当前画布`);
        await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已导入 1 张历史原图')");
        const twoImports = await read();
        assert.equal(twoImports.nodes.filter(node => node.type === 'ImageImport').length, 2);

        const preset = await call('save_prompt', { name: '白底规则', content: '保留标签，使用白底' });
        await sendLocalAgentCommand(app, '把库里的「白底规则」套用到「主图」的普通提示词');
        await app.waitFor("!!document.querySelector('.prompt-agent-canvas-plan')");
        assert.equal(await app.evaluate("document.getElementById('prompt-text-text').value"), 'Before preset');
        await app.evaluate("[...document.querySelectorAll('.prompt-agent-canvas-plan button')].find(button=>button.textContent==='仅应用').click()");
        await app.waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
        const afterOrdinary = await read();
        assert.equal(afterOrdinary.nodes.find(node => node.id === 'prompt-text').parameters.text, preset.content);
        assert.equal(afterOrdinary.nodes.find(node => node.id === 'hero').parameters.prompt, 'Local fallback');
        assert.deepEqual(afterOrdinary.connections, twoImports.connections);

        const applied = await call('apply_prompt', { ...scope(afterOrdinary), nodeId: 'hero', promptId: preset.id, target: 'system' });
        assert.equal(applied.appliedNodeId, 'hero');
        assert.equal((await read()).nodes.find(node => node.id === 'hero').parameters.protocolParams.systemPrompt, preset.content);
    });
});

test('Agent and saved-workflow MCP share workflow files, history notes and prompt presets without a model', { timeout: 45000 }, async () => {
    const name = 'Original';
    const document = { workflowId: 'app-actions-original', mediaOwnershipRevision: 1, connections: [],
        nodes: [{ id: 'keep-me', type: 'Text', text: 'Existing content', x: 40, y: 50 }] };
    await withMcpBrowser(restoredWorkflow(name, document, { models: [], providers: [] }), async (app, call) => {
        await seedSavedWorkflow(app.server, name, document);
        const fileId = await app.evaluate(`(async () => {
            const { createDiskStorageApi } = await import('/js/services/storage-disk.js');
            const image = document.createElement('canvas').toDataURL();
            return (await createDiskStorageApi(() => ({})).saveHistoryEntry({ image, prompt: 'Image prompt' })).fileId;
        })()`);
        const { items: [image] } = await call('list_history', { id: fileId });
        assert.ok(image.fileVersion);
        assert.equal(image.prompt, 'Image prompt');
        assert.ok(!Object.hasOwn(image, 'fileUrl') && !Object.hasOwn(image, 'relativePath'));
        await sendLocalAgentCommand(app, '给最新一张历史图片加备注：正面样片');
        await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已保存历史图片备注')");
        assert.equal((await call('list_history', { id: image.id })).items[0].note, '正面样片');
        await call('annotate_history', { id: image.id, fileVersion: image.fileVersion, note: '由 MCP 更新' });

        await sendLocalAgentCommand(app, '保存提示词『白底规则』：保留包装文字');
        await app.waitFor("document.getElementById('prompt-agent-messages').textContent.includes('已保存到提示词库')");
        const saved = (await call('list_prompts', { query: '白底规则' })).prompts[0];
        assert.equal(saved.content, '保留包装文字');
        const updated = await call('save_prompt', { name: '白底规则', content: '保留标签并使用柔光' });
        assert.equal(updated.id, saved.id);

        const blank = await call('create_workflow', { name: 'MCP blank' });
        const newCanvas = await call('read_canvas', { workflowId: blank.workflowId });
        assert.equal(newCanvas.totalNodes, 0);
        assert.equal(newCanvas.totalConnections, 0);
        assert.equal(await app.evaluate("document.getElementById('keep-me-text').value"), 'Existing content');
        await sendLocalAgentCommand(app, '新建空白工作流，命名为『Agent blank』');
        await app.waitFor("document.body.textContent.includes('已新建空白工作流「Agent blank」')");
        const agentBlank = (await call('list_workflows')).items.find(item => item.name === 'Agent blank');
        assert.ok(agentBlank && agentBlank.workflowId !== blank.workflowId);
        assert.equal((await call('read_canvas', { workflowId: agentBlank.workflowId })).totalNodes, 0);
        assert.equal((await call('list_prompts', { query: '白底规则' })).prompts[0].content, '保留标签并使用柔光');
        assert.equal((await call('list_history', { id: image.id })).items[0].note, '由 MCP 更新');
    });
});

test('MCP disconnects one saved image reference after browser upload and preserves survivor order', { timeout: 45000 }, async () => {
    const name = 'Exact reference edits';
    const colors = ['red', 'blue', 'green'];
    const document = {
        workflowId: 'exact-reference-edit', mediaOwnershipRevision: 1,
        nodes: [
            ...colors.map((id, index) => ({ id, type: 'ImageImport', x: 100, y: 100 + index * 300 })),
            { id: 'prompt', type: 'Text', text: 'Keep the original colors', x: 100, y: 1000 },
            { id: 'generator', type: 'ImageGenerate', x: 520, y: 120 }
        ],
        connections: [
            ...colors.map((nodeId, order) => ({
                id: `reference-${nodeId}`, order, type: 'image',
                from: { nodeId, port: 'image' }, to: { nodeId: 'generator', port: 'referenceImages' }
            })),
            { id: 'prompt-edge', from: { nodeId: 'prompt', port: 'text' },
                to: { nodeId: 'generator', port: 'prompt' }, type: 'text' }
        ]
    };
    await withMcpBrowser(restoredWorkflow(name, document), async (app, call) => {
        const read = () => call('read_canvas', { workflowId: document.workflowId });
        await seedSavedWorkflow(app.server, name, document);
        for (const color of colors) {
            const image = await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url));
            await uploadImageOriginal(app, color, `data:image/png;base64,${image.toString('base64')}`);
        }
        const referenceOrder = canvas => canvas.connections
            .filter(link => link.to.nodeId === 'generator' && link.to.port === 'referenceImages')
            .sort((left, right) => left.order - right.order)
            .map(link => [link.id, link.from.nodeId, link.order]);
        const before = await read();
        assert.deepEqual(referenceOrder(before), colors.map((color, order) => [`reference-${color}`, color, order]));
        await call('edit_canvas', { ...scope(before), plan: { version: 1,
            steps: [{ id: 'edit-generator', type: 'ImageGenerate', nodeId: 'generator', execute: false }],
            disconnects: [{ ref: 'edit-generator', port: 'referenceImages', connectionId: 'reference-blue' }]
        } });
        const edited = await read();
        assert.deepEqual(referenceOrder(edited), [['reference-red', 'red', 0], ['reference-green', 'green', 2]]);
        assert.deepEqual(edited.connections.find(link => link.id === 'prompt-edge'), before.connections.find(link => link.id === 'prompt-edge'));
        assert.deepEqual(edited.nodes.map(node => node.id).sort(), before.nodes.map(node => node.id).sort());
        assert.equal((await call('undo_canvas', scope(edited))).changed, true);
        assert.deepEqual(referenceOrder(await read()), referenceOrder(before));
    });
});
