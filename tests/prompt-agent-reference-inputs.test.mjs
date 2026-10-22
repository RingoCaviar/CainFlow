import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanInputs,projectPlanConnections,referenceManifest} from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';
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
 assert.throws(()=>referenceManifest([{...nodes[0],enabled:false},nodes[1]],projected,['g']),/禁用/);
 assert.throws(()=>referenceManifest(nodes.slice(1),projected,['g']),/删除/);
 const pure={steps:plan.steps,connections:[],disconnects:[{ref:'g',port:'referenceImages'}]};
 assert.deepEqual(projectPlanConnections(pure,projected,id=>id),[]);
});
