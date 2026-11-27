import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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
            window.fetch = (url, ...options) => {
                if (String(url).startsWith('/api/storage/file-imports/info?')) return Promise.resolve(Response.json({ kind: 'text', mime: 'text/plain', size: 18, version: 'v1' }));
                return String(url).startsWith('/api/storage/file-imports/text?')
                    ? Promise.resolve(Response.json({ text: '# 原文件\\n\\n- 一项' })) : fetchOriginal(url, ...options);
            };
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
            { id: 'chat', type: 'TextChat', x: 480, y: 100, apiConfigId: 'model', providerId: 'p', prompt: '' },
            { id: 'text-relay', type: 'Text', x: 480, y: 390 }
        ],
        connections: [
            { id: 'wire', from: { nodeId: 'file', port: 'text' }, to: { nodeId: 'chat', port: 'prompt' }, type: 'text' },
            { id: 'relay-wire', from: { nodeId: 'file', port: 'text' }, to: { nodeId: 'text-relay', port: 'text' }, type: 'text' }
        ]
    }, async app => {
        await app.waitFor("document.querySelector('#file [data-file-import-preview]')?.value === '预览内容'");
        await app.evaluate("window.sourceContent = '运行前写入的新文本'; void 0");
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor("window.sentFileContents.length > 0");
        assert.deepEqual(await app.evaluate('window.sentFileContents'), ['运行前写入的新文本']);
        await app.waitFor("document.querySelector('#text-relay textarea')?.value === '运行前写入的新文本'");
        const relaySnapshot = await app.evaluate(`(async () => {
            const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
            return (await bootstrapCainFlowApp()).workflowManagerApi.getActiveWorkflowSnapshot().nodes.find(node => node.id === 'text-relay');
        })()`);
        assert.doesNotMatch(JSON.stringify(relaySnapshot), /运行前写入的新文本/);
        await app.waitFor("document.getElementById('chat').textContent.includes('收到原文件') || document.querySelector('#chat textarea')?.value === '收到原文件'");
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden");
        await app.evaluate("window.sourceContent = '仅运行对话时读取'; void 0");
        await runNode(app, 'chat', true);
        await app.waitFor("window.sentFileContents.length > 1");
        assert.deepEqual(await app.evaluate('window.sentFileContents'), ['运行前写入的新文本', '仅运行对话时读取']);
        assert.deepEqual(await app.evaluate('window.privateFileRequests'), ['1', '1']);
        await app.waitFor("document.querySelector('#file [data-file-import-preview]').value === '仅运行对话时读取'");
        await app.evaluate('window.sourceMissing = true; void 0');
        await app.waitFor("document.querySelector('#file [data-file-import-status]').textContent.includes('找不到原文件')");
        await app.evaluate("window.sourceMissing = false; window.sourceContent = '原件恢复'; void 0");
        await app.waitFor("document.querySelector('#file [data-file-import-preview]').value === '原件恢复'");
    }, {
        initScript: `(() => {
            window.sourceContent = '预览内容';
            window.sentFileContents = [];
            window.privateFileRequests = [];
            const originalFetch = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (String(url).startsWith('/api/storage/file-imports/info?')) {
                    return Promise.resolve(window.sourceMissing
                        ? Response.json({ error: '找不到原文件。', code: 'missing' }, { status: 404 })
                        : Response.json({ kind: 'text', mime: 'text/plain', size: window.sourceContent.length, version: window.sourceContent }));
                }
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

test('mixed desktop drops keep successful originals in order and undo them together', { timeout: 45000 }, async () => {
    await withAppBrowser({ nodes: [], connections: [], autoCheckUpdatesOnLoad: false }, async app => {
        await app.evaluate(`(() => {
            document.querySelector('#canvas-navigation [data-zoom="1.5"]').click();
            const transfer = new DataTransfer();
            ['notes.txt', 'broken', 'cover.png', 'clip.mp4', 'brief.pdf'].forEach(name => transfer.items.add(new File(['fixture'], name)));
            document.getElementById('canvas-container').dispatchEvent(new DragEvent('drop', {
                dataTransfer: transfer, clientX: 160, clientY: 250, bubbles: true, cancelable: true
            }));
        })()`);
        await app.waitFor("document.querySelectorAll('.node-file-import').length === 4");
        await app.waitFor("document.querySelector('.toast-message')?.textContent.includes('broken：无法读取文件')");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.node-file-import [data-file-import-open]')].map(node => node.textContent)"),
            ['notes.txt', 'cover.png', 'clip.mp4', 'brief.pdf']);
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('.node-file-import [data-direction=output]')].map(node => node.dataset.port)"),
            ['text', 'image', 'video', 'file']);
        const positions = await app.evaluate(`(async () => {
            const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
            const { canvas, nodes } = (await bootstrapCainFlowApp()).workflowManagerApi.getActiveWorkflowSnapshot();
            const container = document.querySelector('#canvas-container'), rect = container.getBoundingClientRect();
            return { canvas, first: [nodes[0].x, nodes[0].y], expected: [(160 - rect.left - canvas.x + container.scrollLeft) / canvas.zoom, (250 - rect.top - canvas.y + container.scrollTop) / canvas.zoom],
                differences: nodes.slice(1).map((node, index) => node.x - nodes[index].x) };
        })()`);
        assert.equal(positions.canvas.zoom, 1.5);
        assert.ok(positions.canvas.x || positions.canvas.y);
        assert.ok(positions.first.every((value, index) => Math.abs(value - positions.expected[index]) < 0.01));
        assert.ok(positions.differences.every(offset => Math.abs(offset - 300) < 0.01));
        await app.evaluate("document.getElementById('canvas-container').focus()");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 250 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
        await app.waitFor("document.querySelectorAll('.node-file-import').length === 0");
    }, {
        initScript: `(() => {
            const events = new EventTarget();
            window.chrome.webview = {
                addEventListener: events.addEventListener.bind(events),
                postMessageWithAdditionalObjects(message, [file]) {
                    const parts = { txt: 'text', png: 'image', mp4: 'video', pdf: 'file' };
                    const kind = parts[file.name.split('.').at(-1)];
                    setTimeout(() => events.dispatchEvent(new MessageEvent('message', {
                        data: { type: 'cainflow-file-import-result', nodeId: message.nodeId,
                            ...(kind ? { fileImport: { id: kind.charCodeAt(0).toString(16).repeat(16), name: file.name, kind } } : { error: '无法读取文件' }) }
                    })), kind === 'text' ? 20 : 0);
                }
            };
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (url, ...options) => String(url).startsWith('/api/storage/file-imports/')
                ? Promise.resolve(Response.json({ error: 'fixture', code: 'missing' }, { status: 404 }))
                : nativeFetch(url, ...options);
        })()`
    });
});

test('a replacement warns before cutting incompatible connections and shares only locating hints', { timeout: 45000 }, async () => {
    const firstId = 'b'.repeat(32);
    const secondId = 'c'.repeat(32);
    const connection = { id: 'wire', from: { nodeId: 'file', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' };
    const sessionQuery = "fetch('/api/storage/documents/session').then(r => r.json()).then(r => r.value)";
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [
        { id: 'file', type: 'FileImport', x: 100, y: 100, fileImport: { id: firstId, name: 'notes.md', kind: 'text' } },
        { id: 'target', type: 'Text', x: 450, y: 100 }
    ], connections: [connection] }, async app => {
        await app.waitFor("document.querySelector('[data-file-import-preview]')?.value === 'source content'");
        await app.evaluate("document.querySelector('[data-file-import-open]').click()");
        assert.deepEqual((await app.evaluate('window.openedOriginal')).slice(1), ['file', firstId]);
        await app.evaluate("document.querySelector('[data-file-import-replace]').click()");
        await app.waitFor("document.querySelector('#app-action-dialog')?.textContent.includes('类型冲突')");
        assert.equal(await app.evaluate("document.querySelector('[data-conn-id=wire]')?.classList.contains('file-import-connection-warning')"), true);
        await app.evaluate("document.querySelector('#app-action-dialog button[data-dialog-style-1-action=cancel]').click()");
        await app.waitFor("document.querySelector('#app-action-dialog').classList.contains('hidden')");
        assert.equal(await app.evaluate("document.querySelector('#file [data-direction=output]').dataset.port"), 'text');
        await app.evaluate("document.querySelector('[data-file-import-replace]').click()");
        await app.waitFor("document.querySelector('#app-action-dialog button[data-dialog-style-1-action=confirm]')");
        await app.evaluate("document.querySelector('#app-action-dialog button[data-dialog-style-1-action=confirm]').click()");
        await app.waitFor(`(${sessionQuery}).then(doc => doc?.connections.length === 0 && doc.nodes[0].fileImport.kind === 'image')`);
        assert.equal(await app.evaluate("document.querySelector('#file [data-direction=output]').dataset.port"), 'image');
        await app.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true }))");
        await app.waitFor('window.exportedWorkflow?.nodes?.some(node => node.type === "FileImport")');
        const exported = await app.evaluate('window.exportedWorkflow.nodes.find(node => node.type === "FileImport").fileImport');
        assert.deepEqual(exported, { name: 'new.png', kind: 'image', mime: 'image/png', size: 32 });
        assert.doesNotMatch(JSON.stringify(exported), new RegExp(firstId + '|' + secondId + '|source content'));
        await app.evaluate("document.getElementById('canvas-container').focus()");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 250 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
        await app.waitFor(`(${sessionQuery}).then(doc => doc?.connections.length === 1 && doc.nodes[0].fileImport.id === '${firstId}')`);
    }, { initScript: `(() => {
        window.__cainflowDesktop = {
            openFileImport: (...args) => { window.openedOriginal = args; return true; },
            chooseFileImport: async () => ({ id: '${secondId}', name: 'new.png', kind: 'image', mime: 'image/png', size: 32 })
        };
        const createUrl = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { if (blob.type === 'application/json') void blob.text().then(text => window.exportedWorkflow = JSON.parse(text)); return createUrl(blob); };
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, ...options) => {
            if (String(url).startsWith('/api/storage/file-imports/info?')) {
                const image = String(url).includes('${secondId}');
                return Promise.resolve(Response.json({ kind: image ? 'image' : 'text', mime: image ? 'image/png' : 'text/plain', size: 32, version: 'v1' }));
            }
            if (String(url).startsWith('/api/storage/file-imports/text?')) return Promise.resolve(Response.json({ text: 'source content' }));
            return nativeFetch(url, ...options);
        };
    })()` });
});

test('a drop that finishes after switching workflows is saved only to the original canvas', { timeout: 45000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [], connections: [] }, async app => {
        const result = await app.evaluate(`(async () => {
            const { bootstrapCainFlowApp } = await import('/js/app/bootstrap.js');
            const manager = (await bootstrapCainFlowApp()).workflowManagerApi;
            const original = manager.getActiveWorkflow();
            const second = await manager.createEmptyWorkflow({ name: 'Second canvas' });
            await manager.openWorkflow(original.label);
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File(['test'], 'source.pdf', { type: 'application/pdf' }));
            dataTransfer.items.add(new File(['test'], 'appendix.pdf', { type: 'application/pdf' }));
            document.querySelector('#canvas-container').dispatchEvent(new DragEvent('drop', {
                dataTransfer, clientX: 250, clientY: 200, bubbles: true, cancelable: true
            }));
            const switching = manager.openWorkflow(second.name);
            const wasLoading = document.documentElement.dataset.canvasLoadState === 'loading';
            const scopeDuringSwitch = manager.getActiveWorkflow().workflowId;
            window.completeDrop();
            await switching;
            await new Promise(resolve => setTimeout(resolve, 0));
            const other = manager.getActiveWorkflowSnapshot();
            const saved = await manager.flushAutosave([original.workflowId]);
            const draft = await fetch('/api/workflows/' + encodeURIComponent(original.label)).then(response => response.json());
            await manager.openWorkflow(original.label);
            const restored = manager.getActiveWorkflowSnapshot();
            return { original, second, other, saved, draft, restored, sent: window.dropScope, wasLoading, scopeDuringSwitch };
        })()`);
        assert.equal(result.sent.workflowId, result.original.workflowId);
        assert.equal(result.wasLoading, true);
        assert.equal(result.scopeDuringSwitch, result.original.workflowId);
        assert.equal(result.other.workflowId, result.second.workflowId);
        assert.deepEqual(result.other.nodes, []);
        for (const data of [result.draft, result.restored]) {
            assert.deepEqual(data.nodes.map(node => node.type), ['FileImport', 'FileImport']);
            assert.deepEqual(data.nodes.map(node => node.fileImport.name), ['source.pdf', 'appendix.pdf']);
        }
        await app.evaluate("document.getElementById('canvas-container').focus()");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 250 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
        await app.waitFor("document.querySelectorAll('.node-file-import').length === 0");
    }, { initScript: `(() => {
        const events = new EventTarget();
        const pending = [];
        window.completeDrop = () => pending.splice(0).forEach(result => events.dispatchEvent(new MessageEvent('message', { data: result })));
        window.chrome.webview = {
            addEventListener: events.addEventListener.bind(events),
            postMessageWithAdditionalObjects(message, [file]) {
                window.dropScope = message;
                pending.push({ type: 'cainflow-file-import-result', nodeId: message.nodeId,
                    fileImport: { id: '${'d'.repeat(32)}', name: file.name, kind: 'file', mime: file.type, size: file.size } });
            }
        };
    })()` });
});

test('a shared file hint can bind to a local replacement and retain its compatible link', { timeout: 45000 }, async () => {
    const binding = 'e'.repeat(32);
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [
        { id: 'file', type: 'FileImport', x: 100, y: 100, fileImport: { name: 'old.md', kind: 'text' } },
        { id: 'target', type: 'Text', x: 450, y: 100 }
    ], connections: [{ id: 'wire', from: { nodeId: 'file', port: 'text' }, to: { nodeId: 'target', port: 'text' }, type: 'text' }] }, async app => {
        await app.waitFor("document.querySelector('[data-file-import-status]')?.textContent.includes('重新定位')");
        assert.ok(await app.evaluate("document.querySelector('[data-file-import-open]').disabled"));
        await app.evaluate("document.querySelector('[data-file-import-replace]').click()");
        await app.waitFor("document.querySelector('[data-file-import-preview]')?.value === '# local file'");
        assert.ok(await app.evaluate("document.querySelector('[data-conn-id=wire]')"));
        assert.equal(await app.evaluate("window.selectedNodeId"), 'file');
        await app.waitFor(`fetch('/api/storage/documents/session').then(r => r.json()).then(r => r.value.nodes[0].fileImport.id === '${binding}')`);
    }, { initScript: `(() => {
        window.__cainflowDesktop = { chooseFileImport: async (workflowId, nodeId) => {
            window.selectedNodeId = nodeId;
            return { id: '${binding}', name: 'local.md', kind: 'text' };
        } };
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, ...options) => {
            if (String(url).startsWith('/api/storage/file-imports/info?')) return Promise.resolve(Response.json({ kind: 'text', mime: 'text/plain', size: 12, version: 'new' }));
            if (String(url).startsWith('/api/storage/file-imports/text?')) return Promise.resolve(Response.json({ text: '# local file' }));
            return nativeFetch(url, ...options);
        };
    })()` });
});

test('original image and video reach existing downstream previews without saved media copies', { timeout: 45000 }, async () => {
    const imageId = 'b'.repeat(32), videoId = 'c'.repeat(32);
    const image = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [
        { id: 'file-image', type: 'FileImport', x: 100, y: 100, fileImport: { id: imageId, name: 'cover.png', kind: 'image' } },
        { id: 'file-video', type: 'FileImport', x: 100, y: 400, fileImport: { id: videoId, name: 'clip.webm', kind: 'video' } },
        { id: 'image-out', type: 'ImagePreview', x: 500, y: 100 },
        { id: 'video-out', type: 'ImageSave', x: 500, y: 400 }
    ], connections: [
        { id: 'image-wire', from: { nodeId: 'file-image', port: 'image' }, to: { nodeId: 'image-out', port: 'image' }, type: 'image' },
        { id: 'video-wire', from: { nodeId: 'file-video', port: 'video' }, to: { nodeId: 'video-out', port: 'video' }, type: 'video' }
    ] }, async app => {
        const video = await app.evaluate(`(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 32;
            const ctx = canvas.getContext('2d'), stream = canvas.captureStream(10);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const chunks = [];
            recorder.ondataavailable = event => chunks.push(event.data);
            const finished = new Promise(resolve => recorder.onstop = resolve);
            recorder.start();
            for (let i = 0; i < 5; ++i) {
                ctx.fillStyle = i % 2 ? 'blue' : 'red';
                ctx.fillRect(0, 0, 32, 32);
                await new Promise(resolve => setTimeout(resolve, 75));
            }
            recorder.stop();
            await finished;
            stream.getTracks().forEach(track => track.stop());
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
            });
        })()`);
        const unregister = app.onProtocolEvent(message => {
            if (message.method !== 'Fetch.requestPaused') return;
            const { requestId, request } = message.params;
            const isVideo = request.url.includes(videoId);
            void app.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
                responseHeaders: [{ name: 'Content-Type', value: isVideo ? 'video/webm' : 'image/png' }],
                body: isVideo ? video : image });
        });
        await app.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/storage/file-imports/content?*' }] });
        await app.evaluate('window.originalMediaAvailable = true');
        await app.waitFor("document.querySelector('#file-image [data-file-import-image]').naturalWidth > 0");
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor(`document.querySelector('#image-out img[src*="file-imports/content"]')?.naturalWidth > 0`);
        await app.waitFor(`document.querySelector('#video-out video[src*="file-imports/content"]')?.readyState > 0`);
        assert.equal(await app.evaluate("document.querySelector('#video-out video').videoWidth"), 32);
        await app.waitFor("document.getElementById('toolbar-workflow-run-status').hidden");
        assert.equal(await app.evaluate('window.originalMediaCopies'), 0);
        const saved = await app.evaluate("fetch('/api/storage/documents/session').then(r => r.json()).then(r => r.value)");
        assert.doesNotMatch(JSON.stringify(saved), /data:image|file-imports\/content/);
        await app.send('Fetch.disable', {});
        unregister();
    }, { initScript: `(() => {
        window.originalMediaCopies = 0;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options) => {
            if (String(url).startsWith('/api/storage/file-imports/info?')) {
                if (!window.originalMediaAvailable) return Promise.resolve(Response.json({ error: 'pending', code: 'missing' }, { status: 404 }));
                const video = String(url).includes('${videoId}');
                return Promise.resolve(Response.json({ kind: video ? 'video' : 'image', mime: video ? 'video/webm' : 'image/png', size: 32, version: 'v1' }));
            }
            if (String(url).startsWith('/api/storage/media-assets') && options?.method === 'PUT') window.originalMediaCopies++;
            return nativeFetch(url, options);
        };
    })()` });
});
