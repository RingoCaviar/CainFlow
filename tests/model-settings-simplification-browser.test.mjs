import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('model editor omits request controls and global compaction setting persists in the app', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', name: '受控对话', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'],
            agentSearch: 'none', autoCompactTokenLimit: 1, thinking: { profile: 'none' } },
        { id: 'cheap', name: '低成本压缩', modelId: 'cheap', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '受控供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }] }, async ({ evaluate, waitFor }) => {
        await evaluate("document.getElementById('btn-settings').click();document.querySelector('.model-config-card .card-header').click()");
        const modelUi = await evaluate("(()=>{const card=document.querySelector('.model-config-card');return {search:!!card.querySelector('[data-field=agentSearch]'),compact:!!card.querySelector('[data-field=autoCompactTokenLimit]'),thinking:!!card.querySelector('.thinking-model-settings')}})()");
        assert.deepEqual(modelUi, { search: false, compact: false, thinking: false });
        await evaluate("document.querySelector('.modal-tab-btn[data-tab=general]').click()");
        await waitFor("Boolean(document.getElementById('setting-agent-auto-compact-tokens'))");
        const value = await evaluate(`(async()=>{const input=document.getElementById('setting-agent-auto-compact-tokens');input.value='24000';input.dispatchEvent(new Event('change',{bubbles:true}));const {diskStorage}=await import('/js/services/storage-documents.js');return diskStorage.getItem('cainflow_prompt_agent_auto_compact_tokens')})()`);
        assert.equal(value, '24000');
        const menu = await evaluate(`(()=>{const trigger=document.querySelector('.general-settings-compaction-control .prompt-agent-model-trigger');trigger.click();const menu=document.getElementById('setting-agent-compaction-model-menu');const search=menu.querySelector('.prompt-agent-model-search');search.value='低成本';search.dispatchEvent(new Event('input',{bubbles:true}));const rect=menu.getBoundingClientRect();return {expanded:trigger.getAttribute('aria-expanded'),visible:[...menu.querySelectorAll('.prompt-agent-model-option:not([hidden])')].map(item=>item.textContent),aboveModal:Number(getComputedStyle(menu).zIndex)>Number(getComputedStyle(document.getElementById('settings-modal')).zIndex),inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight}})()`);
        assert.deepEqual(menu, { expanded: 'true', visible: ['低成本压缩 · cheap'], aboveModal: true, inViewport: true });
        const compactionModel = await evaluate(`(async()=>{document.querySelector('#setting-agent-compaction-model-menu [data-model-id="cheap"]').click();const {diskStorage}=await import('/js/services/storage-documents.js');return diskStorage.getItem('cainflow_prompt_agent_compaction_model_id')})()`);
        assert.equal(compactionModel, 'cheap');
        assert.match(await evaluate("document.querySelector('.general-settings-compaction-control .prompt-agent-model-trigger').textContent"), /低成本压缩/);
        await evaluate("document.querySelector('.modal-tab-btn[data-tab=api]').click();document.querySelector('.modal-tab-btn[data-tab=general]').click()");
        assert.equal(await evaluate("document.getElementById('setting-agent-auto-compact-tokens').value"), '24000');
        assert.equal(await evaluate("document.getElementById('setting-agent-compaction-model').value"), 'cheap');
        assert.equal(await evaluate("document.querySelectorAll('.general-settings-compaction-control .prompt-agent-model-trigger').length"), 1);
    });
});
