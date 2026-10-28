import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';
import { readPromptAgentParameterSchema } from '../js/features/prompt-agent/prompt-agent-parameters.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { createCanvasContext } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { createPromptAgentModelReply } from '../js/features/prompt-agent/prompt-agent-model.js';

function fixture(source = {}) {
 const target={id:'target',type:'ImageGenerate',apiConfigId:'image',providerId:'provider',data:{prompt:'local draft'}};
 const upstream={id:'source',type:'Text',customTitle:'真实文案',data:{text:'upstream prompt'},...source};
 const edge={id:'prompt-edge',from:{nodeId:'source',port:'text'},to:{nodeId:'target',port:'prompt'},extension:{keep:true}};
 const state={nodes:new Map([[target.id,target],[upstream.id,upstream]]),connections:[edge],models:[],providers:[],selectedNodes:new Set([target.id])};
 const adapter=createPromptAgentNodeAdapter({state,documentRef:{getElementById:()=>null},getCachedOutputValue:node=>node.data.text});
 return {target,upstream,edge,state,adapter};
}

test('Agent context identifies the effective upstream text and keeps the local draft separate', () => {
 const {adapter,target}=fixture();
 const context=adapter.getContext(target.id);
 assert.equal(context.prompt,'upstream prompt');
 assert.equal(context.localPrompt,'local draft');
 assert.deepEqual(context.promptSource,{nodeId:'source',port:'text',type:'Text',name:'真实文案',text:'upstream prompt',editable:true,active:true,connected:true});
});

test('legacy application rejects an ineffective local prompt change before model or graph mutation', () => {
 const {adapter,target,state,edge}=fixture();
 assert.throws(()=>adapter.applyPromptPlan({targetNodeId:target.id,prompt:'ineffective local replacement'}),/来源|上游|主提示词/);
 assert.equal(target.data.prompt,'local draft');
 assert.deepEqual(state.connections,[edge]);
 assert.throws(()=>adapter.ensureTarget({targetNodeId:target.id,prompt:'ineffective local replacement'},{modelId:'changed'}),/来源|上游|主提示词/);
 assert.equal(target.apiConfigId,'image');
 assert.equal(adapter.applyPromptPlan({targetNodeId:target.id,prompt:'upstream prompt',parameters:{}}),true);
 assert.equal(target.data.prompt,'local draft');
 assert.equal(adapter.applyPromptPlan({targetNodeId:target.id,parameters:{}}),true);
 assert.equal(target.data.prompt,'local draft');
});

test('derived, cloned and unsupported prompt sources stay read-only while empty or disabled sources retain execution fallback', () => {
 for(const source of [{type:'CameraControl'},{isClone:true},{type:'TextChat'}]) {
  const {adapter,target}=fixture(source), context=adapter.getContext(target.id);
  assert.equal(context.promptSource.editable,false);
  assert.equal(context.prompt,'upstream prompt');
  assert.throws(()=>adapter.applyPromptPlan({targetNodeId:target.id,prompt:'local replacement'}),/真实来源|主提示词/);
 }
 for(const source of [{enabled:false},{data:{text:''}}]) {
  const {adapter,target}=fixture(source), context=adapter.getContext(target.id);
  assert.equal(context.promptSource.active,false);
  assert.equal(context.promptSource.connected,true);
  assert.equal(context.prompt,'local draft');
 }
 const {adapter,target}=fixture();target.isClone=true;
 assert.throws(()=>adapter.applyPromptPlan({targetNodeId:target.id,prompt:'upstream prompt'}),/只读/);
 assert.equal(target.data.prompt,'local draft');
});

function parkedFixture() {
 const parking={hidden:true,parentElement:null}, form={parentElement:parking}, field={parentElement:form,hidden:false};
 const quality={id:'target-quality',type:'select-one',value:'auto',parentElement:field,options:[{value:'auto'},{value:'high'}],dispatchEvent(){},closest:()=>parking};
 const custom={id:'target-param-steps',type:'number',value:'12',min:'1',max:'30',parentElement:form,dispatchEvent(){},closest:()=>parking};
 const controls=[quality,custom];
 form.querySelector=selector=>controls.find(control=>selector===`[id="${control.id}"]`||selector===`#${control.id}`)||null;
 form.querySelectorAll=()=>controls;
 const root={querySelector:()=>null,querySelectorAll:()=>[]};
 const target={id:'target',type:'ImageGenerate',el:root,parameterRoot:form,data:{prompt:'draft',quality:'auto',protocolParams:{steps:12}}};
 const state={nodes:new Map([[target.id,target]]),connections:[]};
 const documentRef={getElementById:id=>id==='target-quality'?{...quality,value:'wrong workflow',options:[{value:'wrong workflow'}],closest:()=>null}:id==='target'?root:null};
 return {target,state,documentRef,quality,custom,field};
}

