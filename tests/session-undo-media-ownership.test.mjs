import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManagerApi } from '../js/features/persistence/session-manager.js';

function moveHistoryFixture() {
    const node={id:'image',type:'ImageImport',x:10,y:20,data:{mediaAssetKeys:['media:original']},el:{style:{},remove(){},querySelectorAll:()=>[]}};
    const state={nodes:new Map([[node.id,node]]),selectedNodes:new Set(),connections:[],undoStack:[],redoStack:[]};
    const protectedSnapshots=[],released=[],persist={ok:true,failProtection:false};
    const manager=createSessionManagerApi({state,storageKey:'session',
        nodeSerializer:{serializeNodes:()=>[...state.nodes.values()].map(({el,...n})=>n),buildStatePayload:()=>({})},
        localStorageRef:{getItem:()=>null,setItem(){},length:0},documentRef:{getElementById:()=>null},showToast(){},
        updateAllConnections(){},updatePortStyles(){},persistHistoryTransition:async()=>persist.ok,
        addNode(type,x,y,data){state.nodes.set(data.id,{...data,type,x,y,el:{style:{},remove(){},querySelectorAll:()=>[]}})},
        undoMedia:{protect(s){if(persist.failProtection)throw Error('protection unavailable');protectedSnapshots.push(structuredClone(s))},release:async s=>released.push(s),end:async()=>{}},
    });
    return {node,state,manager,protectedSnapshots,released,persist};
}

test('position-only history never protects or restores media and keeps live node identity through undo redo', async()=>{
    const {node,state,manager,protectedSnapshots,released}=moveHistoryFixture();
    manager.pushNodeMoveHistory(['image']);node.x=80;node.y=90;
    node.data.mediaAssetKeys=['media:new-result'];
    assert.doesNotMatch(state.undoStack[0],/media:|connections|ImageImport/);
    await manager.undo();assert.equal(state.nodes.get('image'),node);assert.deepEqual([node.x,node.y],[10,20]);
    assert.deepEqual(node.data.mediaAssetKeys,['media:new-result']);
    await manager.redo();assert.deepEqual([node.x,node.y],[80,90]);
    assert.deepEqual(protectedSnapshots,[]);manager.clearUndoStack();assert.deepEqual(released,[]);
});

test('failed position save rolls back coordinates and leaves undo and redo stacks unchanged',async()=>{
    const {node,state,manager,persist}=moveHistoryFixture();
    manager.pushNodeMoveHistory(['image']);node.x=80;persist.ok=false;
    const before=[...state.undoStack];await manager.undo();
    assert.equal(node.x,80);assert.deepEqual(state.undoStack,before);assert.deepEqual(state.redoStack,[]);
    persist.ok=true;await manager.undo();assert.equal(node.x,10);
});

test('topology promotion protects full media before mutation and retains drag-start coordinates in one record',async()=>{
    const {node,state,manager,protectedSnapshots,persist}=moveHistoryFixture();
    const promote=manager.pushNodeMoveHistory(['image']);node.x=80;
    persist.failProtection=true;assert.throws(promote,/protection/);
    assert.equal(JSON.parse(state.undoStack[0]).kind,'node-positions');
    persist.failProtection=false;promote();promote();
    assert.equal(protectedSnapshots.length,1);assert.equal(state.undoStack.length,1);
    assert.equal(JSON.parse(state.undoStack[0]).nodes[0].x,10);
    assert.deepEqual(protectedSnapshots[0].nodes[0].data.mediaAssetKeys,['media:original']);
});

test('move then deletion restores protected originals before undoing coordinates, including redo',async()=>{
    const {node,state,manager,protectedSnapshots}=moveHistoryFixture();
    manager.pushNodeMoveHistory(['image']);node.x=80;
    manager.pushHistory();state.nodes.clear();
    assert.equal(protectedSnapshots.length,1);
    await manager.undo();const restored=state.nodes.get('image');assert.equal(restored.x,80);
    await manager.undo();assert.equal(restored.x,10);assert.equal(state.nodes.get('image'),restored);
    await manager.redo();assert.equal(restored.x,80);
    await manager.redo();assert.equal(state.nodes.size,0);
});

test('group movement is one coordinate record and stale topology promotion cannot replace a newer edit',async()=>{
    const {node,state,manager,protectedSnapshots}=moveHistoryFixture();
    const second={...node,id:'second',x:30,y:40,el:{...node.el,style:{}}};state.nodes.set(second.id,second);
    const promote=manager.pushNodeMoveHistory(['image','second']);node.x=80;second.x=100;
    await manager.undo();assert.deepEqual([node.x,second.x],[10,30]);
    await manager.redo();assert.deepEqual([node.x,second.x],[80,100]);
    assert.throws(promote,/记录已变化/);
    assert.deepEqual(protectedSnapshots,[]);
});

