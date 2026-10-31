import test from 'node:test';
import assert from 'node:assert/strict';
import { removeRetiredSaveNodes } from '../js/features/persistence/retired-save-nodes.js';

test('retiring save chains preserves surrounding reference order and media types without changing original document', () => {
    const node = (id, type) => ({ id, type });
    const edge = (id, source, port, target, input, order) => ({ id, from: { nodeId: source, port }, to: { nodeId: target, port: input }, order });
    const original = { nodes: [node('a','ImageGenerate'),node('b','ImageImport'),node('s','ImageSave'),node('s2','ImageSave'),node('g','ImageGenerate'),node('v','VideoGenerate'),node('out','VideoGenerate')], connections: [
        edge('b-s','b','image','s','image',1),edge('a-s','a','image','s','image',0),
        edge('s-s2','s','image','s2','image',0),edge('s2-g','s2','image','g','referenceImages',0),
        edge('v-s','v','video','s','video',0),edge('s-out','s','video','out','video',0)
    ] };
    const result = removeRetiredSaveNodes(original);
    assert.deepEqual(result.nodes.map(n=>n.id), ['a','b','g','v','out']);
    assert.deepEqual(result.connections.map(e=>[e.from.nodeId,e.to.nodeId,e.from.port,e.order]), [['a','g','image',0],['b','g','image',1],['v','out','video',0]]);
    assert.equal(original.nodes.length,7);
});
