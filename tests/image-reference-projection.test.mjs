import test from 'node:test';
import assert from 'node:assert/strict';
import { projectImageReferences } from '../js/nodes/image-reference-projection.js';
import { appendReferenceDescriptions } from '../js/features/execution/reference-image-description.js';
import { createPromptAgentNodeAdapter } from '../js/features/prompt-agent/prompt-agent-node-adapter.js';
import { createPromptAgentInput } from '../js/features/prompt-agent/prompt-agent-input.js';

test('reference projection retains every source group and numbers only complete effective batch slots', () => {
    const target = { id: 'target', type: 'ImageGenerate' };
    const sources = [
        { id: 'disabled', type: 'ImageGenerate', enabled: false, data: { imageList: ['same','same'] } },
        { id: 'empty', type: 'ImageGenerate', data: {} },
        { id: 'running', type: 'ImageGenerate', data: { imageList: ['old'] } },
        { id: 'ready', type: 'ImageGenerate', customTitle: '完整标题', data: { imageList: ['same','same'], mediaAssetKeys: ['media:a','media:b'] } },
        { id: 'missing', type: 'ImageGenerate', data: { imageList: ['second','third'], mediaAssetKeys: ['media:x','media:y','media:z'],
            mediaIntegrity: { missingItems: [{ position: 0 }] }, imagePreviewThumbnail: 'thumbnail' } }
    ];
    const connections = sources.map((source, order) => ({ id: source.id, from: { nodeId: source.id, port: 'image' },
        to: { nodeId: target.id, port: 'referenceImages' }, type: 'image', order }));
    const state = { nodes: new Map([target, ...sources].map(node => [node.id, node])), connections, runningNodeIds: new Set(['running']) };
    const projection = projectImageReferences({ state, targetId: target.id });
    assert.deepEqual(projection.groups.map(group => [group.connection.id, group.count, group.enabled, group.running]), [
        ['disabled',2,false,false], ['empty',0,true,false], ['running',1,true,true], ['ready',2,true,false], ['missing',3,true,false]
    ]);
    assert.equal(projection.count, 5);
    assert.deepEqual(projection.slots.map(slot => [slot.source.id, slot.index, slot.number, slot.image, slot.assetKey, slot.missing]), [
        ['ready',0,1,'same','media:a',false], ['ready',1,2,'same','media:b',false],
        ['missing',0,3,'','media:x',true], ['missing',1,4,'','media:y',false], ['missing',2,5,'','media:z',false]
    ]);
    assert.equal(projection.groups[3].name, '完整标题');
    assert.equal(projection.groups[4].thumbnail, 'thumbnail');
    assert.equal(projection.groups[3].connection, connections[3], 'projection retains the editable graph identity');
});

test('prompt descriptions and Agent context share effective source order without phantom references', () => {
    const target = { id: 'target', type: 'ImageGenerate', data: {} }, image = 'data:image/png;base64,AAAA';
    const sources = [
        { id: 'disabled', type: 'ImageImport', enabled: false, data: { image, imageDescription: '停用说明' } },
        { id: 'empty', type: 'ImageImport', data: { imageDescription: '尚无原图说明' } },
        { id: 'running', type: 'ImageGenerate', runStatus: 'running', data: { image, imageDescription: '旧图说明' } },
        { id: 'ready-a', type: 'ImageGenerate', data: { imageList: [image,image], imageDescriptions: ['正面','背面'] } },
        { id: 'ready-b', type: 'ImageImport', data: { image, imageDescription: '颜色' } }
    ];
    const state = { nodes: new Map([target,...sources].map(node => [node.id,node])),
        connections: sources.map((source, order) => ({ id: source.id, from: { nodeId: source.id, port: 'image' }, to: { nodeId: target.id, port: 'referenceImages' }, order })) };
    assert.equal(appendReferenceDescriptions('生成', state, target.id), '生成\n\n参考图 1：正面\n参考图 2：背面\n参考图 3：颜色');
    const adapter = createPromptAgentNodeAdapter({ state, documentRef: { getElementById: () => null } });
    assert.deepEqual(adapter.getContext(target.id).referenceImages.map(reference => reference.sourceNodeId), ['ready-a','ready-b']);
    assert.throws(() => adapter.getReferenceSnapshot(target.id), /运行/, 'an explicit execution snapshot still rejects a running source instead of silently dropping it');
});

