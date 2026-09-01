import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compileVideoProtocol,
    migrateProtocolConfiguration,
    redactProtocolPreview
} from '../js/features/execution/protocols/video-protocol-compiler.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { requireModelCompatibilityFormat } from '../js/features/execution/model-compatibility-format.js';

const protocol = {
    id: 'relay-video',
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
