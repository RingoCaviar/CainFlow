import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';

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
        await evaluate("document.querySelector('[data-settings-category=advanced]').click()");
        await waitFor("Boolean(document.getElementById('setting-agent-auto-compact-tokens'))");
        const value = await evaluate(`(async()=>{const input=document.getElementById('setting-agent-auto-compact-tokens');input.value='24000';input.dispatchEvent(new Event('change',{bubbles:true}));const {diskStorage}=await import('/js/services/storage-documents.js');return diskStorage.getItem('cainflow_prompt_agent_auto_compact_tokens')})()`);
        assert.equal(value, '24000');
        const menu = await evaluate(`(()=>{const trigger=document.querySelector('.general-settings-compaction-control .prompt-agent-model-trigger');trigger.click();const menu=document.getElementById('setting-agent-compaction-model-menu');const search=menu.querySelector('.prompt-agent-model-search');search.value='低成本';search.dispatchEvent(new Event('input',{bubbles:true}));const rect=menu.getBoundingClientRect();return {expanded:trigger.getAttribute('aria-expanded'),visible:[...menu.querySelectorAll('.prompt-agent-model-option:not([hidden])')].map(item=>item.textContent),aboveModal:Number(getComputedStyle(menu).zIndex)>Number(getComputedStyle(document.getElementById('settings-modal')).zIndex),inViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight}})()`);
        assert.deepEqual(menu, { expanded: 'true', visible: ['低成本压缩 · 受控供应商'], aboveModal: true, inViewport: true });
        const compactionModel = await evaluate(`(async()=>{document.querySelector('#setting-agent-compaction-model-menu [data-model-id="cheap"]').click();const {diskStorage}=await import('/js/services/storage-documents.js');return diskStorage.getItem('cainflow_prompt_agent_compaction_model_id')})()`);
        assert.equal(compactionModel, 'cheap');
        assert.match(await evaluate("document.querySelector('.general-settings-compaction-control .prompt-agent-model-trigger').textContent"), /低成本压缩 · 受控供应商/);
        await evaluate("document.querySelector('.modal-tab-btn[data-tab=api]').click();document.querySelector('.modal-tab-btn[data-tab=general]').click()");
        assert.equal(await evaluate("document.getElementById('setting-agent-auto-compact-tokens').value"), '24000');
        assert.equal(await evaluate("document.getElementById('setting-agent-compaction-model').value"), 'cheap');
        assert.equal(await evaluate("document.querySelectorAll('.general-settings-compaction-control .prompt-agent-model-trigger').length"), 1);
    });
});

