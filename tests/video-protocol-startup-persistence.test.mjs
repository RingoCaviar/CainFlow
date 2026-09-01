import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeModelConfig } from '../js/features/execution/provider-request-utils.js';

test('startup preserves the saved async video compatibility format before protocol modules load', () => {
    const restored = normalizeModelConfig({
        id: 'mod_kling',
        name: 'Kling O3',
        modelId: 'kling-o3',
        providerIds: ['prov_relay'],
        providerId: 'prov_relay',
        taskType: 'video',
        protocol: 'async-video-api'
    }, 0, [{ id: 'prov_relay', type: 'openai' }]);

    assert.equal(restored.protocol, 'async-video-api');
});

test('startup migrates the retired relay video compatibility format before protocol modules load', () => {
    const restored = normalizeModelConfig({
        id: 'mod_legacy_kling', modelId: 'kling-o3', providerIds: ['prov_relay'],
        taskType: 'video', protocol: 'relay-video'
    }, 0, [{ id: 'prov_relay', type: 'openai' }]);

    assert.equal(restored.protocol, 'async-video-api');
});
