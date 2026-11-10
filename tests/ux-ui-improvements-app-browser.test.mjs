import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';
import { composite, contrastRatio, parseColor } from './helpers/browser-theme-fixture.mjs';

const emptySession = { autoCheckUpdatesOnLoad: false, models: [], providers: [], nodes: [], connections: [] };

test('settings forms reflow, expose labels and keep navigation visible after scrolling', { timeout: 60000 }, async () => {
    await withAppBrowser({ ...emptySession,
        providers: [{ id: 'usable-provider', name: '本地接口', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }],
        models: Array.from({ length: 6 }, (_, index) => ({ id: `usable-model-${index}`, name: `受控模型 ${index + 1}`,
            modelId: `controlled-${index}`, taskType: 'image', protocol: 'openai', providerIds: ['usable-provider'] }))
    }, async app => {
        await app.evaluate("document.getElementById('btn-settings').click();document.querySelector('[data-provider-id=usable-provider] .card-btn-disclosure').click()");
        for (const width of [320, 420, 1120]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 842, deviceScaleFactor: 1, mobile: false });
            const form = await app.evaluate("(()=>{const body=document.getElementById('settings-body'),card=document.querySelector('[data-provider-id=usable-provider]');return {fits:body.scrollWidth<=body.clientWidth+1&&card.scrollWidth<=card.clientWidth+1,labels:[...card.querySelectorAll('.card-field input:not([aria-hidden=true])')].every(input=>input.labels.length>0),labelSize:getComputedStyle(card.querySelector('.card-field label')).fontSize}})()");
            assert.equal(form.fits, true, `${width}px supplier form must not scroll sideways`);
            assert.equal(form.labels, true, 'supplier fields retain associated labels');
            assert.ok(parseFloat(form.labelSize) >= 13);
            await app.evaluate("document.querySelector('#settings-modal [data-tab=proxy]').click()");
            assert.equal(await app.evaluate("(()=>{const body=document.getElementById('settings-body'),row=document.getElementById('proxy-test-row');return body.scrollWidth<=body.clientWidth+1&&row.scrollWidth<=row.clientWidth+1&&['proxy-enabled','proxy-ip','proxy-port'].every(id=>[...document.getElementById(id).labels].some(label=>label.textContent.trim()))})()"), true, `${width}px proxy form remains labelled and contained`);
            await app.evaluate("document.querySelector('#settings-modal [data-tab=api]').click()");
        }
        await app.evaluate("document.getElementById('settings-close').click();document.getElementById('btn-theme-toggle').click();document.querySelector('#theme-menu [data-theme-id=dark]').click();document.getElementById('btn-settings').click();document.querySelector('#settings-modal [data-tab=general]').click();document.getElementById('general-settings-category-generation').click()");
        await app.waitFor("document.getElementById('settings-modal').getAnimations({subtree:true}).every(a=>a.playState!=='running'||a.effect?.getComputedTiming().iterations===Infinity)");
        const colors = await app.evaluate("(()=>{const style=getComputedStyle(document.getElementById('general-settings-category-generation'));return {color:style.color,bg:style.backgroundColor,panel:getComputedStyle(document.querySelector('#settings-modal .modal-panel')).backgroundColor,overlay:getComputedStyle(document.getElementById('settings-modal')).backgroundColor,page:getComputedStyle(document.body).backgroundColor}})()");
        const panel = composite(parseColor(colors.panel), composite(parseColor(colors.overlay), parseColor(colors.page)));
        assert.ok(contrastRatio(parseColor(colors.color), composite(parseColor(colors.bg), panel)) >= 4.5, 'dark selected category stays readable');
        assert.equal(await app.evaluate("[...document.querySelectorAll('#general-settings label[for]')].every(label=>Boolean(label.control))"), true, 'general settings labels target existing controls');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 600, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.getElementById('settings-body').scrollTop=99999");
        const sticky = await app.evaluate("(()=>{const body=document.getElementById('settings-body'),nav=document.querySelector('.general-settings-navigation');return {scrolled:body.scrollTop>0,visible:nav.getBoundingClientRect().top>=body.getBoundingClientRect().top-1,background:getComputedStyle(nav).backgroundColor}})()");
        assert.equal(sticky.scrolled, true, 'fixture exercises a genuinely scrolled page');
        assert.equal(sticky.visible, true, 'category navigation remains reachable while scrolling');
        assert.equal(parseColor(sticky.background)[3], 1, 'sticky navigation must not show scrolling form text through it');
        await app.evaluate("document.querySelector('#settings-modal [data-tab=api]').click()");
        assert.equal(await app.evaluate("document.getElementById('settings-body').scrollTop"), 0);
        await app.evaluate("document.querySelector('#settings-modal [data-tab=general]').click();document.getElementById('settings-body').scrollTop=99999;document.getElementById('general-settings-category-advanced').click()");
        assert.equal(await app.evaluate("document.getElementById('settings-body').scrollTop"), 0, 'category changes start at their own heading');
        await app.evaluate("document.getElementById('settings-tab-button-general').focus();document.getElementById('settings-tab-button-general').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
        assert.equal(await app.evaluate("document.activeElement.id"), 'settings-tab-button-proxy');
        assert.equal(await app.evaluate("document.getElementById('settings-tab-button-proxy').getAttribute('aria-selected')"), 'true');
        await app.evaluate("document.querySelector('#settings-modal [data-tab=api]').click();document.getElementById('btn-api-settings-help').click()");
        await app.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 842, deviceScaleFactor: 1, mobile: false });
        const help = await app.evaluate("(()=>{const body=document.querySelector('#api-settings-help-dialog .api-settings-help-body');return {text:body.textContent,fits:body.scrollWidth<=body.clientWidth+1}})()");
        assert.doesNotMatch(help.text, /常规设置\s*>\s*安全|允许内网\s*\/\s*本地/);
        assert.match(help.text, /代理设置/);
        assert.equal(help.fits, true, 'help text remains readable without sideways scrolling');
    });
});