test('session initialization removes legacy persisted undo snapshot metadata', () => {
    const removed = [];
    createSessionManagerApi({
        state: { nodes: new Map(), connections: [], undoStack: [], redoStack: [] },
        storageKey: 'session', nodeSerializer: { serializeNodes: () => [] },
        localStorageRef: {
            getItem: () => '[{"nodes":[]}]',
            removeItem: (key) => removed.push(key)
        },
        documentRef: { getElementById: () => null }
    });
    assert.deepEqual(removed, ['cainflow_pending_undo_media_releases']);
});

test('Undo and Redo mark only nodes that they actually restore as media owners', async () => {
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const state = {
        nodes: new Map([
            ['existing', { id: 'existing', el: element() }],
            ['newer', { id: 'newer', type: 'ImagePreview', x: 0, y: 0, data: {}, el: element() }]
        ]),
        selectedNodes: new Set(),
        connections: [],
        undoStack: [JSON.stringify({ nodes: [
            { id: 'existing', type: 'ImagePreview', x: 0, y: 0, data: {} },
            { id: 'restored', type: 'ImageImport', x: 0, y: 0, data: {} }
        ], connections: [] })],
        redoStack: [],
        workflowTabs: [],
        workflowOrder: [],
        workflowFolders: []
    };
    const beforeSaveCalls = [];
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: {
            buildStatePayload: () => ({ nodes: [], connections: [] }),
            serializeNodes: () => [...state.nodes.values()].map(({ el: _el, ...node }) => node)
        },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode(type, x, y, data) { state.nodes.set(data.id, { ...data, type, x, y, el: element() }); },
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        clearOrphanedNodeAssets: async () => true
    });
    manager.setBeforeSave((options) => beforeSaveCalls.push(options));

    await manager.undo();

    assert.deepEqual(beforeSaveCalls.find((call) => call.dirty === true)?.mediaOwnershipRestoreOwnerIds,
        ['workflow-import:restored']);
    assert.deepEqual([...state.nodes.keys()], ['existing', 'restored']);
    assert.equal(state.redoStack.length, 1);

    beforeSaveCalls.length = 0;
    await manager.redo();

    assert.deepEqual(beforeSaveCalls.find((call) => call.dirty === true)?.mediaOwnershipRestoreOwnerIds,
        ['workflow-node:newer']);
    assert.deepEqual([...state.nodes.keys()], ['existing', 'newer']);
    assert.equal(state.undoStack.length, 1);
    assert.equal(state.redoStack.length, 0);

    await manager.undo();
    assert.equal(state.redoStack.length, 1);

    manager.pushHistory();
    assert.equal(state.redoStack.length, 0);
});

test('Undo keeps graph history without creating a disk owner for the Redo snapshot', async () => {
    const element = () => ({ remove() {}, querySelectorAll: () => [] });
    const currentNode = {
        id: 'current', type: 'ImagePreview', x: 0, y: 0,
        data: { mediaAssetKeys: ['media:current'] }, el: element()
    };
    const state = {
        nodes: new Map([['current', currentNode]]),
        selectedNodes: new Set(),
        connections: [],
        undoStack: [JSON.stringify({ nodes: [], connections: [] })],
        redoStack: [],
        workflowTabs: [],
        workflowOrder: [],
        workflowFolders: []
    };
    const references = [];
    const manager = createSessionManagerApi({
        state,
        storageKey: 'session',
        nodeSerializer: {
            buildStatePayload: () => ({ nodes: [], connections: [] }),
            serializeNodes: () => [{ ...currentNode, el: undefined }]
        },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null },
        showToast() {},
        addNode() { throw new Error('The target snapshot has no nodes'); },
        updateAllConnections() {},
        updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        referenceMediaAsset: async (...args) => { references.push(args); return false; },
        removeMediaReference: async () => true
    });

    await manager.undo();

    assert.deepEqual(references, []);
    assert.deepEqual([...state.nodes.keys()], []);
    assert.equal(state.undoStack.length, 0);
    assert.equal(state.redoStack.length, 1);
});

