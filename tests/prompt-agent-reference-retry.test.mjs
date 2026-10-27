import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptAgentCanvasAdapter } from '../js/features/prompt-agent/prompt-agent-canvas-adapter.js';
import { createCanvasContext, canvasBaseline, canvasPlanExecutionNodeIds } from '../js/features/prompt-agent/prompt-agent-canvas-context.js';
import { referenceManifest } from '../js/features/prompt-agent/prompt-agent-reference-inputs.js';

function fixture(run) {
    const nodes=[{id:'S',type:'ImageGenerate',prompt:'subject',mediaAssetKeys:['media:original']},{id:'T',type:'ImageGenerate',prompt:'target'}];
    const connections=[{from:{nodeId:'S',port:'image'},to:{nodeId:'T',port:'referenceImages'},order:0}];
    const state={nodes:new Map(nodes.map(node=>[node.id,node])),connections,selectedNodes:new Set(),runningNodeIds:new Set()};
    const context=()=>createCanvasContext({workflowId:'W',nodes,connections});
    const plan={id:'P',workflowId:'W',steps:[{id:'s',nodeId:'S',type:'ImageGenerate'},{id:'t',nodeId:'T',type:'ImageGenerate'}],bindings:{s:'S',t:'T'},order:['s','t'],dependencies:['S','T'],completedSteps:[]};
    plan.baseline=canvasBaseline(context(),plan.dependencies,['S','T']);
    plan.referenceManifest=referenceManifest(context().nodes,connections,['S','T'],['S','T']);
    const adapter=createPromptAgentCanvasAdapter({state,documentRef:{getElementById:()=>null},serializeNodes:()=>nodes,getWorkflowId:()=> 'W',runWorkflow:run});
    return {nodes,plan,adapter};
}

test('retry refuses a historical completed upstream without a recorded original snapshot',async()=>{
    let started=false;
    const {nodes,plan,adapter}=fixture(async()=>{started=true;});
    plan.completedSteps=['s'];nodes[0].mediaAssetKeys=['media:different'];
    await assert.rejects(adapter.execute(plan,{retry:true}),/上游|参考图/);
    assert.equal(started,false);
});

test('retry records completed upstream assets, survives save reopen, and rejects replacement before starting',async()=>{
    let started=0;
    const {nodes,plan,adapter}=fixture(async (_input,options)=>{
        started++;options.validateBeforeRun();
        return {outcome:started===1?'failed':'completed',nodeResults:[{nodeId:'S',succeeded:started===1},{nodeId:'T',succeeded:started>1,error:started===1?'controlled failure':''}]};
    });
    await adapter.execute(plan);
    assert.deepEqual(plan.completedReferenceOutputs.s,{nodeId:'S',assets:['media:original']});
    plan.completedSteps=['s'];
    const reopened=JSON.parse(JSON.stringify(plan));
    await adapter.execute(reopened,{retry:true});
    assert.equal(started,2,'unchanged original permits retry');
    nodes[0].mediaAssetKeys=['media:different'];
    await assert.rejects(adapter.execute(reopened,{retry:true}),/上游|参考图/);
    assert.equal(started,2,'changed original never reaches the workflow runner');
});


test('a cached source excluded from execution keeps its asset baseline and cannot drift on retry',async()=>{
    let started=0;
    const {nodes,plan,adapter}=fixture(async()=>{started++;return {outcome:'completed',nodeResults:[]};});
    plan.steps[0].execute=false;
    const connections=[{from:{nodeId:'S',port:'image'},to:{nodeId:'T',port:'referenceImages'},order:0}];
    const context=createCanvasContext({workflowId:'W',nodes,connections});
    assert.deepEqual(canvasPlanExecutionNodeIds(plan),['T']);
    plan.baseline=canvasBaseline(context,plan.dependencies,canvasPlanExecutionNodeIds(plan));
    plan.referenceManifest=referenceManifest(context.nodes,connections,['S','T'],canvasPlanExecutionNodeIds(plan));
    await adapter.execute(plan,{retry:true});assert.equal(started,1);
    nodes[0].mediaAssetKeys=['media:changed'];
    await assert.rejects(adapter.execute(plan,{retry:true}),/已变化|参考图/);assert.equal(started,1);
});


test('refreshing validation cannot silently adopt changed reference pixels',()=>{
    const nodes=[{id:'source',type:'ImageImport',mediaAssetKeys:['media:old']},{id:'target',type:'ImageGenerate'}];
    const connections=[{from:{nodeId:'source',port:'image'},to:{nodeId:'target',port:'referenceImages'},order:0}];
    const context=createCanvasContext({workflowId:'W',nodes,connections});
    const plan={id:'P',workflowId:'W',steps:[{id:'g',nodeId:'target',type:'ImageGenerate'}],connections:[],disconnects:[],order:['g'],bindings:{g:'target'},dependencies:['source','target'],runs:[]};
    plan.baseline=canvasBaseline(context,plan.dependencies,['target']);
    const state={nodes:new Map(nodes.map(node=>[node.id,node])),connections,selectedNodes:new Set(),runningNodeIds:new Set()};
    const adapter=createPromptAgentCanvasAdapter({state,documentRef:{getElementById:()=>null},serializeNodes:()=>nodes,getWorkflowId:()=> 'W'});
    adapter.prepare(plan);
    nodes[0].mediaAssetKeys=['media:new'];
    assert.throws(()=>adapter.refresh(plan),/参考图|原图/);
});