test('settings cards expose labelled fields and keyboard disclosure while names preserve identities through reorder and reopen', { timeout: 60000 }, async () => {
    const providerName = '工作室 "A" <一>';
    const modelName = '猫咪 "图像" <2.5> &';
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        providers: [{ id: 'rename-p1', name: '供应商一', endpoint: 'https://controlled.test/v1', apikey: 'fixture' },
            { id: 'rename-p2', name: '供应商二', endpoint: 'https://controlled-2.test/v1', apikey: 'fixture' }],
        models: [{ id: 'rename-m1', name: '模型一', modelId: 'code-1', taskType: 'image', protocol: 'openai', providerIds: ['rename-p1'] },
            { id: 'rename-m2', name: '模型二', modelId: 'code-2', taskType: 'chat', protocol: 'openai', providerIds: ['rename-p2'] }],
        nodes: [], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('btn-settings').click()");
        assert.equal(await app.evaluate("document.querySelector('#settings-api-guide,#btn-check-model-config,#settings-api-status')"), null);
        const click = async point => {
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        };
        const blankHeader = async selector => {
            await app.evaluate("document.querySelector(" + JSON.stringify(selector) + ").scrollIntoView({block:'center'})");
            return app.evaluate("(()=>{const card=document.querySelector(" + JSON.stringify(selector) + "),name=card.querySelector('.card-name').getBoundingClientRect(),actions=card.querySelector('.card-header-actions').getBoundingClientRect();return {x:(name.right+actions.left)/2,y:name.y+name.height/2}})()");
        };
        const press = async (key, code, keyCode) => {
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key === 'Enter' ? '\r' : key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
        };
        const disclosureState = selector => app.evaluate("(()=>{const card=document.querySelector(" + JSON.stringify(selector) + "),button=card.querySelector('.card-btn-disclosure'),content=document.getElementById(button.getAttribute('aria-controls'));return {native:button.tagName==='BUTTON'&&button.type==='button',expanded:button.getAttribute('aria-expanded'),label:button.getAttribute('aria-label'),controlsOwnContent:content===card.querySelector('.card-collapsible'),visible:!!content.getClientRects().length,focused:document.activeElement===button,collapsed:card.classList.contains('is-collapsed')}})()");
        for (const [selector, title, labels] of [
            ['[data-provider-id="rename-p1"]', '供应商配置：供应商一', { apikey: 'API 密钥', endpoint: 'API 地址', responsesEndpoint: '独立 Responses 地址（关闭自动补全时用于 Agent 搜索）' }],
            ['[data-model-id="rename-m1"]', '模型配置：模型一', { modelId: '模型代码 (Model ID)', taskType: '模型用途', protocol: '兼容格式' }]
        ]) {
            await app.evaluate('document.querySelector(' + JSON.stringify(selector + ' .card-btn-disclosure') + ').focus()');
            assert.deepEqual(await disclosureState(selector), { native: true, expanded: 'false', label: '展开' + title, controlsOwnContent: true, visible: false, focused: true, collapsed: true });
            await press('Enter', 'Enter', 13);
            assert.deepEqual(await disclosureState(selector), { native: true, expanded: 'true', label: '收起' + title, controlsOwnContent: true, visible: true, focused: true, collapsed: false });
            const fieldLabels = await app.evaluate("(()=>{const card=document.querySelector(" + JSON.stringify(selector) + ");return Object.fromEntries([...card.querySelectorAll('[data-field]')].filter(input=>input.dataset.field!=='name'&&input.dataset.field!=='autoComplete').map(input=>[input.dataset.field,[...input.labels].map(label=>label.textContent.trim()).join(' ')]))})()");
            assert.deepEqual(fieldLabels, labels);
            const tree = await app.send('Accessibility.getFullAXTree');
            const names = tree.nodes.filter(node => !node.ignored && ['textbox', 'combobox', 'button'].includes(node.role?.value)).map(node => node.name?.value);
            for (const label of Object.values(labels)) assert.ok(names.some(name => name?.toLowerCase() === label.toLowerCase()), `${label} is exposed as the control's accessible name`);
            if (selector.includes('provider')) {
                assert.equal(await app.evaluate("document.querySelector('[data-provider-id=rename-p1] label[for$=apikey]').control.type"), 'password', 'the key label targets the password rather than the hidden username');
                assert.equal(await app.evaluate("document.querySelector('[data-provider-id=rename-p1] input[autocomplete=username]').labels.length"), 0);
            } else {
                assert.ok(names.includes('绑定供应商 供应商一'));
                assert.equal(await app.evaluate("document.querySelector('[data-model-id=rename-m1] label[for$=providers]').control.className"), 'provider-multiselect-trigger');
            }
            await press(' ', 'Space', 32);
            assert.deepEqual(await disclosureState(selector), { native: true, expanded: 'false', label: '展开' + title, controlsOwnContent: true, visible: false, focused: true, collapsed: true });
        }
        for (const [selector, name, label] of [
            ['[data-provider-id="rename-p1"]', providerName, '供应商名称'],
            ['[data-model-id="rename-m1"]', modelName, '模型名称']
        ]) {
            const initial = await app.evaluate("(()=>{const card=document.querySelector(" + JSON.stringify(selector) + "),input=card.querySelector('.card-name');input.scrollIntoView({block:'center'});const r=input.getBoundingClientRect(),icon=card.querySelector('.card-name-edit-icon').getBoundingClientRect();return {collapsed:card.classList.contains('is-collapsed'),readonly:input.readOnly,label:input.getAttribute('aria-label'),point:{x:r.x+r.width/2,y:r.y+r.height/2},editCue:{x:icon.x+icon.width/2,y:icon.y+icon.height/2}}})()");
            assert.equal(initial.collapsed, true); assert.equal(initial.readonly, false); assert.equal(initial.label, label);
            await click(initial.editCue);
            assert.equal(await app.evaluate('document.activeElement.matches(' + JSON.stringify(selector + ' .card-name') + ')'), true, 'the edit cue focuses the same input directly');
            assert.equal(await app.evaluate('document.querySelector(' + JSON.stringify(selector) + ').classList.contains("is-collapsed")'), true, 'edit cue must not fold the card');
            await click(initial.point);
            assert.equal(await app.evaluate('document.activeElement.matches(' + JSON.stringify(selector + ' .card-name') + ')'), true);
            await app.evaluate('document.activeElement.select()');
            await app.send('Input.insertText', { text: name });
            assert.equal(await app.evaluate('document.querySelector(' + JSON.stringify(selector) + ').classList.contains("is-collapsed")'), true);
            // One native blank-header click must both commit the name and expand.
            await click(await blankHeader(selector));
            assert.equal(await app.evaluate('document.querySelector(' + JSON.stringify(selector) + ').classList.contains("is-collapsed")'), false);
            await click(await blankHeader(selector));
            assert.equal(await app.evaluate('document.querySelector(' + JSON.stringify(selector) + ').classList.contains("is-collapsed")'), true);
            assert.equal(await app.evaluate('document.querySelector(' + JSON.stringify(selector + ' .card-name') + ').value'), name);
        }
        for (const [list, attribute, first, second] of [
            ['providers-list', 'providerId', 'rename-p1', 'rename-p2'],
            ['models-list', 'modelId', 'rename-m1', 'rename-m2']
        ]) {
            const order = await app.evaluate("(()=>{const list=document.getElementById(" + JSON.stringify(list) + "),cards=[...list.children],target=cards[0],handle=cards[1].querySelector('.card-drag-handle'),transfer=new DataTransfer(),y=target.getBoundingClientRect().top+1;handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:y}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return [...list.children].map(card=>card.dataset[" + JSON.stringify(attribute) + "])})()");
            assert.deepEqual(order, [second, first]);
        }
        await app.evaluate("document.querySelector('[data-provider-id=rename-p1] .card-btn-fetch-models').click()");
        await app.waitFor("document.querySelector('.provider-models-row-name')?.textContent.includes('controlled-listed')");
        assert.equal(await app.evaluate("document.querySelector('[data-provider-id=rename-p1]').classList.contains('is-collapsed')"), true);
        await app.evaluate("document.querySelector('.provider-models-close').click()");
        for (const selector of ['[data-model-id="rename-m2"]', '[data-provider-id="rename-p2"]']) {
            const icon = await app.evaluate("(()=>{const button=document.querySelector(" + JSON.stringify(selector + ' .card-btn-delete') + ");return {label:button.getAttribute('aria-label'),href:button.querySelector('use')?.getAttribute('href')}})()");
            assert.match(icon.label, /删除此(?:模型|供应商)/);
            assert.equal(icon.href, '#icon-trash');
            await app.evaluate('document.querySelector(' + JSON.stringify(selector + ' .card-btn-delete svg') + ').dispatchEvent(new MouseEvent("click",{bubbles:true}))');
            await app.waitFor("Boolean(document.querySelector('#app-action-dialog [data-dialog-style-1-action=cancel]')?.getClientRects().length)");
            await app.evaluate("document.querySelector('#app-action-dialog [data-dialog-style-1-action=cancel]').click()");
            assert.equal(await app.evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))'), true, 'cancel leaves the target configuration intact');
            await app.evaluate('document.querySelector(' + JSON.stringify(selector + ' .card-btn-delete use') + ').dispatchEvent(new MouseEvent("click",{bubbles:true}))');
            await app.waitFor("Boolean(document.querySelector('#app-action-dialog [data-dialog-style-1-action=confirm]')?.getClientRects().length)");
            await app.evaluate("document.querySelector('#app-action-dialog [data-dialog-style-1-action=confirm]').click()");
            await app.waitFor('!document.querySelector(' + JSON.stringify(selector) + ')');
        }
        await app.evaluate("document.getElementById('settings-close').click()");
        await waitForAutosave(app);
        await reloadAppBrowser(app);
        await app.evaluate("document.getElementById('btn-settings').click()");
        const reopened = await app.evaluate("(()=>{const p=document.querySelector('[data-provider-id=rename-p1]'),m=document.querySelector('[data-model-id=rename-m1]');return {provider:p.querySelector('.card-name').value,model:m.querySelector('.card-name').value,modelCode:m.querySelector('[data-field=modelId]').value,binding:m.querySelector('.provider-multiselect-summary').textContent,endpoint:p.querySelector('[data-field=endpoint]').value,providerCount:document.querySelectorAll('.provider-config-card').length,modelCount:document.querySelectorAll('.model-config-card').length}})()");
        assert.equal(reopened.provider, providerName); assert.equal(reopened.model, modelName);
        assert.equal(reopened.modelCode, 'code-1'); assert.ok(reopened.binding.includes(providerName));
        assert.equal(reopened.endpoint, 'https://controlled.test/v1');
        assert.equal(reopened.providerCount, 1); assert.equal(reopened.modelCount, 1);
    }, { initScript: "const originalSettingsFetch=window.fetch.bind(window);window.fetch=(url,options)=>String(url)==='/api/provider_models'?Promise.resolve(new Response(JSON.stringify({data:[{id:'controlled-listed'}]}),{headers:{'Content-Type':'application/json'}})):originalSettingsFetch(url,options);" });
});
