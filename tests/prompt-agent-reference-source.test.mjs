import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentReferenceSource } from '../js/features/prompt-agent/prompt-agent-reference-source.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
const image = { name: '图片', dataUrl: 'data:image/png;base64,AAAA' };

test('import exposes its source identity before saving so canvas deletion cancels late references', async () => {
    const state = { nodes: new Map() };
    let pendingNodeId, finishSave;
    let current = true;
    const source = createPromptAgentReferenceSource({ state,
        nodeAdapter: { getSceneReferenceImages: () => { assert.fail('deleted source must not be read'); } },
        createImportNode: () => { state.nodes.set('created', { id: 'created', type: 'ImageImport' }); return 'created'; },
        loadImageData: () => { assert.equal(pendingNodeId, 'created'); return new Promise(resolve => { finishSave = resolve; }); }
    });
    const importing = source.importReference({}, { isCurrent: () => current, read: async () => image,
        onSourceNode: (id) => { pendingNodeId = id; }
    });
    await Promise.resolve();
    state.nodes.delete(pendingNodeId);
    current = false;
    finishSave(true);
    assert.equal(await importing, null);
    assert.equal(state.nodes.size, 0);
});
function harness() {
    const state = { nodes: new Map() };
    let creates = 0, reads = 0, fail = false;
    const source = createPromptAgentReferenceSource({ state,
        nodeAdapter: { getSceneReferenceImages: () => [...state.nodes.values()].map(node => ({ referenceId: `node:${node.id}`, sourceNodeId: node.id })), readSceneReferenceImage: async ref => ({ ...image, ...ref }) },
        getHistoryMetadata: async () => [{id:1,mediaType:'image',timestamp:1},{id:2,mediaType:'video',timestamp:3},{id:3,mediaType:'image',timestamp:2}],
        getHistoryEntry: async () => { reads++; return {image:image.dataUrl}; }, getImageAsset: async () => 'thumbnail',
        createImportNode: () => { const id=String(++creates); state.nodes.set(id,{id,type:'ImageImport'}); return id; },
        loadImageData: async id => { if(fail) return false; state.nodes.get(id).imageImportAssetKey='media:image'; return true; }
    });
    return {source,state,get creates(){return creates;},get reads(){return reads;},fail: value=>{fail=value;}};
}
test('history catalog only includes images in descending order without loading originals',async()=>{
    const h=harness();assert.deepEqual((await h.source.listHistory()).map(x=>x.historyId),['3','1']);assert.equal(h.reads,0);
});
test('history imports reuse unchanged persisted nodes but never changed or deleted nodes',async()=>{
    const h=harness(), options={isCurrent:()=>true};
    const first=await h.source.importReference({historyId:'1'},options);
    h.state.nodes.set('1',JSON.parse(JSON.stringify(h.state.nodes.get('1'))));
    const second=await h.source.importReference({historyId:'1'},options);
    assert.equal(first.sourceNodeId,second.sourceNodeId);assert.equal(h.creates,1);assert.equal(h.reads,1);
    h.state.nodes.get('1').imageImportAssetKey='media:changed';
    await h.source.importReference({historyId:'1'},options);assert.equal(h.creates,2);
    h.state.nodes.delete('2');await h.source.importReference({historyId:'1'},options);assert.equal(h.creates,3);
});
test('save retry reuses its node and already-read file',async()=>{
    const h=harness(), candidate={name:'file'};let reads=0;
    const options={isCurrent:()=>true,read:async()=>{reads++;return image;}};
    h.fail(true);await assert.rejects(h.source.importReference(candidate,options),/保存失败/);
    h.fail(false);const result=await h.source.importReference(candidate,options);
    assert.equal(h.creates,1);assert.equal(reads,1);assert.equal(result.sourceNodeId,'1');
});
test('cancelled reading cannot create nodes or references',async()=>{
    const h=harness();let current=true,finish;
    const pending=h.source.importReference({}, {isCurrent:()=>current,read:()=>new Promise(resolve=>{finish=resolve;})});
    current=false;finish(image);assert.equal(await pending,null);assert.equal(h.creates,0);
});
test('preview reads originals without importing nodes',async()=>{
    const h=harness();assert.equal((await h.source.readHistory({historyId:'1'})).dataUrl,image.dataUrl);assert.equal(h.creates,0);
});
test('history origin and image identity are serialized with the import node for reopening and undo',async()=>{
    const h=harness();await h.source.importReference({historyId:'1'},{isCurrent:()=>true});
    const serializer=createNodeSerializer({state:h.state,documentRef:{getElementById:()=>null,querySelectorAll:()=>[]}});
    const nodes=JSON.parse(JSON.stringify(serializer.serializeNodes()));
    assert.deepEqual(nodes[0].agentReferenceSource,{historyId:'1',assetKey:'media:image'});
    h.state.nodes=new Map(nodes.map(node=>[node.id,node]));
    await h.source.importReference({historyId:'1'},{isCurrent:()=>true});assert.equal(h.creates,1);
});
test('a missing history original reports an error without creating a node',async()=>{
    let created=false;
    const source=createPromptAgentReferenceSource({state:{nodes:new Map()},nodeAdapter:{getSceneReferenceImages:()=>[]},getHistoryEntry:async()=>null,createImportNode:()=>{created=true;}});
    await assert.rejects(source.importReference({historyId:'gone'},{isCurrent:()=>true}),/原图缺失/);assert.equal(created,false);
});
