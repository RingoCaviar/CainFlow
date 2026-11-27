import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { runWorkflowShortcut } from './helpers/workflow-run-shortcut.mjs';
import { runNode } from './helpers/image-first-integrated-fixture.mjs';

test('a desktop Markdown drop creates a read-only source and saves only its reference', { timeout: 45000 }, async () => {
    await withAppBrowser({ nodes: [], connections: [], autoCheckUpdatesOnLoad: false }, async app => {
        await app.evaluate(`(() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(['unused transfer body'], '需求.md', { type: 'text/markdown' }));
            document.getElementById('canvas-container').dispatchEvent(new DragEvent('drop', {
                dataTransfer: transfer, clientX: 200, clientY: 250, bubbles: true, cancelable: true
            }));
        })()`);
        await app.waitFor(`document.querySelector('[data-file-import-preview]')?.value === '# 原文件\\n\\n- 一项'`);
        const drop = await app.evaluate('window.fileDrop');
        assert.ok(drop.workflowId);
        assert.equal(await app.evaluate('document.querySelector("[data-file-import-preview]").readOnly'), true);
        assert.equal(await app.evaluate('document.querySelector("[data-file-import-open]").textContent'), '需求.md');
        assert.equal(await app.evaluate(`document.querySelector('#${drop.nodeId} [data-port=text]')?.dataset.direction`), 'output');
        await app.waitFor(`fetch('/api/storage/documents/session').then(response => response.json())
            .then(document => document.value?.nodes.some(node => node.type === 'FileImport' && node.fileImport?.id === '${'a'.repeat(32)}'))`);
        const stored = await app.evaluate(`fetch('/api/storage/documents/session').then(response => response.json())
            .then(document => document.value.nodes.find(node => node.type === 'FileImport'))`);
        assert.deepEqual(stored.fileImport, { id: 'a'.repeat(32), name: '需求.md' });
        assert.doesNotMatch(JSON.stringify(stored), /原文件|unused transfer body/);
    }, {
        initScript: `(() => {
            const events = new EventTarget();
            window.chrome.webview = {
                addEventListener: events.addEventListener.bind(events),
                postMessageWithAdditionalObjects(message, files) {
                    window.fileDrop = message;
                    queueMicrotask(() => events.dispatchEvent(new MessageEvent('message', {
                        data: { type: 'cainflow-file-import-result', nodeId: message.nodeId,
                            fileImport: { id: '${'a'.repeat(32)}', name: files[0].name } }
                    })));
                }
            };
            const fetchOriginal = window.fetch.bind(window);
            window.fetch = (url, ...options) => String(url).startsWith('/api/storage/file-imports/text?')
                ? Promise.resolve(Response.json({ text: '# 原文件\\n\\n- 一项' })) : fetchOriginal(url, ...options);
        })()`
    });
});

test('a restored text file sends original content to a live conversation', { timeout: 45000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'model', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [
            { id: 'file', type: 'FileImport', x: 100, y: 100, fileImport: { id: 'b'.repeat(32), name: '输入.txt' } },
            { id: 'chat', type: 'TextChat', x: 480, y: 100, apiConfigId: 'model', providerId: 'p', prompt: '' }
        ],
        connections: [{ id: 'wire', from: { nodeId: 'file', port: 'text' }, to: { nodeId: 'chat', port: 'prompt' }, type: 'text' }]
    }, async app => {
        await app.waitFor("document.querySelector('#file [data-file-import-preview]')?.value === '预览内容'");
        await app.evaluate("window.sourceContent = '运行前写入的新文本'; void 0");
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor("window.sentFileContents.length > 0");
        assert.deepEqual(await app.evaluate('window.sentFileContents'), ['运行前写入的新文本']);
        await app.waitFor("document.getElementById('chat').textContent.includes('收到原文件') || document.querySelector('#chat textarea')?.value === '收到原文件'");
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden");
        await app.evaluate("window.sourceContent = '仅运行对话时读取'; void 0");
        await runNode(app, 'chat', true);
        await app.waitFor("window.sentFileContents.length > 1");
        assert.deepEqual(await app.evaluate('window.sentFileContents'), ['运行前写入的新文本', '仅运行对话时读取']);
        assert.deepEqual(await app.evaluate('window.privateFileRequests'), ['1', '1']);
    }, {
        initScript: `(() => {
            window.sourceContent = '预览内容';
            window.sentFileContents = [];
            window.privateFileRequests = [];
            const originalFetch = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (String(url).startsWith('/api/storage/file-imports/text?')) {
                    return Promise.resolve(Response.json({ text: window.sourceContent }));
                }
                if (url === '/proxy') {
                    const { messages } = JSON.parse(options.body);
                    window.sentFileContents.push(messages.findLast(message => message.role === 'user')?.content);
                    window.privateFileRequests.push(new Headers(options.headers).get('X-Cainflow-Private-Input'));
                    return Promise.resolve(Response.json({ choices: [{ message: { content: '收到原文件' } }] }));
                }
                return originalFetch(url, options);
            };
        })()`
    });
});
