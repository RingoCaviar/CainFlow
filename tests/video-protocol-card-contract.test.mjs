import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { describeVideoProtocolCard } from '../js/nodes/video-protocol-card.js';
import { activateProtocolVariantDraft, saveProtocolVariantDraft } from '../js/nodes/protocol-variant-drafts.js';

test('Kling card contract exposes the exact variant identity and constraints', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'kling-o3'), {
        isDeclared: true,
        isUnmatched: false,
        summary: '6789中转视频 · kling-o3 · 时长 3–15 秒 · 最多 5 张参考图'
    });
});

test('MiniMax card contract retains its own exact limits', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'minimax-h3'), {
        isDeclared: true,
        isUnmatched: false,
        summary: '6789中转视频 · minimax-h3 · 时长 4–15 秒 · 最多 1 张参考图'
    });
});

test('an unmatched declared video variant enters a safe card state', () => {
    assert.deepEqual(describeVideoProtocolCard(RelayVideoProtocol, 'unknown-video'), {
        isDeclared: true,
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
