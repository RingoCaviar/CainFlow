import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { executeSavedWorkflow, planSavedWorkflowExecution } from '../js/features/canvas-mcp/saved-canvas-execution.js';
import { createCanvasImageSourceId } from '../js/features/media/reference-image-identity.js';
import '../js/features/execution/protocols/openai.js';
import '../js/features/execution/protocols/newapi-image-async.js';
import '../js/features/execution/protocols/api6789-seedance.js';

const document = (nodes, connections = []) => ({ workflowId: 'saved-workflow', nodes, connections });
const wire = (source, from, target, to, type = 'text', order = 0) => ({
    id: `${source}:${from}:${target}:${to}`, from: { nodeId: source, port: from }, to: { nodeId: target, port: to }, type, order
});

test('saved workflow runs the target dependency graph and projects selected-only text inputs from storage', async () => {
    const saved = document([
        { id: 'source', type: 'Text', text: 'first\nsecond' },
        { id: 'parts', type: 'TextSplit', delimiter: '\\n', outputCount: 2 },
        { id: 'destination', type: 'Text' },
        { id: 'disabled', type: 'Text', data: { enabled: false, text: 'disabled' } },
        { id: 'other', type: 'UnknownNode' }
    ], [wire('source', 'text', 'parts', 'text'), wire('parts', 'part_2', 'destination', 'text'),
        wire('disabled', 'text', 'destination', 'text')]);

    const { enabledNodeIds } = planSavedWorkflowExecution({ document: saved, targetNodeId: 'destination' });
    assert.deepEqual(enabledNodeIds, ['source', 'parts', 'destination']);
    const run = await executeSavedWorkflow({ document: saved, targetNodeId: 'destination' });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    assert.deepEqual(run.nodeResults.map(result => result.nodeId), enabledNodeIds);
    assert.deepEqual(run.nodeResults.at(-1).texts, ['second']);
    assert.equal(run.document.nodes[2].text, 'second');
    assert.equal(saved.nodes[2].text, undefined);

    const selection = { document: run.document, nodeIds: ['destination', 'disabled'] };
    assert.deepEqual(planSavedWorkflowExecution(selection).enabledNodeIds, ['destination']);
    const selected = await executeSavedWorkflow(selection);
    assert.deepEqual(selected.nodeResults.map(result => [result.nodeId, result.texts]), [['destination', ['second']]]);

    const selectedSplit = await executeSavedWorkflow({ document: run.document, nodeIds: ['parts'] });
    assert.deepEqual(selectedSplit.nodeResults.map(result => [result.nodeId, result.texts]), [['parts', ['first', 'second']]]);
});

test('saved image generation uses every cached reference in order and publishes real originals without an editor', async () => {
    const red = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const blue = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const firstReference = wire('blue', 'image', 'generate', 'referenceImages', 'image', 0);
    const saved = document([
        { id: 'red', type: 'ImageImport', mediaAssetKeys: ['media:red'] },
        { id: 'blue', type: 'ImageImport', mediaAssetKeys: ['media:blue'] },
        { id: 'generate', type: 'ImageGenerate', apiConfigId: 'model', providerId: 'provider', prompt: 'adjust @图片1',
            imagePromptMentions: [{ token: '@图片1', source: { id: 'blue-reference', connectionId: firstReference.id,
                sourceNodeId: 'blue', sourcePort: 'image', targetPort: 'referenceImages', sourceImageIndex: 0 } }] },
        { id: 'preview', type: 'ImagePreview' }
    ], [wire('red', 'image', 'generate', 'referenceImages', 'image', 1),
        firstReference, wire('generate', 'image', 'preview', 'image', 'image')]);
    const stored = [];
    const run = await executeSavedWorkflow({ document: saved, nodeIds: ['generate', 'preview'],
        models: [{ id: 'model', modelId: 'gpt-image-1', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        loadMedia: async assetKey => ({ 'media:red': red, 'media:blue': blue })[assetKey],
        saveMedia: async (dataUrl, nodeId) => { stored.push([nodeId, dataUrl]); return 'media:result'; },
        async requestProvider({ url, method, headers, body }) {
            assert.equal(url, 'https://controlled.test/v1/images/edits');
            assert.equal(method, 'POST');
            assert.equal(headers.Authorization, 'Bearer test');
            assert.equal(body.get('prompt'), 'adjust 参考图 1');
            const bytes = await Promise.all(body.getAll('image[]').map(async file => Buffer.from(await file.arrayBuffer()).toString('base64')));
            assert.deepEqual(bytes, [blue.split(',')[1], red.split(',')[1]]);
            return Response.json({ data: [{ b64_json: red.split(',')[1] }] });
        }
    });

    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults.map(result => result.failureCategory)));
    assert.deepEqual(run.nodeResults.map(result => result.nodeId), ['generate', 'preview']);
    assert.deepEqual(stored, [['generate', red], ['preview', red]]);
    assert.deepEqual(run.document.nodes[2].mediaAssetKeys, ['media:result']);
    assert.deepEqual(run.nodeResults.at(-1).images, [red]);
});

