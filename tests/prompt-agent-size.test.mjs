import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePromptAgentParameters } from '../js/features/prompt-agent/prompt-agent-parameters.js';
test('model aspect spelling maps to the same ratio parameter as canvas plans', () => {
 assert.deepEqual(normalizePromptAgentParameters({ aspect: '16:9', resolution: '2K' }), { aspectRatio: '16:9', resolution: '2K' });
});

import * as agentSize from '../js/features/prompt-agent/prompt-agent-size.js';
const { resolveAgentSize, parseSizeAnswer, sizeCapabilities } = agentSize;

test('Agent chooses a compatible preset for a reference image before trying custom dimensions', () => {
    const model = { protocol: 'openai', modelId: 'gpt-image-2' };
    const patch = agentSize.resolveDesiredAgentAspect({ ...model, referenceSize: { width: 1917, height: 1080 },
        defaults: { resolution: '2K', aspectRatio: '1:1' } });
    assert.deepEqual(patch, { resolution: '2K', aspectRatio: '16:9' });
    assert.match(resolveAgentSize({ ...model, parameters: patch }).summary, /2048 × 1152/);

    const withoutTier = agentSize.resolveDesiredAgentAspect({ ...model, aspectRatio: '4:3' });
    assert.deepEqual(withoutTier, { resolution: '1K', aspectRatio: '4:3' });
    assert.match(resolveAgentSize({ ...model, parameters: withoutTier }).summary, /1024 × 768/);
});

test('GPT Image uses legal pixel dimensions when a requested ratio is outside its presets', () => {
    const model = { protocol: 'openai', modelId: 'gpt-image-2' };
    const patch = agentSize.resolveDesiredAgentAspect({ ...model, aspectRatio: '7:5' });
    assert.equal(patch.resolution, 'custom');
    assert.equal(patch.customWidth / patch.customHeight, 7 / 5);
    assert.match(resolveAgentSize({ ...model, parameters: patch }).summary, /自定义/);

    const reference = agentSize.resolveDesiredAgentAspect({ ...model, referenceSize: { width: 1280, height: 800 } });
    assert.deepEqual(reference, { resolution: 'custom', customWidth: 1280, customHeight: 800 });

    const withPanelDefaults = agentSize.resolveDraftImageSize({ ...model, sizeIntent: { aspectRatio: '8:5' },
        defaults: { resolution: '2K', aspectRatio: '1:1' } });
    assert.equal(withPanelDefaults.effective.resolution, 'custom');
    assert.equal(withPanelDefaults.effective.customWidth / withPanelDefaults.effective.customHeight, 8 / 5);
});

test('a ratio-only model approximates a reference and lets the user repair an unavailable exact ratio', () => {
    const model = { protocol: 'google', modelId: 'gemini-2.5-flash-image' };
    const approximate = agentSize.resolveDraftImageSize({ ...model, sizeIntent: { referenceSize: { width: 1600, height: 1000 } } });
    assert.deepEqual(approximate.patch, { aspectRatio: '3:2' });
    assert.equal(approximate.effective.resolution, '');
    assert.equal(sizeCapabilities(model.protocol, model.modelId).customDimensions, undefined);

    const exact = { ...model, sizeIntent: { aspectRatio: '8:5' } };
    assert.throws(() => agentSize.resolveDraftImageSize(exact), error => error.sizeClarification?.kind === 'aspect'
        && error.sizeClarification.choices.some(option => option.value === '3:2'));
    const answer = parseSizeAnswer('比例16:9');
    assert.equal(agentSize.resolveDraftImageSize({ ...exact, answer }).effective.aspectRatio, '16:9');
    assert.equal(agentSize.resolveDraftImageSize({ ...exact, answer: { aspectRatio: '' } }).effective.aspectRatio, '');
});

