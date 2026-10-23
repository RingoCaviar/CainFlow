import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentReferenceSource } from '../js/features/prompt-agent/prompt-agent-reference-source.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';
const image = { name: '图片', dataUrl: 'data:image/png;base64,AAAA' };

test('latest result hydration uses immutable assets, completion order and cancellation fences', async () => {
    const reads = [];
    const source = createPromptAgentReferenceSource({ state: { nodes: new Map() },
        nodeAdapter: { getSceneReferenceImages: () => [] }, getImageAsset: async key => { reads.push(key); return image.dataUrl; } });
    const references = source.getContextReferences({ archivedMessages: [{ runs: [
        { runId: 'older-message-new-run', completionOrder: 5, status: 'completed', mediaAssetKeys: ['media:new'] }
    ] }], messages: [{ runs: [{ runId: 'newer-message-old-run', completionOrder: 3, status: 'completed', mediaAssetKeys: ['media:old'] }] }] });
    const hydrated = await source.hydrateLatestResults(references, { isCurrent: () => true });
    assert.deepEqual(reads, ['media:new']);
    assert.equal(hydrated[0].dataUrl, image.dataUrl);
    assert.equal(hydrated[1].dataUrl, undefined);
    let current = true;
    const cancelled = createPromptAgentReferenceSource({ state: {}, nodeAdapter: {}, getImageAsset: async () => { current = false; return image.dataUrl; } });
    assert.equal(await cancelled.hydrateLatestResults(references, { isCurrent: () => current }), null);
    const missing = createPromptAgentReferenceSource({ state: {}, nodeAdapter: {}, getImageAsset: async () => null });
    await assert.rejects(missing.hydrateLatestResults(references, { isCurrent: () => true }), /原图缺失/);
});

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


test('context candidates retain archived run identity and exact batch positions, excluding disabled scene nodes', () => {
    const h = harness();
    h.state.nodes.set('disabled', { id: 'disabled', type: 'ImageImport', enabled: false });
    h.state.nodes.set('scene', { id: 'scene', type: 'ImageImport' });
    h.state.selectedNodes = new Set(['scene']);
    const refs = h.source.getContextReferences({ archivedMessages: [{ promptPlan: { prompt: '猫海报' }, runs: [
        { runId: 'old', mediaAssetKeys: ['asset:a', 'asset:b'] }
    ] }], messages: [{ runs: [{ runId: 'new', mediaAssetKeys: ['asset:c'] }] }] });
    assert.deepEqual(refs.map(ref => ref.sourceNodeId).filter(Boolean), ['scene']);
    assert.equal(refs[0].selectedOnCanvas, true);
    assert.deepEqual(refs.filter(ref => ref.runId).map(ref => [ref.runId, ref.messageNumber, ref.resultNumber, ref.assetKey]),
        [['old', 1, 1, 'asset:a'], ['old', 1, 2, 'asset:b'], ['new', 2, 1, 'asset:c']]);
    assert.equal(h.reads, 0);
});

test('selected result uses its exact original asset, imports once and never connects the generating node', async () => {
    const state = { nodes: new Map([['generator', { id: 'generator', type: 'ImageGenerate' }]]) };
    const reads = [], saved = [];
    let creates = 0;
    const nodeAdapter = {
        getSceneReferenceImages: () => [...state.nodes.values()].filter(n => n.type === 'ImageImport').map(n => ({ referenceId: n.id, sourceNodeId: n.id })),
        readSceneReferenceImage: async ref => ({ ...ref, dataUrl: 'data:image/png;base64,SECOND' })
    };
    const source = createPromptAgentReferenceSource({ state, nodeAdapter,
        getImageAsset: async key => { reads.push(key); return 'data:image/png;base64,SECOND'; },
        createImportNode: () => { const id = `import-${++creates}`; state.nodes.set(id, { id, type: 'ImageImport' }); return id; },
        loadImageData: async (id, data) => { saved.push(data); state.nodes.get(id).imageImportAssetKey = 'asset:second'; return true; }
    });
    const plan = { referenceImages: [{ runId: 'batch', assetKey: 'asset:second', role: 'edit-target', description: '保留主体' }] };
    const first = await source.preparePlanReferences(plan, { isCurrent: () => true });
    const second = await source.preparePlanReferences(plan, { isCurrent: () => true });
    assert.equal(creates, 1);
    assert.deepEqual(reads, ['asset:second', 'asset:second']);
    assert.deepEqual(saved, ['data:image/png;base64,SECOND']);
    assert.equal(first[0].sourceNodeId, 'import-1');
    assert.equal(second[0].sourceNodeId, 'import-1');
    assert.equal(first[0].role, 'edit-target');
    assert.equal(first[0].sourceImageIndex, 0);
    assert.equal(first[0].description, '保留主体');
    assert.equal(state.nodes.get('import-1').data.imageDescription, '保留主体');
});