test('saved GPT Image 2.6 workflows publish GIF and SVG using the shared request and result types', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5"/></svg>').toString('base64');
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const formats = [
        { format: 'gif', mime: 'image/gif', value: gif, fields: { frame_count: 10, frame_duration_ms: 180 } },
        { format: 'svg', mime: 'image/svg+xml', value: svg, fields: {} }
    ];
    const model = { id: 'model', modelId: 'gpt-image-2.6-flare', taskType: 'image',
        protocol: 'openai', providerIds: ['provider'] };
    for (const { format, mime, value, fields } of formats) {
        const dataUrl = `data:${mime};base64,${value}`;
        const saved = document([{ id: 'image', type: 'ImageGenerate', apiConfigId: model.id,
            providerId: 'provider', prompt: 'A circle', protocolParams: { output_format: format, ...fields } }]);
        const run = await executeSavedWorkflow({ document: saved, models: [model],
            providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
            async requestProvider({ url, body }) {
                assert.equal(url, 'https://controlled.test/v1/images/generations');
                const request = JSON.parse(body);
                assert.equal(request.n, 1);
                assert.equal(request.output_format, format);
                assert.equal(request.frame_count, fields.frame_count);
                assert.equal(request.frame_duration_ms, fields.frame_duration_ms);
                return Response.json({ data: [{ b64_json: value }] });
            },
            async saveMedia(result) {
                assert.equal(result, dataUrl);
                return `media:${format}`;
            }
        });
        assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
        assert.deepEqual(run.nodeResults[0].images, [dataUrl]);
        assert.deepEqual(run.document.nodes[0].mediaAssetKeys, [`media:${format}`]);
    }
});

