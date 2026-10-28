import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanInputs,projectPlanConnections,referenceManifest,assertPromptOnlyReferenceRecipe} from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';
import { projectImageReferences } from '../js/nodes/image-reference-projection.js';
const link=(source,port,order)=>({from:{ref:source,port:'image'},to:{ref:'g',port},order});
test('canonical input replacement keeps the whole ordered batch and removes legacy stale edges',()=>{
 const plan=normalizePlanInputs({steps:[{id:'g',type:'ImageGenerate'}],connections:[link('b','image_2'),link('a','image_1')]});
 const old=[{from:{nodeId:'old',port:'image'},to:{nodeId:'g',port:'image_1'}}];
 const projected=projectPlanConnections(plan,old,id=>id);
 assert.equal(projected.length,2);
 const nodes=['a','b'].map(id=>({id,type:'ImageImport',assets:[id+'-asset']}));
 const manifest=referenceManifest(nodes,projected,['g']);
 assert.deepEqual(manifest[0].inputs.map(i=>i.assets),[['a-asset'],['b-asset']]);
 assert.deepEqual(projectPlanConnections(plan,projected,id=>id),projected);
 assert.deepEqual(referenceManifest([{...nodes[0],enabled:false},nodes[1]],projected,['g'])[0].inputs.map(input=>input.nodeId),['b']);
 assert.throws(()=>referenceManifest(nodes.slice(1),projected,['g']),/删除/);
 const pure={steps:plan.steps,connections:[],disconnects:[{ref:'g',port:'referenceImages'}]};
 assert.deepEqual(projectPlanConnections(pure,projected,id=>id),[]);
});


test('disabled sources remain connected but do not enter the active reference manifest',()=>{
 const nodes=[{id:'a',type:'ImageImport',enabled:false,missing:true,assets:[]},{id:'b',type:'ImageImport',enabled:true,assets:['media:b']}];
 const connections=['a','b'].map((id,order)=>({from:{nodeId:id,port:'image'},to:{nodeId:'g',port:'referenceImages'},order}));
 assert.deepEqual(referenceManifest(nodes,connections,['g'])[0].inputs.map(input=>input.nodeId),['b']);
 assert.equal(connections.length,2,'the disabled connection is retained for later re-enabling');
});


test('a previously created and now bound target retains source identity even for identical asset pixels',()=>{
 const context={nodes:[{id:'B',type:'ImageImport',assets:['media:same']},{id:'T',type:'ImageGenerate',assets:[]}],connections:[{from:{nodeId:'B',port:'image'},to:{nodeId:'T',port:'referenceImages'},order:0}]};
 const previous={id:'p',steps:[{id:'g',type:'ImageGenerate'}],bindings:{g:'T'},connections:[],referenceManifest:[{nodeId:'T',inputs:[{nodeId:'A',port:'image',assets:['media:same']}]}]};
 const next={id:'n',steps:[{id:'g',nodeId:'T',type:'ImageGenerate'}],bindings:{},connections:[]};
 assert.throws(()=>assertPromptOnlyReferenceRecipe(previous,next,context),/来源|参考图/);
});

test('repeating unchanged reference sources preserves their original edges, endpoints, orders and JSON extensions', () => {
 const old=[{id:'legacy-edge',type:'image',order:7,extension:{keep:['edge']},from:{nodeId:'a',port:'image',extension:{keep:'from'}},to:{nodeId:'g',port:'image_2',extension:{keep:'to'}}},
  {id:'prompt-edge',from:{nodeId:'text',port:'text'},to:{nodeId:'g',port:'prompt'},extension:{keep:'unrelated'}}];
 const plan=normalizePlanInputs({steps:[{id:'g',type:'ImageGenerate'}],connections:[link('a','referenceImages',0)]});
 assert.deepEqual(projectPlanConnections(plan,old,id=>id),old);
});

test('Agent manifests follow the same legacy and canonical connection order as the complete canvas references', () => {
 const nodes=['legacy','canonical','g'].map(id=>({id,type:id==='g'?'ImageGenerate':'ImageImport',assets:[`media:${id}`],data:{mediaAssetKeys:[`media:${id}`]}}));
 const connections=[{id:'old',from:{nodeId:'legacy',port:'image'},to:{nodeId:'g',port:'image_2'}},
  {id:'new',from:{nodeId:'canonical',port:'image'},to:{nodeId:'g',port:'referenceImages'},order:0}];
 const state={nodes:new Map(nodes.map(node=>[node.id,node])),connections};
 assert.deepEqual(referenceManifest(nodes,connections,['g'])[0].inputs.map(input=>input.nodeId),
  projectImageReferences({state,targetId:'g'}).groups.map(group=>group.source.id));
 const repeated=normalizePlanInputs({steps:[{id:'g',type:'ImageGenerate'}],connections:[link('legacy','image_2'),link('canonical','referenceImages',0)]});
 assert.deepEqual(projectPlanConnections(repeated,connections,id=>id),connections);
});

test('plan input normalization does not impose a protocol-independent source limit', () => {
 const plan={steps:[{id:'g',type:'ImageGenerate'}],connections:Array.from({length:65},(_,index)=>link(`s${index}`,'referenceImages',index))};
 assert.equal(normalizePlanInputs(plan).connections.length,65);
});
