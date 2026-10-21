import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePromptAgentContext, countPromptText } from '../js/features/prompt-agent/prompt-agent-token-budget.js';
import { readImageSize, measureImageTokens } from '../js/features/prompt-agent/prompt-agent-image-tokens.js';

test('token meter and trigger share the same boundary, with a usable default', () => {
    const baseline = measurePromptAgentContext({});
    assert.equal(baseline.threshold, 12000);
    assert.ok(baseline.used > 0);
    assert.equal(measurePromptAgentContext({ model: { autoCompactTokenLimit: baseline.used } }).reached, true);
    assert.equal(measurePromptAgentContext({ model: { autoCompactTokenLimit: baseline.used + 1 } }).reached, false);
    assert.equal(measurePromptAgentContext({ model: { autoCompactTokenLimit: NaN } }).threshold, 12000);
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
