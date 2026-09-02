import assert from 'node:assert/strict';
import test from 'node:test';

import {
    formatVideoPollingStatus,
    getNodeRunTimeoutSeconds,
    getVideoPollingBudget,
    getVideoRequestTimeoutSeconds,
    videoTimeoutMinutesToSeconds
} from '../js/features/execution/async-media-execution.js';

test('video polling status keeps a queued task visibly running with supplier status and elapsed time', () => {
    assert.equal(
        formatVideoPollingStatus({
            videoId: 'task-42',
            supplierStatus: 'queued',
            attempt: 18,
            maxAttempts: 180,
            elapsedMs: 172000
        }),
        '轮询中：任务 task-42，供应商状态：排队中；已查询 18/180 次，已等待 2分52秒'
    );
});

test('each node uses its own timeout category instead of inheriting a workflow-wide video timeout', () => {
    const settings = {
        requestTimeoutEnabled: true,
        requestTimeoutSeconds: 60,
        videoRequestTimeoutEnabled: true,
        videoRequestTimeoutSeconds: 1800
    };
    assert.equal(getNodeRunTimeoutSeconds({ type: 'ImageGenerate' }, settings), 60);
    assert.equal(getNodeRunTimeoutSeconds({ type: 'VideoGenerate' }, settings), 1800);
});

test('video polling budget deducts time already spent creating the video task', () => {
    assert.deepEqual(
        getVideoPollingBudget({
            timeoutSeconds: 1800,
            nodeStartedAt: 1_000_000,
            now: 1_300_000,
            intervalMs: 10_000
        }),
        { remainingMs: 1_500_000, maxAttempts: 150 }
    );
});

test('video timeout settings convert user-entered minutes to the stored seconds value', () => {
    assert.equal(videoTimeoutMinutesToSeconds(30), 1800);
});

test('video request timeout uses its dedicated setting instead of the image request timeout', () => {
    assert.equal(getVideoRequestTimeoutSeconds({
        requestTimeoutEnabled: true,
        requestTimeoutSeconds: 60,
        videoRequestTimeoutEnabled: true,
        videoRequestTimeoutSeconds: 1800
    }), 1800);
    assert.equal(getVideoRequestTimeoutSeconds({
        requestTimeoutEnabled: true,
        requestTimeoutSeconds: 60,
        videoRequestTimeoutEnabled: false,
        videoRequestTimeoutSeconds: 1800
    }), 0);
    assert.equal(getVideoRequestTimeoutSeconds({
        videoRequestTimeoutEnabled: true,
        videoRequestTimeoutSeconds: 'invalid'
    }), 1800);
});
