import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { getAgentModelLabel } from '../js/features/prompt-agent/prompt-agent-model-menu.js';

const providers = [{ id: 'a', name: '供应商甲', endpoint: 'https://controlled.test/v1', apikey: 'test' },
    { id: 'b', name: '供应商乙', endpoint: 'https://controlled.test/v1', apikey: 'test' }];
const models = [
    { id: 'chat', name: '同名模型', modelId: 'chat-test', taskType: 'chat', protocol: 'openai', agentSearch: 'images', providerIds: ['a'] },
    { id: 'image', name: '同名模型', modelId: 'image-test', taskType: 'image', protocol: 'openai-image', providerIds: ['b', 'a'] }
];

test('Agent model labels follow configured Provider order without exposing connection credentials', () => {
    assert.equal(getAgentModelLabel(models[0], providers), '同名模型 - 供应商甲');
    assert.equal(getAgentModelLabel(models[1], providers), '同名模型 - 供应商乙 等2个供应商');
    assert.equal(getAgentModelLabel({ modelId: 'fallback', providerIds: ['missing'] }, providers), 'fallback');
});

test('Agent chat, image, search and step menus expose Provider names and keep manual selections', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, models, providers }, async ({ evaluate }) => {
        await evaluate(`document.getElementById('btn-prompt-agent').click()`);
        for (const [id, expected] of [['prompt-agent-model', '供应商甲'], ['prompt-agent-image-model', '供应商乙']]) {
            await evaluate(`document.querySelector('#${id} + button').click()`);
            assert.ok(await evaluate(`document.getElementById('${id}-menu').textContent.includes('${expected}')`));
            await evaluate(`document.querySelector('#${id} + button').click()`);
        }
        assert.equal(await evaluate(`document.getElementById('prompt-agent-image-model').value`), '');
        await evaluate(`document.getElementById('prompt-agent-search-button').click(); document.querySelector('#prompt-agent-search-model + button').click()`);
        assert.ok(await evaluate(`document.getElementById('prompt-agent-search-model-menu').textContent.includes('供应商甲')`));
        assert.equal(await evaluate(`document.getElementById('prompt-agent-search-model').value`), '');
        const step = await evaluate(`(async () => {
            const { renderCanvasPlan } = await import('/js/features/prompt-agent/prompt-agent-canvas-ui.js');
            const host = document.createElement('div'); document.body.appendChild(host);
            const providers = ${JSON.stringify(providers)}, models = ${JSON.stringify(models)};
            const view = renderCanvasPlan({ documentRef: document, parent: host,
                plan: { id: 'provider-test', order: ['image'], steps: [{ id: 'image', type: 'ImageGenerate', title: '生成' }] },
                adapter: { describe: () => [], stepStatus: () => 'draft', modelsFor: () => [], canUndo: () => '' },
                getModels: () => [models[1]], getProviders: () => providers, getModelId: () => 'image', changed: () => {}, isCurrent: () => true });
            const select = host.querySelector('select');
            const before = [...select.options].map(o => o.textContent);
            providers[1].name = '更名供应商'; view.sync();
            const after = [...select.options].map(o => o.textContent);
            const value = select.value; view.destroy(); host.remove();
            return { before, after, value };
        })()`);
        assert.ok(step.before.every(label => label.includes('供应商乙')));
        assert.ok(step.after.every(label => label.includes('更名供应商')));
        assert.equal(step.value, '');
        await delay(50);
    });
});
