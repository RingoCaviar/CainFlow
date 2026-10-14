import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getTransportAdapter,
    resolveMultipartParts,
    resolveTransportAdapter,
    validateTransportAdapterConfiguration
} from '../js/features/execution/protocols/transport-adapter-registry.js';

test('transport adapters expose stable capability metadata and legacy encodings resolve', () => {
    assert.equal(getTransportAdapter('multipart').adapterId, 'multipart');
    assert.deepEqual(resolveTransportAdapter({ requestEncoding: 'json' }, {}).capabilities.fieldSources, ['parameter', 'literal']);
    assert.equal(resolveTransportAdapter({ requestEncoding: 'multipart' }, {}).encoding, 'multipart');
});

test('multipart adapter resolves ordered parameter, media, and literal parts', () => {
    const adapter = {
        adapterId: 'multipart',
        version: 1,
        parts: [
            { name: 'prompt', source: 'parameter', path: 'prompt', kind: 'text', required: true },
            { name: 'image', source: 'media', path: 'referenceImages', kind: 'file', repeat: true },
            { name: 'mode', source: 'literal', value: 'fast', kind: 'text' }
        ]
    };
    validateTransportAdapterConfiguration({ transportAdapter: adapter }, {});
    assert.deepEqual(resolveMultipartParts(adapter.parts, {
        parameters: { prompt: 'hello' },
        inputs: { referenceImages: ['data:image/png;base64,AAAA', 'https://cdn.example/a.png'] }
    }), [
        ['prompt', 'hello'],
        ['image', 'data:image/png;base64,AAAA'],
        ['image', 'https://cdn.example/a.png'],
        ['mode', 'fast']
    ]);
});

test('unsupported adapter versions and fields block save or execution with an explanation', () => {
    assert.throws(
        () => validateTransportAdapterConfiguration({ transportAdapter: { adapterId: 'multipart', version: 1, headers: {} } }, {}),
        /不支持字段.*headers/
    );
    const future = resolveTransportAdapter({ transportAdapter: { adapterId: 'multipart', version: 2 } }, {});
    assert.equal(future.unsupported, true);
    assert.match(future.reason, /只能只读保留/);
    assert.throws(
        () => validateTransportAdapterConfiguration({ transportAdapter: { adapterId: 'multipart', version: 2 } }, {}),
        /只能只读保留/
    );
});

test('required multipart values fail before a network request is built', () => {
    assert.throws(() => resolveMultipartParts([
        { name: 'prompt', source: 'parameter', path: 'prompt', required: true }
    ], { parameters: {} }), /缺少必填值/);
});