test('legacy reference roles retain numeric order beside explicit canonical source order', () => {
    const sources = ['legacy-first','legacy-second','canonical-first','canonical-second'].map(id => ({ id, type: 'ImageImport', data: { image: id } }));
    const edge = (id, port, order) => ({ id, from: { nodeId: id, port: 'image' }, to: { nodeId: 'target', port }, ...(order === undefined ? {} : { order }) });
    const connections = [edge('canonical-second','referenceImages',9),edge('legacy-second','image_2'),edge('canonical-first','referenceImages',4),edge('legacy-first','image_1')];
    const state = { nodes: new Map(sources.map(source => [source.id,source])), connections };
    const projection = projectImageReferences({ state, targetId: 'target' });
    assert.deepEqual(projection.slots.map(slot => [slot.source.id,slot.number]), [
        ['legacy-first',1],['legacy-second',2],['canonical-first',3],['canonical-second',4]
    ]);
    assert.deepEqual(connections.map(connection => connection.order), [9,undefined,4,undefined], 'reading never renumbers saved edges');
    const mixed = projectImageReferences({ state, targetId: 'target', connections: [
        edge('canonical-first','referenceImages',0), edge('legacy-second','image_2')
    ] });
    assert.deepEqual(mixed.slots.map(slot => slot.source.id), ['legacy-second','canonical-first'], 'legacy logical image fields precede the canonical reference array in existing request builders');
});

test('known missing batch positions stay separate in Agent context and cannot become a partial reference snapshot', () => {
    const target = { id: 'target', type: 'ImageGenerate', data: {} };
    const source = { id: 'source', type: 'ImageGenerate', data: { imageCount: 3, imageDescriptions: ['第一张','第二张','第三张'] } };
    const state = { nodes: new Map([[target.id,target],[source.id,source]]), connections: [
        { id: 'edge', from: { nodeId: source.id, port: 'image' }, to: { nodeId: target.id, port: 'referenceImages' }, order: 0 }
    ] };
    const adapter = createPromptAgentNodeAdapter({ state, documentRef: { getElementById: () => null } });
    const input = createPromptAgentInput({ context: adapter.getContext(target.id), model: { protocol: 'openai' } });
    assert.deepEqual(input.images.map(image => [image.reference.sourceImageIndex,image.description,image.visionAvailable]), [
        [0,'第一张',false],[1,'第二张',false],[2,'第三张',false]
    ]);
    assert.throws(() => adapter.getReferenceSnapshot(target.id), /原图.*缺失/);
});

test('unmigrated video frame roles keep their primary-image semantics before complete reference batches', () => {
    const target = { id: 'video', type: 'VideoGenerate' };
    const frameA = { id: 'a', data: { imageList: ['a1','a2','a3'], imageDescriptions: ['首帧','不消费a2','不消费a3'] } };
    const frameB = { id: 'b', data: { imageList: ['b1','b2'], imageDescriptions: ['尾帧','不消费b2'] } };
    const references = { id: 'refs', data: { imageList: ['c1','c2'], imageDescriptions: ['参考一','参考二'] } };
    const state = { nodes: new Map([target,frameA,frameB,references].map(node => [node.id,node])), connections: [
        { id: 'refs', from: { nodeId: 'refs', port: 'image' }, to: { nodeId: 'video', port: 'referenceImages' }, order: 0 },
        { id: 'b', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'video', port: 'image_2' } },
        { id: 'a', from: { nodeId: 'a', port: 'image' }, to: { nodeId: 'video', port: 'image_1' } }
    ] };
    assert.deepEqual(projectImageReferences({ state, targetId: 'video' }).slots.map(slot => [slot.source.id,slot.index,slot.number]), [
        ['a',0,1],['b',0,2],['refs',0,3],['refs',1,4]
    ]);
    assert.equal(appendReferenceDescriptions('视频', state, 'video'), '视频\n\n参考图 1：首帧\n参考图 2：尾帧\n参考图 3：参考一\n参考图 4：参考二');
    assert.deepEqual(frameA.data.imageList, ['a1','a2','a3']);
});
