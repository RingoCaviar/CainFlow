import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createWorkflowRunnerApi } from '../js/features/execution/workflow-runner.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { OpenaiProtocol } from '../js/features/execution/protocols/openai.js';

const noop=()=>{};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const registerCapacity=capacity=>registerProtocol({...OpenaiProtocol,id:'wide-image-references',label:'controlled wide image protocol',
 parameters:{...OpenaiProtocol.parameters,referenceImages:{...OpenaiProtocol.parameters.referenceImages,portCount:capacity}}});
const element=()=>({style:{},dataset:{},classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({width:240}),setAttribute:noop,removeAttribute:noop});

function fixture() {
 registerCapacity(70);
 const images=Array.from({length:65},(_,index)=>`data:image/png;base64,${Buffer.from(`original-${index}`).toString('base64')}`);
 const source=(id,values)=>({id,type:'ImagePreview',enabled:true,data:{imageList:values,mediaAssetKeys:values.map((_value,index)=>`media:${id}-${index}`),imageCount:values.length},el:element()});
 const first=source('first',images.slice(0,33)),second=source('second',images.slice(33));
 const target={id:'target',type:'ImageGenerate',enabled:true,apiConfigId:'image',providerId:'provider',data:{prompt:'full ordered originals',resolution:'auto',generationCount:1},el:element()};
 const connections=[{id:'second-edge',type:'image',order:1,from:{nodeId:second.id,port:'image'},to:{nodeId:target.id,port:'referenceImages'},extension:{keep:'second'}},
  {id:'first-edge',type:'image',order:0,from:{nodeId:first.id,port:'image'},to:{nodeId:target.id,port:'referenceImages'},extension:{keep:'first'}}];
 const state={nodes:new Map([first,second,target].map(node=>[node.id,node])),connections,selectedNodes:new Set([target.id]),canvas:{zoom:1,x:0,y:0},requestTimeoutEnabled:false,
  models:[{id:'image',modelId:'controlled-image',name:'wide image',protocol:'wide-image-references',providerIds:['provider'],taskType:'image'}],providers:[{id:'provider',name:'fixture',endpoint:'https://controlled.test/v1',apikey:'fixture-key'}]};
 const documentRef={getElementById:id=>id==='target-apiconfig'?{value:'image'}:id==='target-provider'?{value:'provider'}:id==='target-prompt'?{value:'full ordered originals'}:null,
  querySelectorAll:()=>[],defaultView:{requestAnimationFrame:callback=>callback()}};
 const requests=[];
 const core=createExecutionCoreApi({state,nodeConfigs:{},documentRef,windowRef:{requestAnimationFrame:callback=>callback()},
  fetchRef:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({data:[{b64_json:png}]}),{headers:{'Content-Type':'application/json'}})},
  getProxyHeaders:()=>({}),showToast:noop,addLog:noop,logRequestToPanel:noop,recordNodeRequest:noop,saveHistoryEntry:async()=>true,
  refreshDependentImageResizePreviews:async()=>{},fitNodeToContent:noop,scheduleSave:noop,getAbortMessage:()=>''});
 const runner=createWorkflowRunnerApi({state,nodeConfigs:{ImageGenerate:{title:'image',outputs:[{name:'image',type:'image'}]}},documentRef,confirmRef:()=>true,
  normalizeRunOptions:core.normalizeRunOptions,resolveExecutionPlan:core.resolveExecutionPlan,getCachedOutputValue:core.getCachedOutputValue,executeNode:core.executeNode,
  showToast:noop,addLog:noop,scheduleSave:noop,updatePortStyles:noop,getAbortMessage:()=>'',playNotificationSound:noop});
 return {core,runner,state,target,first,second,images,requests};
}

test('cached request preview collects all 65 originals for a capacity-70 image protocol and validates smaller real capacity',()=>{
 const {core,state,target,images}=fixture(),connections=structuredClone(state.connections);
 assert.deepEqual(core.buildNodeRequestPreview(target.id).requestBody.reference_images,images);
 registerCapacity(64);
 assert.throws(()=>core.buildNodeRequestPreview(target.id),/64.*65/);
 assert.deepEqual(state.connections,connections);
});

test('the public workflow runner sends the complete ordered 65-image input to the controlled provider and preserves rejected graphs',async()=>{
 const {runner,state,target,first,second,images,requests}=fixture(),connections=structuredClone(state.connections);
 const run=()=>runner.runWorkflow({mode:'selected-only',selectedNodeIds:[target.id]});
 const result=await run();
 assert.equal(result.reason,'finished',target.executionFailure?.message);
 assert.equal(target.isFailed,false,target.executionFailure?.message);
 assert.equal(requests.length,1,target.executionFailure?.message);
 assert.deepEqual(requests[0].reference_images,images);
 assert.deepEqual(first.data.imageList,images.slice(0,33));assert.deepEqual(second.data.imageList,images.slice(33));
 assert.deepEqual(state.connections,connections);
 registerCapacity(64);requests.length=0;
 await run();
 assert.equal(requests.length,0);
 assert.match(target.executionFailure?.message||'',/64.*65/);
 assert.deepEqual(state.connections,connections);
 assert.deepEqual([...first.data.imageList,...second.data.imageList],images);
});

for(const type of ['VideoGenerate','TextChat']) test(`${type} retains its existing aggregation limit in cached preview and public workflow execution`,async()=>{
 const {core,runner,target,requests,state}=fixture(),connections=structuredClone(state.connections);target.type=type;
 assert.throws(()=>core.buildNodeRequestPreview(target.id),/最多接收 64 张/);
 await runner.runWorkflow({mode:'selected-only',selectedNodeIds:[target.id]});
 assert.match(target.executionFailure?.message||'',/最多接收 64 张/);
 assert.equal(requests.length,0);assert.deepEqual(state.connections,connections);
});
