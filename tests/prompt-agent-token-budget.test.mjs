import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePromptAgentContext, countPromptText, fitPromptAgentContext } from '../js/features/prompt-agent/prompt-agent-token-budget.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';
import { readImageSize, measureImageTokens } from '../js/features/prompt-agent/prompt-agent-image-tokens.js';

test('token meter and trigger share the same boundary, with a usable default', () => {
    const baseline = measurePromptAgentContext({});
    assert.equal(baseline.threshold, 12000);
    assert.ok(baseline.used > 0);
    assert.equal(measurePromptAgentContext({ autoCompactTokenLimit: baseline.used }).reached, true);
    assert.equal(measurePromptAgentContext({ autoCompactTokenLimit: baseline.used + 1 }).reached, false);
    assert.equal(measurePromptAgentContext({ autoCompactTokenLimit: NaN, model: { autoCompactTokenLimit: 1 } }).threshold, 12000);
});

test('real BPE goldens distinguish Chinese, English, Japanese and emoji encodings', () => {
    for (const [text, o200k, cl100k] of [
        ['hello world', 2, 2], ['你好，世界', 3, 6], ['お誕生日おめでとう', 8, 9], ['😀🚀', 3, 5]
    ]) {
        assert.equal(countPromptText(text), o200k);
        assert.equal(countPromptText(text, 'cl100k_base'), cl100k);
    }
    assert.equal(countPromptText('<|endoftext|>'), 7, 'user text must not inject a special token or throw');
});

function png(width, height) {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(0x89504e47); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('image dimensions and model-specific tile/patch rules replace flat cost', () => {
    assert.deepEqual(readImageSize(png(1024, 1024)), { width: 1024, height: 1024 });
    assert.equal(measureImageTokens(png(1024, 1024), 'gpt-4o').tokens, 765);
    assert.equal(measureImageTokens(png(512, 512), 'gpt-4o').tokens, 255);
    assert.equal(measureImageTokens(png(2048, 4096), 'gpt-4o').tokens, 1105);
    assert.equal(measureImageTokens(png(1024, 1024), 'gpt-4o-mini').tokens, 25501);
    assert.equal(measureImageTokens(png(1024, 1024), 'gpt-4.1-mini').tokens, 1659);
    assert.equal(measureImageTokens(png(1800, 2400), 'gpt-4.1-mini').tokens, 2353);
    for (const source of ['https://example.test/image.png', 'data:image/png;base64,bad!']) {
        assert.equal(readImageSize(source), null);
        assert.equal(measureImageTokens(source, 'gpt-4o').estimated, true);
    }
    assert.equal(measureImageTokens(png(1024, 1024), 'unknown-model').estimated, true);
});

test('server input usage anchors the same image batch; changes invalidate calibration', () => {
    const request = { model: { modelId: 'gpt-4o', protocol: 'openai' }, message: '原文' };
    const measurement = measurePromptAgentContext(request);
    const observation = { measurement, inputTokens: 5321 };
    assert.equal(measurePromptAgentContext(request, observation).used, 5321);
    const changed = { ...request, message: '原文加上新要求' };
    assert.equal(measurePromptAgentContext(changed, observation).used,
        5321 + measurePromptAgentContext(changed).textTokens - measurement.textTokens);
    for (const invalidated of [
        { ...request, model: { modelId: 'gpt-4o-mini' } },
        { ...request, referenceImages: [{ dataUrl: png(512, 512) }] }
    ]) assert.equal(measurePromptAgentContext(invalidated, observation).used, measurePromptAgentContext(invalidated).used);
    assert.match(measurePromptAgentContext({ model: { modelId: 'gemini', protocol: 'google' } }).source, /未确认/);
    assert.match(measurePromptAgentContext(request).source, /o200k_base/);
    assert.match(measurePromptAgentContext({ model: { modelId: 'gpt-4-turbo' } }).source, /cl100k_base/);
});

test('estimation includes full untruncated history and image count, not encoded image bytes', () => {
    const short = measurePromptAgentContext({ conversation: { messages: [{ role: 'user', text: '旧' }] } });
    const long = measurePromptAgentContext({ conversation: { messages: [{ role: 'user', text: '旧'.repeat(20000) }] } });
    assert.ok(long.used > short.used + 10000);
    const image = length => measurePromptAgentContext({ referenceImages: [{ name: '图', dataUrl: 'data:image/png;base64,' + 'A'.repeat(length) }] });
    assert.equal(image(10).used, image(100000).used);
    assert.ok(image(10).used > measurePromptAgentContext({}).used + 1000);
});

test('discarding an oldest turn drops its images and keeps the original numbering of recent turns', () => {
    const oldImage = { name: '旧参考图', dataUrl: png(2048, 2048) };
    const currentImage = { name: '本轮参考图', dataUrl: png(512, 512) };
    const recent = [{ role: 'user', text: '最近问题' }, { role: 'agent', text: '最近回答' }];
    const base = { model: { modelId: 'gpt-4o' }, message: '本轮请求', referenceImages: [currentImage] };
    const threshold = measurePromptAgentContext({ ...base, conversation: { messages: recent, messageOffset: 2 } }).used + 20;
    const fitted = fitPromptAgentContext({ ...base, autoCompactTokenLimit: threshold,
        conversation: { messages: [{ role: 'user', text: '旧问题', referenceImages: [oldImage] }, { role: 'agent', text: '旧回答' }, ...recent] },
        workflowReferenceImages: [oldImage, { ...oldImage, runId: 'old-run', messageNumber: 2 }]
    }, () => null);
    const input = createPromptAgentInput(fitted.request);
    assert.equal(fitted.discardedMessageCount, 2);
    assert.deepEqual(input.media.map(image => image.url), [currentImage.dataUrl]);
    assert.deepEqual(input.messages.slice(0, -1).map(turn => JSON.parse(turn.content).messageNumber), [3, 4]);
    assert.equal(JSON.parse(input.messages.at(-1).content).historyOmitted, true);
    assert.ok(measurePromptAgentContext(fitted.request).used <= threshold);
});

test('discarding history keeps the brief when the user answers a pending choice', () => {
    const question = '横版还是竖版？';
    const brief = { role: 'user', text: '给展览做海报' };
    const pending = { role: 'agent', text: question, choices: ['横版', '竖版'] };
    const request = { autoCompactTokenLimit: 1, conversation: { messages: [
        { role: 'user', text: '旧任务' }, { role: 'agent', text: '旧任务回复' }, brief, pending
    ] } };
    const awaiting = fitPromptAgentContext(request, () => null);
    assert.deepEqual(awaiting.request.conversation.messages, [brief, pending]);
    const answering = fitPromptAgentContext({ ...request, message: '竖版', choiceAnswer: { question, choice: '竖版' } }, () => null);
    assert.deepEqual(answering.request.conversation.messages, [brief, pending]);
    const unrelated = fitPromptAgentContext({ ...request, message: '画一张足球场照片' }, () => null);
    assert.deepEqual(unrelated.request.conversation.messages, []);
});