test('saved GPT Image edits upload the connected markup separately from the first reference', async () => {
    const reference = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGNYuOnw/4uPPv8HABxLBrvCHrUpAAAAAElFTkSuQmCC';
    const markup = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNYuOkww38Ghv8AE3wEFcq2QBIAAAAASUVORK5CYII=';
    const saved = document([
        { id: 'photo', type: 'ImageImport', mediaAssetKeys: ['media:photo'] },
        { id: 'annotation', type: 'ImageImport', mediaAssetKeys: ['media:annotation'] },
        { id: 'edit', type: 'ImageGenerate', apiConfigId: 'model', providerId: 'provider',
            prompt: 'Apply the annotated change', protocolParams: { edit_guide: 'markup' } }
    ], [wire('photo', 'image', 'edit', 'referenceImages', 'image'),
        wire('annotation', 'image', 'edit', 'mask', 'image')]);
    const run = await executeSavedWorkflow({
        document: saved, nodeIds: ['edit'],
        models: [{ id: 'model', modelId: 'gpt-image-2.6-sunburst', taskType: 'image', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        loadMedia: async key => `data:image/png;base64,${key === 'media:photo' ? reference : markup}`,
        async requestProvider({ url, body }) {
            assert.equal(url, 'https://controlled.test/v1/images/edits');
            assert.equal(body.has('mask'), false);
            assert.equal(Buffer.from(await body.get('image').arrayBuffer()).toString('base64'), reference);
            assert.equal(Buffer.from(await body.get('markup').arrayBuffer()).toString('base64'), markup);
            return Response.json({ data: [{ b64_json: reference }] });
        },
        saveMedia: async () => 'media:edit'
    });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    assert.deepEqual(run.document.nodes.at(-1).mediaAssetKeys, ['media:edit']);
});

test('a stopped saved-workflow branch does not run dependents or prevent an independent branch', async () => {
    const saved = document([
        { id: 'stop', type: 'Text', text: 'A' }, { id: 'next', type: 'Text' }, { id: 'other', type: 'Text', text: 'B' }
    ], [wire('stop', 'text', 'next', 'text')]);
    const run = await executeSavedWorkflow({ document: saved, imageBatch: true,
        getNodeSignal: id => id === 'stop' ? AbortSignal.abort() : undefined });
    assert.equal(run.outcome, 'cancelled');
    assert.deepEqual(run.nodeResults.map(result => [result.nodeId, result.failureCategory || result.texts]), [
        ['stop', 'cancelled'], ['next', 'cancelled'], ['other', ['B']]
    ]);
});

test('saved image comparison keeps its B output asset and reads A through its source connection', async () => {
    const a = 'data:image/png;base64,AAAA';
    const b = 'data:image/png;base64,BBBB';
    const saved = document([
        { id: 'a', type: 'ImageImport', mediaAssetKeys: ['media:a'] },
        { id: 'b', type: 'ImageImport', mediaAssetKeys: ['media:b'] },
        { id: 'compare', type: 'ImageCompare', data: { compareImageA: a } }
    ], [wire('a', 'image', 'compare', 'imageA', 'image'), wire('b', 'image', 'compare', 'imageB', 'image')]);
    const staged = [];
    const run = await executeSavedWorkflow({ document: saved, targetNodeId: 'compare',
        loadMedia: async key => ({ 'media:a': a, 'media:b': b })[key],
        saveMedia: async (value, id) => { staged.push([id, value]); return 'media:compare'; }
    });
    assert.equal(run.outcome, 'completed');
    assert.deepEqual(staged, [['compare', b]]);
    assert.deepEqual(run.document.nodes.at(-1).mediaAssetKeys, ['media:compare']);
    assert.equal(JSON.stringify(run.document).includes(a), false);
});

test('saved NewAPI image generation submits, polls, and stores the returned original', async () => {
    const original = await readFile(new URL('./fixtures/reference-blue.png', import.meta.url));
    const dataUrl = `data:image/png;base64,${original.toString('base64')}`;
    const model = { id: 'newapi', modelId: 'async-image', taskType: 'image', protocol: 'newapi-image-async', providerIds: ['provider'] };
    const saved = document([{ id: 'image', type: 'ImageGenerate', apiConfigId: model.id, providerId: 'provider', prompt: 'A blue image' }]);
    const calls = [];
    const run = await executeSavedWorkflow({ document: saved, models: [model],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        async requestProvider({ method, url }) {
            calls.push([method, url]);
            if (method === 'POST') return Response.json({ id: 'task-id' });
            if (url.endsWith('/task-id')) return Response.json({ status: 'succeeded', image_url: 'https://controlled.test/result.png' });
            return new Response(original, { headers: { 'Content-Type': 'image/png' } });
        },
        async saveMedia(value, nodeId) {
            assert.equal(nodeId, 'image');
            assert.equal(value, dataUrl);
            return 'media:newapi';
        }
    });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults.map(result => result.failureCategory)));
    assert.deepEqual(calls, [
        ['POST', 'https://controlled.test/v1/videos'], ['GET', 'https://controlled.test/v1/videos/task-id'], ['GET', 'https://controlled.test/result.png']
    ]);
    assert.deepEqual(run.nodeResults[0].images, [dataUrl]);
});

