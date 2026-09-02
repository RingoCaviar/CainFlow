import assert from 'node:assert/strict';
import test from 'node:test';
import { getNodePromptPortIds, getNodePromptValue } from '../js/features/execution/workflow-runner.js';
import { renderProtocolParameter } from '../js/nodes/protocol-ui-renderer.js';

test('video preflight accepts the prompt field rendered from its selected protocol', () => {
    const documentRef = {
        getElementById(id) {
            return id === 'video-1-param-prompt' ? { value: '猫吃草' } : null;
        }
    };

    assert.equal(
        getNodePromptValue({ id: 'video-1', type: 'VideoGenerate', data: {} }, documentRef),
        '猫吃草'
    );
});

test('video preflight accepts a required protocol text parameter with a nonstandard ID', () => {
    const documentRef = {
        getElementById: () => null,
        querySelector: (selector) => selector === '#video-custom [data-protocol-prompt="true"]'
            ? { value: '镜头缓慢推进' }
            : null
    };

    assert.equal(
        getNodePromptValue({ id: 'video-custom', type: 'VideoGenerate', data: {} }, documentRef),
        '镜头缓慢推进'
    );
});

test('a required protocol text parameter is rendered as the protocol prompt', () => {
    const markup = renderProtocolParameter('video-custom', {
        id: 'sceneDescription', required: true, inputPort: true, portType: 'text', uiControl: 'textarea'
    });

    assert.match(markup, /data-protocol-prompt="true"/);
});

test('a required textarea parameter remains the protocol prompt without port type metadata', () => {
    const markup = renderProtocolParameter('video-custom', {
        id: 'sceneDescription', required: true, inputPort: true, uiControl: 'textarea'
    });

    assert.match(markup, /data-protocol-prompt="true"/);
});

test('video preflight recognizes a declared nonstandard protocol prompt port', () => {
    const documentRef = {
        querySelectorAll: (selector) => selector === '#video-custom [data-protocol-prompt="true"]'
            ? [{ id: 'video-custom-param-sceneDescription' }]
            : []
    };

    assert.deepEqual(
        getNodePromptPortIds({ id: 'video-custom', type: 'VideoGenerate' }, documentRef),
        ['prompt', 'sceneDescription']
    );
});

test('text chat preflight retains its legacy prompt field', () => {
    const documentRef = {
        getElementById(id) {
            return id === 'chat-1-prompt' ? { value: '请总结这段文字' } : null;
        }
    };

    assert.equal(
        getNodePromptValue({ id: 'chat-1', type: 'TextChat', data: {} }, documentRef),
        '请总结这段文字'
    );
});
