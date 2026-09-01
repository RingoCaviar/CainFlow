import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compileVideoProtocol,
    importVideoProtocolConfiguration,
    migrateProtocolConfiguration,
    redactProtocolPreview,
    validateVideoProtocolConfiguration
} from '../js/features/execution/protocols/video-protocol-compiler.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { requireModelCompatibilityFormat } from '../js/features/execution/model-compatibility-format.js';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { buildMultipartFormData } from '../js/features/execution/protocols/multipart-transport-adapter.js';
import { createProxyHeadersGetter } from '../js/services/api-client.js';

const protocol = {
    id: 'async-video-api',
    label: 'Relay video',
    schemaVersion: 1,
    taskTypes: ['video'],
    authentication: { location: 'header', field: 'Authorization', template: 'Bearer {apikey}' },
    variants: {
        'model-a': {
            requestEncoding: 'json',
            createPath: '/v1/videos',
            queryPath: '/v1/videos/{{taskId}}',
            parameters: {
                prompt: { requestField: 'prompt', required: true },
                seconds: { requestField: 'seconds', type: 'number', min: 3, max: 15 }
            },
            asyncTask: {
                taskIdPath: 'id',
                statusPath: 'status',
                completedStatuses: ['completed'],
                resultPath: 'video_url'
            }
        }
    }
};

