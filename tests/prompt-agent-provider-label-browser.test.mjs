import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { getAgentModelLabel } from '../js/features/prompt-agent/prompt-agent-model-menu.js';

const providers = [{ id: 'a', name: '供应商甲', endpoint: 'https://controlled.test/v1', apikey: 'test' },
    { id: 'b', name: '供应商乙', endpoint: 'https://controlled.test/v1', apikey: 'test' }];
const models = [
    { id: 'chat', name: '同名模型', modelId: 'chat-test', taskType: 'chat', protocol: 'openai', agentSearch: 'images', providerIds: ['a'] },
    { id: 'image', name: '同名模型', modelId: 'image-test', taskType: 'image', protocol: 'openai', providerIds: ['b', 'a'] }
];

test('Agent model labels follow configured Provider order without exposing connection credentials', () => {
    assert.equal(getAgentModelLabel(models[0], providers), '同名模型 · 请选择供应商');
    assert.equal(getAgentModelLabel(models[1], providers), '同名模型 · 请选择供应商');
    assert.equal(getAgentModelLabel({ modelId: 'fallback', providerIds: ['missing'] }, providers), 'fallback · 请选择供应商');
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
        await evaluate(`document.getElementById('prompt-agent-model').parentElement.querySelector('.thinking-control > summary').click()`);
        assert.equal(await evaluate("document.getElementById('prompt-agent-search-enabled').disabled"), false);
        const step = await evaluate(`(async () => {
            const { renderCanvasPlan } = await import('/js/features/prompt-agent/prompt-agent-canvas-ui.js');
            const host = document.createElement('div'); document.body.appendChild(host);
            const providers = ${JSON.stringify(providers)}, models = ${JSON.stringify(models)};
            const view = renderCanvasPlan({ documentRef: document, parent: host,
                plan: { id: 'provider-test', order: ['image'], steps: [{ id: 'image', type: 'ImageGenerate', title: '生成' }] },
                adapter: { describe: () => [], stepStatus: () => 'draft', modelsFor: () => [], canUndo: () => '' },
                getModels: () => [models[1]], getProviders: () => providers, getModelId: () => 'image', getProviderId: () => 'b', changed: () => {}, isCurrent: () => true });
            const select = host.querySelector('select');
            const before = [...select.options].map(o => o.textContent);
            providers[1].name = '更名供应商'; view.sync();
            const after = [...select.options].map(o => o.textContent);
            const value = select.value; view.destroy(); host.replaceChildren();

            const existingPlan = { id: 'existing-provider-test', applyInPlace: true, order: ['image'],
                steps: [{ id: 'image', type: 'ImageGenerate', nodeId: 'existing', title: '生成', execute: false,
                    parameters: { aspect: '1:1' } }] };
            const existingView = renderCanvasPlan({ documentRef: document, parent: host, plan: existingPlan,
                adapter: { describe: () => [], stepStatus: () => 'draft', modelsFor: () => [], canUndo: () => '',
                    context: () => ({ nodes: [{ id: 'existing', modelId: 'image', providerId: 'a' }] }) },
                getModels: () => [models[1]], getProviders: () => providers, getModelId: () => 'image', getProviderId: () => 'b', changed: () => {}, isCurrent: () => true });
            const inherited = host.querySelector('select').options[0].textContent;
            existingPlan.modelOverrides = { image: 'image' };
            existingPlan.providerOverrides = { image: { image: 'b' } };
            existingView.sync();
            const override = host.querySelector('select').selectedOptions[0].textContent;
            existingView.destroy(); host.remove();
            return { before, after, value, inherited, override };
        })()`);
        assert.ok(step.before.every(label => label.includes('供应商乙')));
        assert.ok(step.after.every(label => label.includes('更名供应商')));
        assert.equal(step.value, '');
        assert.match(step.inherited, /节点模型：.*供应商甲/);
        assert.match(step.override, /更名供应商/);
        await delay(50);
    });
});
