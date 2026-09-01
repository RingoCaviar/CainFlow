import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { VeoUnifiedProtocol } from '../js/features/execution/protocols/veo-unified.js';
import { DoubaoVideoProtocol } from '../js/features/execution/protocols/doubao-video.js';
import { describeVideoProtocolCard } from '../js/nodes/video-protocol-card.js';
import { activateProtocolVariantDraft, saveProtocolVariantDraft } from '../js/nodes/protocol-variant-drafts.js';

test('Kling card contract exposes the exact variant identity and constraints', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'kling-o3'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: false,
        summary: '6789中转视频 · kling-o3 · 时长 3–15 秒 · 最多 5 张参考图'
    });
});

test('MiniMax card contract retains its own exact limits', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'minimax-h3'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: false,
        summary: '6789中转视频 · minimax-h3 · 时长 4–15 秒 · 最多 1 张参考图'
    });
});

test('an unmatched declared video variant enters a safe card state', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'unknown-video'), {
        isDeclared: true,
        isIncomplete: false,
        isUnmatched: true,
        summary: '6789中转视频 · unknown-video · 未配置变体'
    });
});

test('variant drafts restore prior values and only initialize newly declared defaults', () => {
    const kling = { seconds: { defaultValue: 3 }, size: { defaultValue: '960x1280' } };
    const minimax = { seconds: { defaultValue: 4 }, size: { defaultValue: '1440x1920' } };
    let data = activateProtocolVariantDraft({}, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: kling });
    data = saveProtocolVariantDraft(data, { seconds: 12, size: '960x1280' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'minimax-h3', parameters: minimax });
    assert.deepEqual(data.protocolParams, { seconds: 4, size: '1440x1920' });
    data = activateProtocolVariantDraft(data, { protocolId: 'async-video-api', modelId: 'kling-o3', parameters: { ...kling, loop: { defaultValue: false } } });
    assert.deepEqual(data.protocolParams, { seconds: 12, size: '960x1280', loop: false });
});

test('built-in video protocols expose their declared card contracts without variants', () => {
    assert.equal(describeVideoProtocolCard(VeoUnifiedProtocol, 'veo-3').isDeclared, true);
    assert.equal(describeVideoProtocolCard(DoubaoVideoProtocol, 'seedance').isDeclared, true);
});

test('built-in video parameters remain declaration-owned after the legacy control migration', () => {
    const parameters = VeoUnifiedProtocol.parameters;
    assert.equal(parameters.aspect_ratio.exposed, true);
    assert.equal(parameters.duration.exposed, true);
    assert.equal(DoubaoVideoProtocol.parameters.resolution.exposed, true);
    assert.equal(DoubaoVideoProtocol.parameters.camera_fixed.exposed, true);
});

test('a user-owned video protocol without editable parameters has a safe card error', () => {
    assert.deepEqual(describeVideoProtocolCard({ id: 'user-video', label: 'User video', parameters: {} }, 'model-a'), {
        isDeclared: false,
        isIncomplete: true,
        isUnmatched: false,
        summary: 'User video · model-a · 未声明可编辑视频参数'
    });
});
