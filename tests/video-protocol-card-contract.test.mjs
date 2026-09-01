import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bindings = await readFile(new URL('../js/nodes/node-dom-bindings.js', import.meta.url), 'utf8');
const execution = await readFile(new URL('../js/features/execution/async-media-execution.js', import.meta.url), 'utf8');

test('declared video variants render prompt parameters and replace legacy video inputs', () => {
    const videoProtocolParams = bindings.match(/const VIDEO_GENERATE_STANDARD_PROTOCOL_PARAMS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    assert.doesNotMatch(videoProtocolParams, /'prompt'/);
    assert.match(bindings, /promptField\.classList\.toggle\('hidden', hasVariantMismatch \|\| Boolean\(declaredVariant\?\.parameters\?\.prompt/);
    assert.match(bindings, /aspectField\.classList\.toggle\('hidden', Boolean\(declaredVariant\)\)/);
    assert.match(bindings, /port\.classList\.toggle\('hidden', usesDeclaredReferenceImages\)/);
    assert.match(execution, /documentRef\.getElementById\(`\$\{id\}-param-prompt`\)\?\.value/);
});

test('an unmatched declared video variant renders an actionable safe state', () => {
    assert.match(bindings, /当前协议未配置此模型变体；请更换模型或在协议编辑器中补齐变体。/);
});
