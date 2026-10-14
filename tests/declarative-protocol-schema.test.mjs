import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DECLARATIVE_PROTOCOL_SCHEMA,
    getDeclarativeProtocolEditorContract,
    getEffectiveProtocolParameters,
    mergeDeclarativeProtocol,
    resolveDeclarativeProtocolVariant
} from '../js/features/execution/protocols/declarative-protocol-schema.js';
import { buildRequestFromConfig } from '../js/features/execution/protocols/request-builder.js';

test('declarative protocol overlays merge objects recursively, replace arrays, and let null clear fields', () => {
    const base = {
        id: 'example',
        authentication: { location: 'header', headers: { 'X-Base': 'base' } },
        parameters: {
            prompt: { requestField: 'prompt', limits: { min: 1, max: 100 }, options: ['base'] }
        },
        futureRule: { keep: true, nested: { base: 1 } }
    };
    const overlay = {
        authentication: { headers: { 'X-Variant': 'variant' } },
        parameters: {
            prompt: { limits: { max: 40 }, options: ['variant'] }
        },
        futureRule: { nested: { extension: 2 } },
        clearMe: null
    };

    const merged = mergeDeclarativeProtocol(base, overlay);
    assert.deepEqual(merged.authentication, {
        location: 'header', headers: { 'X-Base': 'base', 'X-Variant': 'variant' }
    });
    assert.deepEqual(merged.parameters.prompt.limits, { min: 1, max: 40 });
    assert.deepEqual(merged.parameters.prompt.options, ['variant']);
    assert.deepEqual(merged.futureRule, { keep: true, nested: { base: 1, extension: 2 } });
    assert.equal(merged.clearMe, null);
    assert.deepEqual(base.parameters.prompt.options, ['base']);
});

test('variant resolution exposes a recursively inherited editing/execution contract', () => {
    const protocol = {
        id: 'example',
        variantIdCaseInsensitive: true,
        parameters: { prompt: { required: true, limits: { min: 1, max: 100 } } },
        asyncTask: { statusPath: 'status', future: { keep: true } },
        variants: {
            'model-a': {
                createPath: '/v1/create',
                queryPath: '/v1/{{taskId}}',
                parameters: { prompt: { limits: { max: 20 } } },
                futureVariant: { enabled: true }
            }
        }
    };
    const resolved = resolveDeclarativeProtocolVariant(protocol, 'MODEL-A');
    assert.equal(resolved.matched, true);
    assert.equal(resolved.variantId, 'model-a');
    assert.deepEqual(resolved.configuration.parameters.prompt, {
        required: true, limits: { min: 1, max: 20 }
    });
    assert.deepEqual(resolved.configuration.asyncTask.future, { keep: true });
    assert.deepEqual(resolved.configuration.futureVariant, { enabled: true });
    assert.deepEqual(getEffectiveProtocolParameters(protocol, 'model-a'), resolved.configuration.parameters);

    const contract = getDeclarativeProtocolEditorContract(protocol);
    assert.equal(contract.merge.unknownFields, 'preserve-read-only');
    assert.equal(contract.unknownFields.protocol.futureVariant, undefined);
    assert.deepEqual(contract.variants[0].unknownFields.futureVariant, { enabled: true });
    assert.deepEqual(contract.variants[0].parameters.prompt.unknownFields.limits, { max: 20 });
});

test('request builder consumes merged variant parameters and keeps unknown declarations intact', () => {
    const protocol = {
        id: 'example',
        taskTypes: ['image'],
        parameters: { prompt: { requestField: 'prompt', defaultValue: 'base' } },
        variants: {
            'model-a': {
                parameters: { prompt: { defaultValue: 'variant' }, width: { defaultValue: 512, dataType: 'number' } },
                futureCapability: { mode: 'preserved' }
            }
        }
    };
    const body = buildRequestFromConfig(protocol, {
        taskType: 'image',
        parameters: {},
        inputs: {},
        modelConfig: { modelId: 'model-a' }
    });
    assert.deepEqual(body, { model: 'model-a', prompt: 'variant', width: 512 });
    assert.equal(DECLARATIVE_PROTOCOL_SCHEMA.merge.arrays, 'replace');
});
