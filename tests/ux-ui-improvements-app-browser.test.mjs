import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const emptySession = { autoCheckUpdatesOnLoad: false, models: [], providers: [], nodes: [], connections: [] };

test('an automatically saved new workflow has a Chinese untitled name instead of an unsaved status', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        assert.equal(await app.evaluate("document.getElementById('toolbar-workflow-name').textContent"), '未命名工作流');
        const names = await app.evaluate("fetch('/api/workflows').then(r=>r.json()).then(data=>data.workflows)");
        assert.ok(names.includes('未命名工作流'));
    });
});

test('empty canvas exposes creation actions and an expanded toolbar, then hides guidance after adding a node', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        assert.equal(await app.evaluate("document.getElementById('canvas-empty-state')?.hidden"), false);
        assert.ok(await app.evaluate("document.getElementById('toolbar').getBoundingClientRect().top>=0"));
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

test('model setup guides provider creation before adding a model and validates configuration without generation', { timeout: 45000 }, async () => {
    await withAppBrowser(emptySession, async app => {
        await app.evaluate("document.getElementById('btn-settings').click();document.getElementById('btn-add-model').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('.model-config-card').length"), 0);
        assert.equal(await app.evaluate("document.activeElement.id"), 'btn-add-provider');
        assert.match(await app.evaluate("document.getElementById('settings-api-guide').innerText"), /供应商.*模型.*检查/s);
        await app.evaluate("document.getElementById('btn-check-model-config').click()");
        assert.match(await app.evaluate("document.getElementById('settings-api-status').innerText"), /供应商/);
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
            await app.evaluate("document.querySelector('[data-parameter-action=front-parameters]').click()");
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