test('a model change discards incompatible suggested sizing while preserving explicit dimensions', () => {
    const suggested = { parameters: { resolution: 'custom', customWidth: 1280, customHeight: 800, aspectRatio: '16:9' },
        sources: { resolution: '方案建议', customWidth: '方案建议', customHeight: '方案建议', aspectRatio: '方案建议' } };
    const banana = { protocol: 'google', modelId: 'gemini-2.5-flash-image' };
    assert.deepEqual(agentSize.resolveDraftImageSize({ ...banana, ...suggested }).patch, { aspectRatio: '16:9' });
    assert.throws(() => agentSize.resolveDraftImageSize({ ...banana, parameters: suggested.parameters }), error => error.sizeClarification?.kind === 'dimensions');

    const size = agentSize.resolveDraftImageSize({ protocol: 'openai', modelId: 'gpt-image-2',
        parameters: { resolution: 'custom', customWidth: 1280, customHeight: 800 }, defaults: { resolution: '2K', aspectRatio: '1:1' } });
    assert.match(size.summary, /1280 × 800/);
});

test('the default sizing answer clears incompatible custom dimensions and keeps a usable ratio', () => {
    const model = { protocol: 'google', modelId: 'gemini-3-pro-image' };
    const result = agentSize.resolveDraftImageSize({ ...model, sizeIntent: { aspectRatio: '16:9' },
        parameters: { resolution: 'custom', customWidth: 1280, customHeight: 800 },
        defaults: { resolution: '2K' }, answer: { resolution: '' } });
    assert.deepEqual(result.patch, { resolution: '', aspectRatio: '16:9' });
    assert.equal(result.effective.customWidth, '');
    assert.equal(result.effective.customHeight, '');
});

test('Gemini size answers use the selected model resolution values', () => {
    const flash = { protocol: 'google', modelId: 'gemini-3.1-flash-image' };
    const fixed = { protocol: 'google', modelId: 'gemini-2.5-flash-image' };
    assert.equal(resolveAgentSize({ ...flash, parameters: parseSizeAnswer('用 512px') }).effective.resolution, '512');
    assert.equal(resolveAgentSize({ ...fixed, parameters: parseSizeAnswer('用 1K') }).effective.resolution, '');
    assert.throws(() => resolveAgentSize({ ...fixed, parameters: parseSizeAnswer('用 512px') }), /不支持所选分辨率/);
});
import { createPromptAgentConversationStore } from '../js/features/prompt-agent/prompt-agent-conversation-store.js';
test('automatic asks, a combined change validates the destination, and defaults never overwrite explicit intent', () => {
 assert.throws(() => resolveAgentSize({protocol:'openai',parameters:{aspect:'16:9'}}), error => error.sizeClarification.kind === 'resolution');
 const size=resolveAgentSize({protocol:'openai',current:{resolution:''},defaults:{resolution:'1K',aspectRatio:'1:1'},parameters:{resolution:'2K',aspect:'16:9'}});
 assert.equal(size.effective.resolution,'2K');assert.equal(size.effective.aspectRatio,'16:9');assert.match(size.summary,/2048 × 1152/);
 assert.equal(resolveAgentSize({protocol:'google',parameters:{resolution:'',aspectRatio:'16:9'}}).effective.aspectRatio,'16:9');
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{resolution:'8K'}}),/分辨率/);
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{resolution:'2K',aspectRatio:'8:1'}}),/比例/);
});
test('custom dimensions must match an explicit requested ratio and are not inferred', () => {
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{resolution:'custom',aspectRatio:'3:2'}}),e=>e.sizeClarification.kind==='dimensions');
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{resolution:'custom',customWidth:1024,customHeight:1024,aspectRatio:'3:2'}}),/宽度和高度/);
 assert.match(resolveAgentSize({protocol:'openai',parameters:{resolution:'custom',customWidth:1536,customHeight:1024,aspectRatio:'3:2'}}).summary,/1536 × 1024/);
 assert.deepEqual(parseSizeAnswer('用2K'),{resolution:'2K'});assert.deepEqual(parseSizeAnswer('1536×1024'),{resolution:'custom',customWidth:1536,customHeight:1024});assert.equal(parseSizeAnswer('不要2K，换个场景'),null);
});
test('size preferences keep follow distinct from automatic and persist by model through clear and compact', () => {
 const store=createPromptAgentConversationStore();assert.deepEqual(store.getSize('a'),{});
 store.setSize('a',{resolution:'',aspectRatio:'16:9'});store.setSize('b',{resolution:'2K'});
 store.append({role:'user',text:'hello'});store.compact('summary');store.clear();
 const restored=createPromptAgentConversationStore();restored.restore(store.snapshot());
 assert.deepEqual(restored.getSize('a'),{resolution:'',aspectRatio:'16:9'});assert.deepEqual(restored.getSize('b'),{resolution:'2K'});
 restored.restore({});assert.deepEqual(restored.getSize('a'),{});
});