test('history reference descriptions survive catalog refresh before importing', async () => {
    const values = new Map();
    const previous = globalThis.localStorage;
    globalThis.localStorage = {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value)
    };
    try {
        const source = createPromptAgentReferenceSource({ state: { nodes: new Map() }, nodeAdapter: {},
            getHistoryMetadata: async () => [{ id: 9, mediaType: 'image', timestamp: 1 }],
            getHistoryEntry: async () => ({ image: image.dataUrl }) });
        source.saveDescription({ historyId: '9' }, '保留蓝色背景');
        const [candidate] = await source.listHistory();
        assert.equal(candidate.description, '保留蓝色背景');
        assert.equal((await source.readHistory(candidate)).description, '保留蓝色背景');
    } finally {
        if (previous === undefined) delete globalThis.localStorage;
        else globalThis.localStorage = previous;
    }
});

test('one selected image from a batch is imported alone with its description', async () => {
    const originals = ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND'];
    const state = { nodes: new Map([['batch', { id: 'batch', type: 'ImageImport' }]]) };
    let created = 0;
    const source = createPromptAgentReferenceSource({ state,
        nodeAdapter: {
            getSceneReferenceImages: () => originals.map((_, index) => ({ referenceId: `batch:${index}`, sourceNodeId: 'batch', sourceImageIndex: index }))
                .concat([...state.nodes.values()].filter(node => node.id !== 'batch').map(node => ({ referenceId: node.id, sourceNodeId: node.id, sourceImageIndex: 0 }))),
            readSceneReferenceImage: async ref => ({ ...ref, name: '图', dataUrl: originals[ref.sourceImageIndex] })
        },
        createImportNode: () => { const id = `single-${++created}`; state.nodes.set(id, { id, type: 'ImageImport' }); return id; },
        loadImageData: async id => { state.nodes.get(id).imageImportAssetKey = `media:${id}`; return true; }
    });
    const [selected] = await source.preparePlanReferences({ referenceImages: [{ referenceId: 'batch:1', description: '仅用第二张' }] },
        { isCurrent: () => true });
    assert.equal(selected.sourceNodeId, 'single-1');
    assert.equal(selected.description, '仅用第二张');
    assert.equal(state.nodes.get('single-1').data.imageDescription, '仅用第二张');
});

test('missing result originals and cancelled resolution never create replacement nodes', async () => {
    let current = true, finish;
    const source = createPromptAgentReferenceSource({ state: { nodes: new Map() },
        nodeAdapter: { getSceneReferenceImages: () => [] },
        getImageAsset: () => new Promise(resolve => { finish = resolve; }),
        createImportNode: () => assert.fail('must not create a node')
    });
    const plan = { referenceImages: [{ runId: 'run', assetKey: 'asset:missing', role: 'edit-target' }] };
    const missing = source.preparePlanReferences(plan, { isCurrent: () => current });
    finish('');
    await assert.rejects(missing, /原图缺失/);
    const cancelled = source.preparePlanReferences(plan, { isCurrent: () => current });
    current = false;
    finish(image.dataUrl);
    assert.equal(await cancelled, null);
});
