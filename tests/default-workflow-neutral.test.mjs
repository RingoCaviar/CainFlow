import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('默认工作流保留拓扑但不携带供应商绑定或运行结果', async () => {
    const workflow = JSON.parse(await readFile(new URL('../workflows/Default.json', import.meta.url), 'utf8'));

    assert.ok(workflow.nodes.length > 0);
    assert.ok(workflow.connections.length > 0);
    for (const node of workflow.nodes) {
        if ('apiConfigId' in node) assert.equal(node.apiConfigId, '');
        if ('providerId' in node) assert.equal(node.providerId, '');
        assert.notEqual(node.isSucceeded, true);
        assert.equal(node.lastResponse || '', '');
        assert.equal(node.lastText || '', '');
        assert.equal(node.concurrentRequestStatus ?? null, null);
    }
    assert.doesNotMatch(JSON.stringify(workflow), /gpt[\s_-]*image[\s_-]*2/i);
});