test('Undo restores node structure without a media key already collected from disk', async () => {
    const state = {
        nodes: new Map(), selectedNodes: new Set(), connections: [],
        undoStack: [JSON.stringify({ mediaUndoOwnerId: 'workflow:old-undo', nodes: [{
            id: 'deleted', type: 'ImageImport', x: 0, y: 0,
            imageImportAssetKey: 'media:collected', mediaAssetKeys: ['media:collected'],
            imageAssetReady: true, imageCount: 1
        }], connections: [] })],
        redoStack: [], workflowTabs: [], workflowOrder: [], workflowFolders: []
    };
    const persisted = [];
    const released = [];
    const manager = createSessionManagerApi({
        state, storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null }, showToast() {},
        addNode(_type, _x, _y, data) {
            state.nodes.set(data.id, { ...data, el: { remove() {}, querySelectorAll: () => [] } });
        },
        updateAllConnections() {}, updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        mediaAssetExists: async () => false,
        removeMediaReference: async (...args) => { released.push(args); return true; },
        persistHistoryTransition: async () => {
            persisted.push([...state.nodes.values()].map(({ el: _el, ...node }) => node));
            return true;
        }
    });
    await manager.undo();
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0][0].mediaAssetKeys, []);
    assert.equal(persisted[0][0].imageImportAssetKey, '');
    assert.equal(persisted[0][0].imageAssetReady, undefined);
    assert.deepEqual(released, [['workflow-undo', 'workflow:old-undo:deleted', 'media:collected']]);
    assert.equal(state.redoStack.length, 1);
});

test('Undo keeps surviving images in a batch and updates the image count', async () => {
    const state = {
        nodes: new Map(), selectedNodes: new Set(), connections: [],
        undoStack: [JSON.stringify({ nodes: [{
            id: 'batch', type: 'ImagePreview', x: 0, y: 0,
            mediaAssetKeys: ['media:removed', 'media:surviving'],
            imageAssetKey: 'media:removed', imageCount: 2, imagePreviewIndex: 1
        }], connections: [] })],
        redoStack: [], workflowTabs: [], workflowOrder: [], workflowFolders: []
    };
    const manager = createSessionManagerApi({
        state, storageKey: 'session',
        nodeSerializer: { buildStatePayload: () => ({ nodes: [], connections: [] }), serializeNodes: () => [] },
        localStorageRef: { setItem() {}, getItem: () => null, length: 0 },
        documentRef: { getElementById: () => null }, showToast() {},
        addNode(_type, _x, _y, data) {
            state.nodes.set(data.id, { ...data, el: { remove() {}, querySelectorAll: () => [] } });
        },
        updateAllConnections() {}, updatePortStyles() {},
        getWorkflowSnapshot: () => ({ active: { workflowId: 'workflow' }, open: [] }),
        mediaAssetExists: async (key) => key === 'media:surviving'
    });
    await manager.undo();
    const restored = state.nodes.get('batch');
    assert.deepEqual(restored.mediaAssetKeys, ['media:surviving']);
    assert.equal(restored.imageAssetKey, 'media:surviving');
    assert.equal(restored.imageCount, 1);
    assert.equal(restored.imagePreviewIndex, 0);
});

test('Undo removes missing video references without using a surviving video as an image', async () => {
    const state={nodes:new Map(),selectedNodes:new Set(),connections:[],undoStack:[JSON.stringify({nodes:[{
        id:'saved',type:'ImageSave',x:0,y:0,imageAssetKey:'media:gone-image',mediaAssetKeys:['media:gone-image'],
        videoAssetKey:'media:gone-video',videoUrl:'/api/storage/assets/media%3Agone-video',
        video:{assetKey:'media:gone-video'},videos:[{assetKey:'media:gone-video'},{assetKey:'media:live-video'}]
    }],connections:[]})],redoStack:[],workflowTabs:[],workflowOrder:[],workflowFolders:[]};
    const manager=createSessionManagerApi({
        state,storageKey:'session',nodeSerializer:{buildStatePayload:()=>({nodes:[],connections:[]}),serializeNodes:()=>[]},
        localStorageRef:{setItem(){},getItem:()=>null,length:0},documentRef:{getElementById:()=>null},showToast(){},
        addNode(_type,_x,_y,data){state.nodes.set(data.id,{...data,el:{remove(){},querySelectorAll:()=>[]}})},
        updateAllConnections(){},updatePortStyles(){},mediaAssetExists:async key=>key==='media:live-video'
    });
    await manager.undo();
    const restored=state.nodes.get('saved');
    assert.equal(restored.imageAssetKey,undefined,'a retained video is never substituted for an image');
    assert.equal(restored.videoAssetKey,undefined);
    assert.equal(restored.video,undefined);
    assert.deepEqual(restored.videos,[{assetKey:'media:live-video'}]);
    assert.equal(restored.videoUrl,'');
});
