import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';
import { beginAgentResultDrag, takeAgentResultDrag, endAgentResultDrag } from '../js/features/prompt-agent/prompt-agent-result-drag.js';

test('restored Agent results drag original images to Agent and canvas exactly once while preserving preview', async () => {
    const result = await runUiFixture('tests/fixtures/prompt-agent-result-drag.html');
    assert.equal(result.error, undefined);
    for (const name of ['agentImport', 'singleConsumption', 'dragDoesNotPreview', 'clickPreview', 'keyboardPreview', 'canvasImport', 'dragEnabled', 'workflowFence']) assert.equal(result[name], true, name);
});

test('drag completion clears originals and external URL payloads are not imported', async () => {
    const values = new Map();
    const transfer = { setData: (key, value) => values.set(key, value), getData: (key) => values.get(key) };
    const token = beginAgentResultDrag(transfer, { dataUrl: 'data:image/png;base64,YQ==', name: '原图' });
    assert.ok(token);
    endAgentResultDrag(token);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(takeAgentResultDrag(transfer), null);
    assert.equal(beginAgentResultDrag(transfer, { dataUrl: 'https://example.test/image.png' }), null);
});