test('compiles an exact video variant into JSON creation and query plans', () => {
    const plan = compileVideoProtocol({
        protocol,
        endpoint: 'https://relay.example/',
        modelId: 'model-a',
        parameters: { prompt: 'A quiet lake', seconds: 5 },
        apiKey: 'secret'
    });

    assert.equal(plan.create.url, 'https://relay.example/v1/videos');
    assert.deepEqual(plan.create.body, { model: 'model-a', prompt: 'A quiet lake', seconds: 5 });
    assert.deepEqual(plan.create.headers, { Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
    assert.equal(plan.queryUrl('task-42'), 'https://relay.example/v1/videos/task-42');
    assert.deepEqual(plan.asyncTask.completedStatuses, ['completed']);
});

test('rejects unmatched variants and invalid parameter values before requests are created', () => {
    assert.throws(
        () => compileVideoProtocol({ protocol, endpoint: 'https://relay.example', modelId: 'model-b' }),
        /未配置模型 “model-b” 的变体/
    );
    assert.throws(
        () => compileVideoProtocol({
            protocol,
            endpoint: 'https://relay.example',
            modelId: 'model-a',
            parameters: { prompt: 'A quiet lake', seconds: 16 }
        }),
        /seconds.*15/
    );
});

test('migrates legacy configurations and protects configurations from a future schema', () => {
    const migrated = migrateProtocolConfiguration({ id: 'legacy', taskTypes: ['video'] });
    assert.equal(migrated.schemaVersion, 1);
    assert.equal(migrated.readOnly, false);

    const future = migrateProtocolConfiguration({ id: 'future', schemaVersion: 2 });
    assert.equal(future.readOnly, true);
    assert.equal(future.executionBlockedReason, '此协议由更新版本的 CainFlow 创建，当前版本只能只读保留。');
});

test('redacts API keys from protocol previews', () => {
    const preview = redactProtocolPreview({
        headers: { Authorization: 'Bearer secret', 'X-API-Key': 'another-secret' },
        body: { prompt: 'safe' }
    });
    assert.deepEqual(preview.headers, { Authorization: '<REDACTED>', 'X-API-Key': '<REDACTED>' });
    assert.deepEqual(preview.body, { prompt: 'safe' });
});

test('redacts API keys from query-authenticated preview URLs', () => {
    const preview = redactProtocolPreview({
        url: 'https://relay.example/v1/videos?key=secret',
        query_url_template: 'https://relay.example/v1/videos/task-example?key=secret'
    }, { location: 'query', field: 'key' });
    assert.equal(preview.url, 'https://relay.example/v1/videos?key=%3CREDACTED%3E');
    assert.equal(preview.query_url_template, 'https://relay.example/v1/videos/task-example?key=%3CREDACTED%3E');
});

test('redacts variant-owned custom authentication headers and query fields', () => {
    const customHeader = redactProtocolPreview({ headers: { 'X-Token': 'secret' } }, {
        location: 'header', field: 'X-Token'
    });
    assert.equal(customHeader.headers['X-Token'], '<REDACTED>');
    assert.equal(redactProtocolPreview({ headers: { 'X-Token': 'secret' } }, { field: 'X-Token' }).headers['X-Token'], '<REDACTED>');
    const variantProtocol = {
        ...protocol,
        variants: {
            'model-a': {
                ...protocol.variants['model-a'],
                authentication: { location: 'query', field: 'token', template: '{apikey}' }
            }
        }
    };
    const plan = compileVideoProtocol({
        protocol: variantProtocol, endpoint: 'https://relay.example', modelId: 'model-a',
        parameters: { prompt: 'lake', seconds: 5 }, apiKey: 'secret'
    });
    assert.equal(plan.authentication.field, 'token');
    assert.doesNotMatch(redactProtocolPreview({ url: plan.create.url }, plan.authentication).url, /secret/);
});

test('validates and imports complete declarative video protocol configurations offline', () => {
    assert.equal(validateVideoProtocolConfiguration(protocol), true);
    assert.equal(importVideoProtocolConfiguration(JSON.stringify(protocol)).id, 'async-video-api');
    assert.throws(() => importVideoProtocolConfiguration('{bad json'), /JSON/);
    assert.throws(() => validateVideoProtocolConfiguration({ ...protocol, variants: {} }), /至少一个精确模型变体/);
    const future = importVideoProtocolConfiguration(JSON.stringify({
        id: 'future', schemaVersion: 2, taskTypes: ['video'], futureShape: true
    }));
    assert.equal(future.readOnly, true);
    assert.equal(future.futureShape, true);
    assert.throws(() => validateVideoProtocolConfiguration({
        ...protocol,
        authentication: { location: 'cookie', field: 'token', template: '{apikey}' }
    }), /authentication.location/);
    assert.throws(() => validateVideoProtocolConfiguration({
        ...protocol,
        authentication: { location: 'header', field: 'X-Token', template: 'embedded-secret' }
    }), /\{apikey\}/);
    assert.throws(() => validateVideoProtocolConfiguration({
        ...protocol,
        variants: { 'model-a': { ...protocol.variants['model-a'], requestEncoding: 'script' } }
    }), /requestEncoding/);
    assert.throws(() => validateVideoProtocolConfiguration({
        ...protocol,
        variants: { 'model-a': { ...protocol.variants['model-a'], asyncTask: { taskIdPath: 'id' } } }
    }), /asyncTask.*statusPath/);
    assert.throws(() => validateVideoProtocolConfiguration({
        ...protocol,
        variants: { 'model-a': { ...protocol.variants['model-a'], referenceImage: { mode: 'unknown' } } }
    }), /referenceImage.*mode/);
});

test('compiles multipart media fields and query authentication without silently dropping either', () => {
    const multipartPlan = compileVideoProtocol({
        protocol: {
            ...protocol,
            variants: {
                'model-a': {
                    ...protocol.variants['model-a'],
                    requestEncoding: 'multipart',
                    referenceImage: { field: 'images', mode: 'repeat-field' }
                }
            }
        },
        endpoint: 'https://relay.example',
        modelId: 'model-a',
        parameters: { prompt: 'A quiet lake', seconds: 5 },
        inputs: { referenceImages: ['https://example.test/one.png', 'https://example.test/two.png'] }
    });
    assert.equal(multipartPlan.create.encoding, 'multipart');
    assert.deepEqual(multipartPlan.create.fields.slice(-2), [
        ['images', 'https://example.test/one.png'],
        ['images', 'https://example.test/two.png']
    ]);

    const queryAuthPlan = compileVideoProtocol({
        protocol: { ...protocol, authentication: { location: 'query', field: 'key', template: '{apikey}' } },
        endpoint: 'https://relay.example',
        modelId: 'model-a',
        parameters: { prompt: 'A quiet lake', seconds: 5 },
        apiKey: 'secret'
    });
    assert.match(queryAuthPlan.create.url, /key=secret/);
    assert.match(queryAuthPlan.queryUrl('task-42'), /key=secret/);
});

test('accepts a registered user-owned protocol as a model compatibility format', () => {
    registerProtocol({ id: 'user-video', label: 'User video', taskTypes: ['video'] });
    assert.equal(requireModelCompatibilityFormat({ name: 'User model', protocol: 'user-video' }), 'user-video');
});

test('compiles the relay MiniMax H3 JSON video request and task lifecycle', () => {
    const plan = compileVideoProtocol({
        protocol: RelayVideoProtocol,
        endpoint: 'https://relay.example',
        modelId: 'minimax-h3',
        parameters: { prompt: '人物自然转身', seconds: 4, size: '1440x1920' },
        inputs: { referenceImages: ['data:image/png;base64,AAAA'] },
        apiKey: 'secret'
    });
    assert.equal(plan.create.encoding, 'json');
    assert.equal(plan.create.url, 'https://relay.example/v1/videos');
    assert.deepEqual(plan.create.body, {
        model: 'minimax-h3', prompt: '人物自然转身', seconds: 4, size: '1440x1920', input_reference: 'data:image/png;base64,AAAA'
    });
    assert.equal(plan.queryUrl('task-1'), 'https://relay.example/v1/videos/task-1');
    assert.equal(plan.parseStatus({ status: 'completed' }), 'completed');
    assert.equal(plan.parseResultUrl({ video_url: 'https://example.test/video.mp4' }), 'https://example.test/video.mp4');
    assert.throws(() => compileVideoProtocol({
        protocol: RelayVideoProtocol, endpoint: 'https://relay.example', modelId: 'minimax-h3',
        parameters: { prompt: 'x', seconds: 3, size: '1440x1920' }
    }), /seconds.*4/);
    assert.throws(() => compileVideoProtocol({
        protocol: RelayVideoProtocol, endpoint: 'https://relay.example', modelId: 'minimax-h3',
        parameters: { prompt: 'x', seconds: 4, size: '1440x1920' }, inputs: { referenceImages: ['a', 'b'] }
    }), /最多支持 1 张/);
});

test('compiles Kling O3 as JSON without images and multipart with ordered repeated images', () => {
    const base = { protocol: RelayVideoProtocol, endpoint: 'https://relay.example', modelId: 'kling-o3', parameters: { prompt: '人物转身', seconds: 3, size: '960x1280' } };
    const noImagePlan = compileVideoProtocol(base);
    assert.equal(noImagePlan.create.encoding, 'json');
    assert.deepEqual(noImagePlan.create.body, { model: 'kling-o3', prompt: '人物转身', seconds: 3, size: '960x1280' });
    const imagePlan = compileVideoProtocol({ ...base, inputs: { referenceImages: ['https://example.test/a.png', 'data:image/png;base64,AAAA'] } });
    assert.equal(imagePlan.create.encoding, 'multipart');
    assert.deepEqual(imagePlan.create.fields.slice(-2), [
        ['images', 'https://example.test/a.png'],
        ['images', 'data:image/png;base64,AAAA']
    ]);
    assert.throws(() => compileVideoProtocol({ ...base, parameters: { ...base.parameters, seconds: 2 } }), /seconds.*3/);
    assert.throws(() => compileVideoProtocol({
        ...base,
        inputs: { referenceImages: Array.from({ length: 6 }, (_, index) => `https://example.test/${index}.png`) }
    }), /最多支持 5 张/);
});

test('rejects inactive image connections before creating a request', () => {
    assert.throws(() => compileVideoProtocol({
        protocol,
        endpoint: 'https://relay.example',
        modelId: 'model-a',
        parameters: { prompt: 'A quiet lake', seconds: 5 },
        inputs: { referenceImages: ['https://example.test/a.png'] }
    }), /不支持参考图输入/);
});

test('multipart transport uploads Base64 reference images as files and keeps remote URLs as strings', async () => {
    const formData = buildMultipartFormData([
        ['images', 'https://example.test/a.png'],
        ['images', 'data:image/png;base64,AAAA']
    ]);
    const images = formData.getAll('images');
    assert.equal(images[0], 'https://example.test/a.png');
    assert.ok(images[1] instanceof Blob);
    assert.equal(images[1].type, 'image/png');
    assert.equal(await images[1].arrayBuffer().then((buffer) => buffer.byteLength), 3);
});

test('multipart video requests leave Content-Type to the browser so it can include a boundary', () => {
    const plan = compileVideoProtocol({
        protocol: RelayVideoProtocol,
        endpoint: 'https://relay.example',
        modelId: 'kling-o3',
        parameters: { prompt: '人物转身', seconds: 3, size: '960x1280' },
        inputs: { referenceImages: ['https://example.test/a.png'] }
    });
    const getProxyHeaders = createProxyHeadersGetter(() => ({ requestTimeoutEnabled: false }));
    const headers = getProxyHeaders(plan.create.url, 'POST', {
        ...plan.create.headers,
        'Content-Type': null
    });
    assert.equal(headers['Content-Type'], undefined);
});
