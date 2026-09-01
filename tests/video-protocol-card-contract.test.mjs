import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayVideoProtocol } from '../js/features/execution/protocols/api6789-video.js';
import { describeVideoProtocolCard } from '../js/nodes/video-protocol-card.js';

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
