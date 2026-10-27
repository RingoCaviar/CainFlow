import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanInputs,projectPlanConnections,referenceManifest,assertPromptOnlyReferenceRecipe} from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';
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