test('an automatically saved new workflow has a Chinese untitled name instead of an unsaved status', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-name').textContent"), '未命名工作流');
        const names = await app.evaluate("fetch('/api/workflows').then(r=>r.json()).then(data=>data.workflows)");
        assert.ok(names.includes('未命名工作流'));
    });
});

test('empty canvas exposes creation actions with a dismissible toolbar, then hides guidance after adding a node', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state')?.hidden"), false);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 1 });
        await app.waitFor("document.getElementById('toolbar').getBoundingClientRect().top >= -1");
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 500 });
        await app.waitFor("document.getElementById('toolbar').getBoundingClientRect().bottom <= 1");
        await app.evaluate("document.getElementById('canvas-add-first-node').click()");
        await app.waitFor("Boolean(document.querySelector('.node-picker-panel'))");
        await app.evaluate("document.querySelector('.node-picker-result[data-type=Text]').click()");
        await app.waitFor("document.getElementById('canvas-empty-state').hidden");
        assert.equal(await app.evaluate("document.querySelectorAll('#nodes-layer .node').length"), 1);
    });
});

test('missing image model offers configuration before generation can clear results or start a run', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...emptySession, nodes: [
        { id: 'needs-model', type: 'ImageGenerate', x: 80, y: 40, width: 360, prompt: '保留这个草稿' }
    ] }, async app => {
        await app.evaluate("document.querySelector('#needs-model .image-first-placeholder').click()");
        await app.waitFor("document.getElementById('image-parameter-panel')?.hidden===false");
        assert.equal(await app.evaluate("document.querySelector('[data-parameter-action=generate]').disabled"), true);
        assert.match(await app.evaluate("document.getElementById('image-parameter-panel').innerText"), /配置生图模型/);
        await app.evaluate("document.querySelector('[data-parameter-action=configure-model]').click()");
        await app.waitFor("!document.getElementById('settings-modal').classList.contains('hidden')");
        assert.equal(await app.evaluate("document.getElementById('needs-model-prompt').value"), '保留这个草稿');
        assert.equal(await app.evaluate("document.getElementById('modal-error').classList.contains('active')"), false);
    });
});

test('model settings omit the guide and require a provider before adding a model', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        await app.evaluate("document.getElementById('btn-settings').click();document.getElementById('btn-add-model').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('.model-config-card').length"), 0);
        assert.equal(await app.evaluate("document.activeElement.id"), 'btn-add-provider');
        assert.equal(await app.evaluate("document.querySelector('#settings-api-guide, #btn-check-model-config, #settings-api-status')"), null);
        assert.equal(await app.evaluate("Boolean(document.getElementById('btn-api-settings-help'))"), true);
    });
});

test('small windows retain an identifiable editing target beside the assistant without moving the canvas', { timeout: 45000 }, async () => {
    await withAppBrowser({ ...emptySession, nodes: [
        { id: 'target', type: 'ImageGenerate', x: 80, y: 40, width: 360, prompt: '保留提示词' }
    ] }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
        await app.evaluate("document.querySelector('#target .image-first-placeholder').click()");
        const before = await app.evaluate("document.getElementById('nodes-layer').style.transform");
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("document.getElementById('prompt-agent-panel').classList.contains('active')");
        assert.match(await app.evaluate("document.querySelector('.image-parameter-context')?.innerText || ''"), /图片生成/);
        assert.equal(await app.evaluate("document.getElementById('nodes-layer').style.transform"), before);
        assert.equal(await app.evaluate("document.getElementById('target-prompt').value"), '保留提示词');
        const bounds = await app.evaluate("(() => { const c=document.getElementById('canvas-container').getBoundingClientRect(),a=document.getElementById('prompt-agent-panel').getBoundingClientRect();return {canvasRight:c.right,agentLeft:a.left};})()");
        assert.ok(bounds.canvasRight <= bounds.agentLeft, 'assistant has reserved space instead of covering the canvas');
        await app.evaluate("document.getElementById('prompt-agent-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
        await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().width>=280");
        for (const width of [900, 480]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
            await app.waitFor("document.getElementById('image-parameter-panel').getBoundingClientRect().width>=280");
            await app.evaluate("document.getElementById('image-parameter-panel').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
            assert.equal(await app.evaluate("document.getElementById('target-prompt').value"), '保留提示词');
        }
    });
});

test('assistant starting examples keep drafts local and important controls readable across seven themes', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        await app.evaluate("document.getElementById('btn-prompt-agent').click()");
        await app.waitFor("Boolean(document.querySelector('.prompt-agent-empty button'))");
        for (const theme of ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink']) {
            await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(theme)}`);
            const sizes = await app.evaluate("[...document.querySelectorAll('.prompt-agent-model-label,.prompt-agent-model-hint,.prompt-agent-empty button')].map(el=>parseFloat(getComputedStyle(el).fontSize))");
            assert.ok(sizes.length >= 5 && sizes.every(size => size >= 13), theme);
        }
        await app.evaluate("document.querySelector('.prompt-agent-empty button').click()");
        assert.match(await app.evaluate("document.getElementById('prompt-agent-input').value"), /陶瓷杯/);
        assert.equal(await app.evaluate("document.querySelectorAll('.prompt-agent-message-user').length"), 0, 'example does not send a request');
        await app.evaluate("document.getElementById('prompt-agent-input').value='我已有的草稿';document.querySelectorAll('.prompt-agent-empty button')[1].click()");
        assert.equal(await app.evaluate("document.getElementById('prompt-agent-input').value"), '我已有的草稿');
    });
});