test('parked parameter controls retain their real schema and protocol fields while internal capability hiding remains effective', () => {
 const {target,documentRef,field}=parkedFixture();
 const schema=readPromptAgentParameterSchema(documentRef,target.id,target);
 assert.deepEqual(schema.quality.enum,['auto','high']);
 assert.deepEqual(schema.protocolParams.properties.steps,{type:'number',minimum:1,maximum:30});
 field.hidden=true;
 assert.equal(readPromptAgentParameterSchema(documentRef,target.id,target).quality,undefined);
 field.dataset={parameterGroup:'size'};
 assert.deepEqual(readPromptAgentParameterSchema(documentRef,target.id,target).quality.enum,['auto','high']);
});

test('the adapter reads and applies parked scoped controls without reading another workflow control with the same ID', () => {
 const {target,state,documentRef,quality,custom}=parkedFixture();
 const adapter=createPromptAgentNodeAdapter({state,documentRef,createEvent:type=>({type})});
 assert.equal(adapter.getContext(target.id).parameters.quality,'auto');
 assert.equal(adapter.applyPromptPlan({targetNodeId:target.id,prompt:'new draft',parameters:{quality:'high',protocolParams:{steps:21}}}),true);
 assert.equal(quality.value,'high');assert.equal(custom.value,'21');
 assert.equal(target.data.quality,'high');assert.equal(target.data.protocolParams.steps,21);
 assert.equal(documentRef.getElementById(quality.id).value,'wrong workflow');
});

test('reference application follows the selected protocol and counts complete source batches before mutation', () => {
 const protocol=capacity=>({id:'agent-reference-capacity',label:'capacity fixture',taskTypes:['image'],parameters:{referenceImages:{id:'referenceImages',inputPort:true,portType:'image',portCount:capacity,portOnly:true}}});
 registerProtocol(protocol(70));
 const {adapter,target,state}=fixture();state.connections=[];
 state.models=[{id:'image',modelId:'fixture',protocol:'agent-reference-capacity',taskType:'image'}];
 const referenceImages=Array.from({length:65},(_,index)=>{
  const id=`image-${index}`;state.nodes.set(id,{id,type:'ImageImport',data:{mediaAssetKeys:[`media:${index}`],image:'data:image/png;base64,AAAA'}});
  return {sourceNodeId:id,sourcePort:'image'};
 });
 assert.equal(adapter.applyPromptPlan({targetNodeId:target.id,prompt:'wide protocol',referenceImages}),true);
 assert.equal(state.connections.length,65);
 registerProtocol(protocol(2));
 const source=state.nodes.get('image-0');source.data.mediaAssetKeys=['media:0','media:1','media:2'];source.data.imageList=['first','second','third'];
 const previous=structuredClone(state.connections),prompt=target.data.prompt;
 assert.throws(()=>adapter.applyPromptPlan({targetNodeId:target.id,prompt:'must not change',referenceImages:[referenceImages[0]]}),/2.*3|批次/);
 assert.deepEqual(state.connections,previous);assert.equal(target.data.prompt,prompt);
});

test('explicit target mentions hydrate mixed reference ports in the same order as the actual multimodal request', async () => {
 const nodes=[{id:'legacy',type:'ImageImport',mediaAssetKeys:['media:legacy']},{id:'canonical',type:'ImageImport',mediaAssetKeys:['media:canonical']},{id:'target',type:'ImageGenerate',prompt:'draft'}];
 const connections=[{from:{nodeId:'legacy',port:'image'},to:{nodeId:'target',port:'image_2'}},{from:{nodeId:'canonical',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}];
 const reads=[],requests=[],pixels={'media:legacy':'data:image/png;base64,bGVnYWN5','media:canonical':'data:image/png;base64,Y2Fub25pY2Fs'};
 await createPromptAgentModelReply({message:'@图片生成[target] 只讨论当前引用',canvasContext:createCanvasContext({workflowId:'w',nodes,connections,mentionedIds:['target']}),
  model:{id:'chat',modelId:'fixture',protocol:'openai',providerIds:['p'],autoCompactTokenLimit:100000},providerId:'p',providers:[{id:'p',endpoint:'https://controlled.test',apikey:'fixture'}],
  getCanvasImage:async key=>{reads.push(key);return pixels[key]},fetchRef:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'chat',message:'已读取'})}}]}))}});
 assert.deepEqual(reads,['media:legacy','media:canonical']);
 assert.deepEqual(requests[0].messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='image_url').map(part=>part.image_url.url),Object.values(pixels));
});
