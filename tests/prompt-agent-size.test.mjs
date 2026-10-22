import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePromptAgentParameters } from '../js/features/prompt-agent/prompt-agent-parameters.js';
test('model aspect spelling maps to the same ratio parameter as canvas plans', () => {
 assert.deepEqual(normalizePromptAgentParameters({ aspect: '16:9', resolution: '2K' }), { aspectRatio: '16:9', resolution: '2K' });
});

import { resolveAgentSize, parseSizeAnswer } from '../js/features/prompt-agent/prompt-agent-size.js';
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
 const model={id:'image',modelId:'gpt-image-1',protocol:'openai',taskType:'image',providerIds:['p']};
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
