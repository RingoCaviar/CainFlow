import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageGenerationRevisionApi } from '../js/nodes/image-generation-revision.js';
import { registerProtocol } from '../js/features/execution/protocols/index.js';
import { OpenaiProtocol } from '../js/features/execution/protocols/openai.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
import { serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';

function fixture() {
 const node={id:'target',type:'ImageGenerate',apiConfigId:'image',providerId:'provider',data:{prompt:'initial prompt',generationCount:1,resolution:'auto'}};
 const state={activeWorkflowId:'workflow-a',nodes:new Map([[node.id,node]]),connections:[],models:[{id:'image',modelId:'model',protocol:'openai',providerIds:['provider']}],providers:[{id:'provider',endpoint:'https://controlled.test',apikey:'fixture'}]};
 const documentRef={getElementById:()=>null,querySelectorAll:()=>[]};
 const api=createImageGenerationRevisionApi({state,documentRef,getActiveWorkflowId:()=>state.activeWorkflowId,getCachedOutputValue:node=>node.data.text});
 return {node,state,documentRef,api};
}

test('legacy nodes initialize clean without invented successful settings and retain unsent edits across restoration',()=>{
 const {node,api,state,documentRef}=fixture();
 api.initializeNode(node.id);
 assert.equal(node.generationDirty,false);
 assert.equal(node.data.generationRevision,undefined);
 node.data.prompt='changed prompt';api.onSettingsChanged(node.id);
 assert.equal(node.generationDirty,true);
 assert.equal(node.data.generationRevision.dirty,true);
 assert.equal(node.data.generationRevision.successFingerprint,undefined);
 const restored={...node,data:structuredClone(node.data)};state.nodes.set(node.id,restored);
 const reopened=createImageGenerationRevisionApi({state,documentRef});reopened.initializeNode(node.id);
 assert.equal(restored.generationDirty,true);
 assert.ok(JSON.stringify(restored.data.generationRevision).length<200);
});

test('only effective input identities and recipes mark pending, without reading pixels or browsing presentation',()=>{
 const {node,state,api}=fixture();
 const source={id:'source',type:'ImageGenerate',data:{mediaAssetKeys:['media:one','media:two'],imageCount:2},imagePreviewIndex:0};
 Object.defineProperty(source,'imageData',{get(){throw Error('pixels must not be read')}});
 state.nodes.set(source.id,source);state.connections.push({id:'ref',type:'image',order:0,from:{nodeId:source.id,port:'image'},to:{nodeId:node.id,port:'referenceImages'}});
 api.initializeNode(node.id);
 source.imagePreviewIndex=1;node.x=800;node.customTitle='renamed';state.providers[0].apikey='changed secret';source.customTitle='renamed source';
 api.observeAll();assert.equal(node.generationDirty,false);
 source.data.mediaAssetKeys=['media:replacement','media:two'];api.observeAll();
 assert.equal(node.generationDirty,true);
 assert.ok(JSON.stringify(node.data.generationRevision).length<200);
});

test('only a complete successful attempt for the captured node and recipe clears pending settings',()=>{
 const {node,state,api}=fixture();api.initializeNode(node.id);
 node.data.prompt='edited';api.onSettingsChanged(node.id);
 const failed=api.beginAttempt(node,{});api.completeAttempt(failed,{succeeded:false});assert.equal(node.generationDirty,true);
 const partial=api.beginAttempt(node,{});api.completeAttempt(partial,{succeeded:true,partial:true});assert.equal(node.generationDirty,true);
 const old=api.beginAttempt(node,{});node.data.prompt='edited again';api.onSettingsChanged(node.id);
 api.completeAttempt(old,{succeeded:true});assert.equal(node.generationDirty,true);
 const successful=api.beginAttempt(node,{});assert.equal(api.completeAttempt(successful,{succeeded:true}),true);
 assert.equal(node.generationDirty,false);assert.match(node.data.generationRevision.successFingerprint,/^gen1-/);
 const late=api.beginAttempt(node,{}),replacement={...node,data:{...node.data,prompt:'workflow-b'}};
 state.nodes.set(node.id,replacement);state.activeWorkflowId='workflow-b';
 assert.equal(api.completeAttempt(late,{succeeded:true}),false);assert.equal(replacement.data.prompt,'workflow-b');
});

test('reference descriptions affect the actual prompt while source titles remain presentation',()=>{
 const {node,state,api}=fixture();const source={id:'source',type:'ImagePreview',data:{mediaAssetKeys:['media:one','media:two'],imageCount:2,imageDescriptions:['red scene','blue scene']}};
 state.nodes.set(source.id,source);state.connections.push({id:'ref',from:{nodeId:source.id,port:'image'},to:{nodeId:node.id,port:'referenceImages'}});
 api.initializeNode(node.id);source.customTitle='renamed';api.observeAll();assert.equal(node.generationDirty,false);
 source.data.imageDescriptions[1]='blue scene with a mountain';api.observeAll();assert.equal(node.generationDirty,true);
});

test('an active upstream prompt masks the local protocol prompt draft and inactive variant drafts',()=>{
 registerProtocol({...OpenaiProtocol,id:'revision-variant',parameters:{...OpenaiProtocol.parameters,unusedDraft:{id:'unusedDraft',dataType:'string'}},variants:{model:{parameters:{unusedDraft:null}}}});
 const {node,state,api}=fixture();state.models[0].protocol='revision-variant';node.data.protocolParams={prompt:'old local',systemPrompt:'system',unusedDraft:'old'};
 const source={id:'text',type:'Text',data:{text:'effective prompt'}};state.nodes.set(source.id,source);
 state.connections.push({id:'prompt',from:{nodeId:source.id,port:'text'},to:{nodeId:node.id,port:'prompt'}});
 api.initializeNode(node.id);node.data.prompt='unused local';node.data.protocolParams.prompt='unused protocol local';node.data.protocolParams.unusedDraft='new';api.observeAll();
 assert.equal(node.generationDirty,false);
 source.data.text='effective changed';api.observeAll();assert.equal(node.generationDirty,true);
});

test('same-length inline custom-parameter values have distinct small identities without storing media',()=>{
 const {node,state,api}=fixture();const source={id:'params',type:'CustomParams',data:{text:{image:'data:image/png;base64,AAAA'}}};state.nodes.set(source.id,source);
 state.connections.push({id:'params',from:{nodeId:source.id,port:'params'},to:{nodeId:node.id,port:'params'}});
 api.initializeNode(node.id);source.data.text.image='data:image/png;base64,BBBB';api.observeAll();assert.equal(node.generationDirty,true);
 assert.ok(JSON.stringify(node.data.generationRevision).length<200);assert.ok(!JSON.stringify(node.data.generationRevision).includes('base64'));
});

test('visible and background workflow serializers persist only the validated minimal revision',()=>{
 const {node,state,documentRef,api}=fixture();node.el={offsetWidth:400,offsetHeight:300,querySelector:()=>null};
 api.initializeNode(node.id);node.data.prompt='unsent';api.onSettingsChanged(node.id);
 const saved=createNodeSerializer({state,documentRef}).serializeNodes();
 assert.deepEqual(saved[0].generationRevision,{version:1,dirty:true});
 assert.deepEqual(serializeRuntimeNode(node,documentRef).generationRevision,saved[0].generationRevision);
 node.data.generationRevision={version:99,dirty:true,untrustedParameters:{prompt:'history'}};
 assert.equal(createNodeSerializer({state,documentRef}).serializeNodes()[0].generationRevision,undefined);
 assert.equal(serializeRuntimeNode(node,documentRef).generationRevision,undefined);
});

test('node-bound initialization before restored connections cannot turn a trusted clean workflow dirty',()=>{
 const {node,state,documentRef,api}=fixture();const source={id:'source',type:'ImagePreview',data:{mediaAssetKeys:['media:original'],imageCount:1}};
 const edge={id:'ref',from:{nodeId:source.id,port:'image'},to:{nodeId:node.id,port:'referenceImages'}};state.nodes.set(source.id,source);state.connections.push(edge);
 api.observeAll({initialize:true});const token=api.beginAttempt(node,{});assert.equal(api.completeAttempt(token,{succeeded:true}),true);
 const restored={...node,data:structuredClone(node.data)};state.nodes.set(node.id,restored);state.connections=[];
 const reopened=createImageGenerationRevisionApi({state,documentRef});reopened.initializeNode(node.id);
 state.connections.push(edge);reopened.observeAll({initialize:true});
 assert.equal(restored.generationDirty,false);assert.equal(restored.data.generationRevision.dirty,false);
});

test('a replaced active media operation cannot confirm the previous recipe on the same node object',()=>{
 const {node,api}=fixture();api.initializeNode(node.id);node.data.prompt='pending';api.onSettingsChanged(node.id);
 node.activeMediaOperationId='first-operation';const token=api.beginAttempt(node,{}, {runToken:node.activeMediaOperationId});
 node.activeMediaOperationId='replacement-operation';assert.equal(api.completeAttempt(token,{succeeded:true}),false);
 assert.equal(node.generationDirty,true);assert.equal(node.data.generationRevision.successFingerprint,undefined);
});

test('background snapshots retain shared single and batch reference annotations',()=>{
 const {node,documentRef}=fixture();node.type='ImageImport';node.data.imageDescription='first original';node.data.imageDescriptions=['first original','second original'];
 const result=serializeRuntimeNode(node,documentRef);
 assert.equal(result.imageDescription,'first original');assert.deepEqual(result.imageDescriptions,['first original','second original']);
});