import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
test('multi-step defaults fill missing fields only and validation precedes all resource preparation', async () => {
 const model={id:'image',modelId:'gpt-image-2',protocol:'openai',taskType:'image',providerIds:['p']};
 let reads=0, creates=0;
 const adapter=createPromptAgentCanvasAdapter({state:{models:[model],providers:[{id:'p',endpoint:'https://test.test',apikey:'key'}],nodes:new Map()},
  documentRef:{getElementById:()=>null},nodeAdapter:{getContext:()=>null},getImageAsset:()=>{reads++;},addNode:()=>{creates++;}});
 const plan={steps:[{id:'a',type:'ImageGenerate',title:'横幅',parameters:{prompt:'a',aspect:'16:9'}},{id:'b',type:'ImageGenerate',title:'方图',parameters:{prompt:'b',aspect:'1:1',resolution:'1K'}}],agentProviders:{image:'p'},agentSizes:{image:{resolution:'2K'}}};
 const sizes=adapter.sizesFor(plan,'image');assert.equal(sizes.a.effective.resolution,'2K');assert.equal(sizes.b.effective.resolution,'1K');
 plan.agentSizes.image.resolution='';assert.throws(()=>adapter.sizesFor(plan,'image'),e=>e.stepId==='a'&&e.sizeClarification.kind==='resolution');
 plan.steps[0].sizeAnswer={resolution:'4K'};assert.equal(adapter.sizesFor(plan,'image').a.effective.resolution,'4K');
 assert.equal(reads,0);assert.equal(creates,0);
});

test('unused explicit dimensions and an unsupported automatic ratio are never silently discarded',()=>{
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{customWidth:1024,customHeight:1024}}),/自定义分辨率/);
 assert.throws(()=>resolveAgentSize({protocol:'openai',parameters:{resolution:'2K',aspectRatio:''}}),/具体比例/);
 const sized=resolveAgentSize({protocol:'openai',defaults:{resolution:'custom',customWidth:1024,customHeight:1024},parameters:{resolution:'2K',aspectRatio:'16:9'}});
 assert.equal(sized.patch.customWidth,undefined);assert.equal(sized.effective.aspectRatio,'16:9');
});

test('Agent size options and plans use the selected OpenAI image model', () => {
    const protocol = 'openai';
    const modelId = 'gpt-image-1.5';
    const options = sizeCapabilities(protocol, modelId);
    assert.deepEqual(options.resolutions.map(option => option.value), ['', '1K']);
    assert.deepEqual(options.aspects.map(option => option.value), ['1:1', '2:3', '3:2']);
    assert.throws(() => resolveAgentSize({ protocol, modelId, parameters: { resolution: '2K' } }), /分辨率/);
    assert.throws(() => resolveAgentSize({ protocol, modelId, parameters: { aspectRatio: '16:9' } }), /不支持所选比例/);

    const old = resolveAgentSize({ protocol, modelId, parameters: { resolution: '1536x1024', aspectRatio: '' } });
    assert.deepEqual(old.patch, { resolution: '1K', aspectRatio: '3:2' });
    assert.match(old.summary, /1536 × 1024/);

    const dimensions = resolveAgentSize({ protocol, modelId, parameters: parseSizeAnswer('1024×1536') });
    assert.deepEqual(dimensions.patch, { resolution: '1K', aspectRatio: '2:3' });
    assert.match(dimensions.summary, /1024 × 1536/);
    assert.deepEqual(parseSizeAnswer('用 512px'), { resolution: '512px' });
    assert.match(resolveAgentSize({ protocol, modelId: 'dall-e-2', parameters: { resolution: '512x512' } }).summary, /512 × 512/);
});