test('saved conversation exposes plain reply text and encodes the restored editor representation', async () => {
    const node = { id: 'chat', type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider', prompt: 'Reply in plain text' };
    const run = await executeSavedWorkflow({ document: document([node]),
        models: [{ id: 'chat-model', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        async requestProvider({ url, body }) {
            assert.equal(url, 'https://controlled.test/v1/chat/completions');
            assert.equal(JSON.parse(body).messages[0].content, 'Reply in plain text');
            return Response.json({ choices: [{ message: { content: '<b>Literal reply</b>\nNext line' } }] });
        }
    });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults.map(result => result.failureCategory)));
    assert.deepEqual(run.nodeResults[0].texts, ['<b>Literal reply</b>\nNext line']);
    assert.equal(run.document.nodes[0].lastResponse, '&lt;b&gt;Literal reply&lt;/b&gt;<br>Next line');
});

test('a saved workflow reads an original Markdown file into the conversation prompt', async () => {
    const saved = document([
        { id: 'file', type: 'FileImport', fileImport: { id: 'd'.repeat(32), name: 'notes.md' } },
        { id: 'relay', type: 'Text', text: 'Keep this authored text' },
        { id: 'chat', type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider', prompt: 'fallback' }
    ], [wire('file', 'text', 'relay', 'text'), wire('relay', 'text', 'chat', 'prompt')]);
    let calls = 0;
    const run = await executeSavedWorkflow({ document: saved,
        models: [{ id: 'chat-model', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        async loadFileText(nodeId, referenceId) {
            assert.equal(nodeId, 'file');
            assert.equal(referenceId, 'd'.repeat(32));
            return '# File input\n\n- 需求';
        },
        async requestProvider({ body }) {
            calls++;
            assert.equal(JSON.parse(body).messages[0].content, '# File input\n\n- 需求');
            return Response.json({ choices: [{ message: { content: 'Read the file' } }] });
        }
    });
    assert.equal(calls, 1);
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    assert.equal(run.document.nodes[0].text, undefined);
    assert.equal(run.document.nodes[1].text, 'Keep this authored text');
    assert.deepEqual(run.nodeResults.find(node => node.nodeId === 'file').texts, []);
});

test('saved conversations use connected custom parameter values when running the graph or just the conversation', async () => {
    const saved = document([
        { id: 'temperature', type: 'Text', text: '0.25' },
        { id: 'params', type: 'CustomParams', params: [
            { key: 'temperature', value: '1' }, { key: 'metadata', value: '{"source":"cainflow"}' }
        ] },
        { id: 'chat', type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider', prompt: 'Reply in plain text' }
    ], [wire('temperature', 'text', 'params', 'param_temperature'), wire('params', 'params', 'chat', 'params', 'params')]);

    const requests = [];
    for (const nodeIds of [undefined, ['chat']]) {
        const run = await executeSavedWorkflow({ document: saved, nodeIds,
            models: [{ id: 'chat-model', modelId: 'configured-chat', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
            providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
            async requestProvider({ body }) {
                requests.push(JSON.parse(body));
                return Response.json({ choices: [{ message: { content: 'ok' } }] });
            }
        });
        assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    }
    assert.deepEqual(requests.map(({ temperature, metadata }) => ({ temperature, metadata })), [
        { temperature: 0.25, metadata: { source: 'cainflow' } }, { temperature: 0.25, metadata: { source: 'cainflow' } }
    ]);
});

test('original images pass through a saved preview into the provider without media owners', async () => {
    const saved = document([
        { id: 'original', type: 'FileImport', fileImport: { id: 'a'.repeat(32), name: 'cover.png', kind: 'image' } },
        { id: 'preview', type: 'ImagePreview' },
        { id: 'chat', type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider', prompt: 'Describe it' }
    ], [wire('original', 'image', 'preview', 'image', 'image'), wire('preview', 'image', 'chat', 'image_1', 'image')]);
    const data = 'data:image/png;base64,YQ==';
    let reads = 0;
    const run = await executeSavedWorkflow({ document: saved,
        models: [{ id: 'chat-model', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        async loadFileValue(nodeId, reference, kind) {
            assert.deepEqual([nodeId, reference, kind], ['original', 'a'.repeat(32), 'image']);
            reads++;
            return data;
        },
        async saveMedia() { assert.fail('A preview must not create a copy of the original'); },
        async requestProvider({ body }) {
            assert.match(body, /data:image\/png;base64,YQ==/);
            return Response.json({ choices: [{ message: { content: 'Received image' } }] });
        }
    });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    assert.equal(reads, 1);
    assert.doesNotMatch(JSON.stringify(run.document), /base64,YQ==/);
});

test('a text split keeps its output count without saving any original content', async () => {
    const saved = document([
        { id: 'original', type: 'FileImport', fileImport: { id: 'a'.repeat(32), name: 'notes.md' } },
        { id: 'split', type: 'TextSplit', delimiter: '|' }
    ], [wire('original', 'text', 'split', 'text')]);
    const run = await executeSavedWorkflow({ document: saved, loadFileText: async () => 'secret-one|secret-two' });
    assert.equal(run.outcome, 'completed');
    assert.equal(run.document.nodes.find(node => node.id === 'split').fileTextPartCount, 2);
    assert.doesNotMatch(JSON.stringify([run.document, run.nodeResults]), /secret-one|secret-two/);
});

test('a changed original is read once per saved run for multiple conversations', async () => {
    const chat = { type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider' };
    const saved = document([
        { id: 'original', type: 'FileImport', fileImport: { id: 'a'.repeat(32), name: 'notes.md' } },
        { ...chat, id: 'first' },
        { ...chat, id: 'second' }
    ], [wire('original', 'text', 'first', 'prompt'), wire('original', 'text', 'second', 'prompt')]);
    let source = '# First version';
    let readCount = 0;
    const requests = [];
    const options = {
        document: saved,
        models: [{ id: 'chat-model', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        async loadFileText() {
            readCount++;
            return source;
        },
        async requestProvider({ body }) {
            requests.push(JSON.parse(body).messages.at(-1).content);
            source = '# Next version';
            return Response.json({ choices: [{ message: { content: 'Read the file' } }] });
        }
    };
    assert.equal((await executeSavedWorkflow(options)).outcome, 'completed');
    assert.equal((await executeSavedWorkflow(options)).outcome, 'completed');
    assert.equal(readCount, 2);
    assert.deepEqual(requests, ['# First version', '# First version', '# Next version', '# Next version']);
});

test('an unavailable original stops its branch while an independent text node completes', async () => {
    const saved = document([
        { id: 'original', type: 'FileImport', fileImport: { id: 'a'.repeat(32), name: 'notes.md' } },
        { id: 'dependent', type: 'Text' },
        { id: 'independent', type: 'Text', text: 'independent result' }
    ], [wire('original', 'text', 'dependent', 'text')]);
    const run = await executeSavedWorkflow({ document: saved, loadFileText: async () => { throw new Error('原件已变更，请重跑。'); } });
    assert.equal(run.outcome, 'failed');
    assert.equal(run.nodeResults.find(node => node.nodeId === 'dependent').succeeded, false);
    assert.deepEqual(run.nodeResults.find(node => node.nodeId === 'independent').texts, ['independent result']);
    assert.match(run.nodeResults.find(node => node.nodeId === 'original').failureMessage, /重跑/);
});

test('saved conversations attach canvas and pinned history mentions and reject missing originals before requesting', async () => {
    const red = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const blue = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const sourceId = createCanvasImageSourceId('red', 'image', 0, 'media:red');
    const saved = document([
        { id: 'red', type: 'ImageImport', mediaAssetKeys: ['media:red'] },
        { id: 'chat', type: 'TextChat', apiConfigId: 'chat-model', providerId: 'provider', prompt: 'Compare @图片1 and @图片2',
            imagePromptMentions: [
                { token: '@图片1', source: { id: sourceId, sourceId, workflowId: 'saved-workflow', sourceNodeId: 'red', assetKey: 'media:red' } },
                { token: '@图片2', source: { id: 'history-blue', historyId: '12', historyVersion: '100:200' } }
            ] }
    ]);
    const requests = [];
    const historyReads = [];
    const runOptions = { document: saved, nodeIds: ['chat'],
        models: [{ id: 'chat-model', modelId: 'configured-chat', taskType: 'chat', protocol: 'openai', providerIds: ['provider'] }],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        loadMedia: async key => key === 'media:red' ? red : null,
        async requestProvider({ body }) {
            requests.push(JSON.parse(body));
            return Response.json({ choices: [{ message: { content: 'ok' } }] });
        }
    };
    const run = await executeSavedWorkflow({ ...runOptions, async getHistoryEntry(id, { fileVersion }) {
        historyReads.push([id, fileVersion]);
        return { fileVersion, image: blue };
    } });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults));
    assert.deepEqual(historyReads, [['12', '100:200']]);
    assert.deepEqual(requests[0].messages[0].content, [
        { type: 'text', text: 'Compare 参考图 1 and 参考图 2' },
        { type: 'image_url', image_url: { url: red } }, { type: 'image_url', image_url: { url: blue } }
    ]);
    const stale = await executeSavedWorkflow({ ...runOptions, getHistoryEntry: async () => ({ fileVersion: '100:201', image: blue }) });
    assert.equal(stale.outcome, 'failed');
    assert.equal(stale.nodeResults[0].failureCategory, 'input');
    assert.equal(requests.length, 1);
});

test('saved video generation uses the registered declarative protocol and stores video media in both document projections', async () => {
    const controlledBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
    const dataUrl = `data:video/mp4;base64,${controlledBytes.toString('base64')}`;
    const model = { id: 'video-model', modelId: 'seedance2.0', taskType: 'video', protocol: 'api6789-seedance', providerIds: ['provider'] };
    const imageUrl = 'https://controlled.test/reference.png';
    const sourceId = createCanvasImageSourceId('reference', 'image', 0, imageUrl);
    const saved = document([
        { id: 'video', type: 'VideoGenerate', apiConfigId: model.id, providerId: 'provider', prompt: 'Camera pans @图片1',
            imagePromptMentions: [{ token: '@图片1', source: { id: sourceId, sourceId, sourceNodeId: 'reference', imageUrl } }],
            mediaAssetKeys: ['media:previous'], data: { mediaAssetKeys: ['media:previous'], videoAssetKey: 'media:previous' } },
        { id: 'reference', type: 'ImageImport', importMode: 'url', imageUrl }
    ]);
    const calls = [];
    const run = await executeSavedWorkflow({ document: saved, nodeIds: ['video'], models: [model],
        providers: [{ id: 'provider', endpoint: 'https://controlled.test', apikey: 'test' }],
        async requestProvider({ method, url, headers, body }) {
            calls.push([method, url]);
            if (method === 'POST') {
                const payload = JSON.parse(body);
                assert.equal(payload.prompt, 'Camera pans 参考图 1');
                assert.deepEqual(payload.image_urls, [imageUrl]);
                assert.equal(headers.Authorization, 'Bearer test');
                return Response.json({ id: 'video-id' });
            }
            if (url.endsWith('/video-id')) return Response.json({ status: 'succeeded', file: 'https://controlled.test/result.mp4' });
            assert.equal(headers.Authorization, undefined);
            return new Response(controlledBytes, { headers: { 'Content-Type': 'video/mp4' } });
        },
        async saveMedia(value, nodeId) {
            assert.equal(nodeId, 'video');
            assert.equal(value, dataUrl);
            return 'media:video';
        }
    });
    assert.equal(run.outcome, 'completed', JSON.stringify(run.nodeResults.map(result => result.failureCategory)));
    assert.deepEqual(calls, [
        ['POST', 'https://controlled.test/v1/videos'], ['GET', 'https://controlled.test/v1/videos/video-id'], ['GET', 'https://controlled.test/result.mp4']
    ]);
    assert.deepEqual(run.nodeResults[0].mediaAssetKeys, ['media:video']);
    assert.deepEqual(run.document.nodes[0].mediaAssetKeys, ['media:video']);
    assert.deepEqual(run.document.nodes[0].data.mediaAssetKeys, ['media:video']);
    assert.equal(run.document.nodes[0].data.videoAssetKey, 'media:video');
});
