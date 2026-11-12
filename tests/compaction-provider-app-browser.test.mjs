import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';

const models = [
    { id: 'chat', modelId: 'main-chat', name: '日常对话', taskType: 'chat', protocol: 'openai', providerIds: ['a'] },
    { id: 'compact', modelId: 'cheap-chat', name: '压缩模型', taskType: 'chat', protocol: 'openai', providerIds: ['b','c'] }
];
const providers = ['a','b','c'].map(id=>({ id, name: `供应商${id}`, endpoint: `https://${id}.test/v1`, apikey: `${id}-test-key` }));
const conversation = { version: 1, messages: [{ role: 'user', text: '保留创作目标' }, { role: 'agent', text: '已有创作上下文' }], providerSettings: { chat: { chat: 'a', compact: 'b' } } };
const workflow = { workflowId: 'compact-workflow', nodes: [], connections: [], promptAgent: conversation };
const session = { autoCheckUpdatesOnLoad: false, models, providers, ...workflow, activeWorkflowId: workflow.workflowId, activeWorkflowName: '压缩测试', workflowTabs: [{ name: '压缩测试', workflowId: workflow.workflowId, data: workflow }] };
const choose = (app, id, model, provider) => app.evaluate(`document.querySelector('#${id} + button').click();document.querySelector('#${id}-menu [data-model-id="${model}"]${provider ? `[data-provider-id="${provider}"]` : ''}').click()`);
const command = (app, text) => app.evaluate(`document.getElementById('prompt-agent-input').value=${JSON.stringify(text)};document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
const settings = async app => {
    await app.evaluate("document.getElementById('btn-settings').click();document.querySelector('.modal-tab-btn[data-tab=general]').click();document.getElementById('general-settings-category-advanced').click()");
    await app.waitFor("document.getElementById('setting-agent-compaction-model-trigger')?.checkVisibility()");
};
const closeSettings = app => app.evaluate("document.getElementById('settings-close').click()");
const openAgent = app => app.evaluate("if(!document.getElementById('prompt-agent-panel').classList.contains('active'))document.getElementById('btn-prompt-agent').click()");
const setThreshold = (app, value) => app.evaluate(`(() => {
    const field = document.getElementById('setting-agent-auto-compact-tokens');
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('change', { bubbles: true }));
})()`);

async function interceptRequests(app) {
    await app.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.compactCalls=[];const nativeFetch=fetch;window.fetch=async(url,options={})=>{if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);if(body.messages){compactCalls.push({body,headers:options.headers});const compact=body.messages[0].content.includes('你负责压缩');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(compact?{summary:'保留创作目标与已有上下文'}:{intent:'chat',message:'继续创作'})}}]}),{headers:{'Content-Type':'application/json'}})}}return nativeFetch(url,options)};` });
    await reloadAppBrowser(app);
}

test('default no-compression mode excludes the oldest turns from model requests after reload and retains the transcript', { timeout: 45000 }, async () => {
    const oldText = '最旧上下文标记：' + '较早的描述'.repeat(10000);
    const oldReply = '最旧回复标记';
    const recentText = '最近一轮要保留的要求';
    const recentReply = '最近一次回复也保留';
    const overflowWorkflow = { ...workflow, promptAgent: { ...conversation, messages: [
        { role: 'user', text: oldText }, { role: 'agent', text: oldReply },
        { role: 'user', text: recentText }, { role: 'agent', text: recentReply }
    ] } };
    await withAppBrowser({ ...session, ...overflowWorkflow, workflowTabs: [{ ...session.workflowTabs[0], data: overflowWorkflow }] }, async app => {
        await interceptRequests(app);
        await openAgent(app);
        await choose(app, 'prompt-agent-model', 'chat', 'a');
        await command(app, '/compact');
        await app.waitFor("document.getElementById('prompt-agent-command-status').textContent.includes('不压缩上下文')");
        assert.equal(await app.evaluate('compactCalls.length'), 0);
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), '');

        const latestRequest = '当前这一轮继续创作';
        await command(app, latestRequest);
        await app.waitFor("compactCalls.length===1 && document.getElementById('prompt-agent-cancel').hidden");
        const requestBody = () => app.evaluate('compactCalls[0].body');
        const assertRecentContext = (request, latest) => {
            assert.equal(request.model, 'main-chat');
            const messages = request.messages.map(message => message.content).join('\n');
            assert.doesNotMatch(messages, /你负责压缩|最旧上下文标记|最旧回复标记/);
            assert.ok(messages.includes(recentText) && messages.includes(recentReply) && messages.includes(latest));
        };
        assertRecentContext(await requestBody(), latestRequest);
        assert.match(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /最旧上下文标记/);

        await settings(app);
        await setThreshold(app, '1000000');
        await app.waitFor(`fetch('/api/storage/documents/notice_state',{cache:'no-store'}).then(response=>response.json()).then(document=>document.value?.cainflow_prompt_agent_auto_compact_tokens==='1000000')`);
        await closeSettings(app);
        await reloadAppBrowser(app);
        await openAgent(app);
        assert.match(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), /最旧上下文标记/);
        const nextRequest = '刷新后继续下一轮';
        await command(app, nextRequest);
        await app.waitFor("compactCalls.length===1 && document.getElementById('prompt-agent-cancel').hidden");
        assertRecentContext(await requestBody(), nextRequest);
    });
});

test('compaction chooses and retains its own supplier while follow-chat keeps the conversation supplier', async () => {
    await withAppBrowser(session, async app => {
        await interceptRequests(app);
        await settings(app);
        await app.evaluate("document.getElementById('setting-agent-discard-over-limit-context').click()");
        assert.equal(await app.evaluate("document.getElementById('setting-agent-discard-over-limit-context').checked"), false);
        await app.evaluate("(()=>{const select=document.getElementById('setting-agent-compaction-model');select.value='compact';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
        assert.equal(await app.evaluate("document.getElementById('setting-agent-compaction-model').value"), '', 'selecting a model alone must not infer a supplier');
        await app.evaluate("import('/js/services/storage-documents.js').then(({diskStorage})=>diskStorage.setItem('cainflow_prompt_agent_compaction_model_id','compact'))");
        await closeSettings(app);
        await settings(app);
        assert.match(await app.evaluate("document.getElementById('setting-agent-compaction-model-trigger').textContent"), /重新选择压缩模型/);
        await closeSettings(app);
        await openAgent(app);
        await command(app, '/compact');
        await app.waitFor("document.getElementById('prompt-agent-command-status').textContent.includes('供应商') && document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate('compactCalls.length'), 0, 'a legacy model without an explicit supplier does not submit a request');
        await settings(app);
        await choose(app, 'setting-agent-compaction-model', 'compact', 'b');
        await closeSettings(app);
        await openAgent(app);
        await choose(app, 'prompt-agent-model', 'compact', 'c');
        await choose(app, 'prompt-agent-model', 'chat', 'a');
        await settings(app);
        assert.match(await app.evaluate("document.querySelector('#setting-agent-compaction-model + button').textContent"), /压缩模型.*供应商b/, 'an explicit compression pair retains its supplier independently of later conversation choices');
        await app.evaluate("document.querySelector('#setting-agent-compaction-model + button').click()");
        assert.deepEqual(await app.evaluate("[...document.querySelectorAll('#setting-agent-compaction-model-menu [data-model-id=compact]')].map(option=>option.dataset.providerId).sort()"), ['b', 'c'], 'compression settings expose only actual model and supplier pairs');
        await app.evaluate("document.querySelector('#setting-agent-compaction-model-menu [data-model-id=compact][data-provider-id=c]').click()");
        assert.match(await app.evaluate("document.querySelector('#setting-agent-compaction-model + button').textContent"), /压缩模型.*供应商c/);
        await closeSettings(app);
        await openAgent(app);
        await command(app, '/compact');
        await app.waitFor("compactCalls.length===1&&document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate("compactCalls[0].body.model"), 'cheap-chat');
        assert.equal(await app.evaluate("compactCalls[0].headers.Authorization"), 'Bearer c-test-key');
        assert.match(await app.evaluate("document.querySelector('#prompt-agent-model + button').textContent"), /日常对话.*供应商a/);
        await reloadAppBrowser(app);
        await settings(app);
        assert.equal(await app.evaluate("document.getElementById('setting-agent-discard-over-limit-context').checked"), false);
        assert.match(await app.evaluate("document.querySelector('#setting-agent-compaction-model + button').textContent"), /压缩模型.*供应商c/);
        await setThreshold(app, '1');
        await closeSettings(app);
        await openAgent(app);
        await command(app, '继续创作并保留目标');
        await app.waitFor("compactCalls.some(call=>call.body.model==='cheap-chat')&&document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate("compactCalls.find(call=>call.body.model==='cheap-chat').headers.Authorization"), 'Bearer c-test-key', 'automatic compression shares the explicit manual supplier');
        assert.equal(await app.evaluate("compactCalls.find(call=>call.body.model==='main-chat').headers.Authorization"), 'Bearer a-test-key', 'conversation requests retain their own supplier');
        await settings(app);
        await setThreshold(app, '1000000');
        await choose(app, 'setting-agent-compaction-model', '', '');
        await closeSettings(app);
        await openAgent(app);
        await command(app, '新增需要跟随对话供应商压缩的目标');
        await app.waitFor("document.getElementById('prompt-agent-cancel').hidden&&compactCalls.some(call=>call.body.model==='main-chat')");
        await app.evaluate('compactCalls.length=0');
        await command(app, '/compact');
        await app.waitFor("compactCalls.length===1&&document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate("compactCalls[0].body.model"), 'main-chat');
        assert.equal(await app.evaluate("compactCalls[0].headers.Authorization"), 'Bearer a-test-key');
        await settings(app);
        await choose(app, 'setting-agent-compaction-model', 'compact', 'c');
        await app.evaluate("document.querySelector('.modal-tab-btn[data-tab=api]').click()");
        await app.evaluate("(()=>{const key=document.querySelector('#providers-list input[data-id=c][data-field=apikey]');key.value='';key.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await closeSettings(app);
        await openAgent(app);
        await command(app, '新增一条需要压缩的创作要求');
        await app.waitFor("compactCalls.length===2&&document.getElementById('prompt-agent-cancel').hidden");
        const transcript = await app.evaluate("document.getElementById('prompt-agent-messages').textContent");
        await command(app, '/compact');
        await app.waitFor("document.getElementById('prompt-agent-command-status').textContent.includes('密钥未配置')&&document.getElementById('prompt-agent-cancel').hidden");
        assert.equal(await app.evaluate('compactCalls.length'), 2, 'invalid explicit compression supplier cannot fall back to the other supplier or conversation model');
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-messages').textContent"), transcript, 'failed compression retains the conversation');
    });
});
