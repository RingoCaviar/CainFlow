import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { getProtocolVariantDraftKey } from '../js/nodes/protocol-variant-drafts.js';

const params = Array.from({ length: 11 }, (_, index) => ({ key: `setting_${index}`, value: `${index}` }));
const videoProtocolParams = { prompt: '树影在傍晚随风晃动', systemPrompt: '固定节奏' };
const videoDraftKey = getProtocolVariantDraftKey('doubao-video', 'doubao-seedance-1-5-pro');
const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'video-model', modelId: 'doubao-seedance-1-5-pro', name: '视频模型', protocol: 'doubao-video', taskType: 'video', providerIds: ['p'] }],
    providers: [{ id: 'p', name: '视频供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [
        { id: 'inline-video', type: 'VideoGenerate', width: 360, userResized: true, x: 60, y: 50,
            apiConfigId: 'video-model', providerId: 'p', protocolParams: videoProtocolParams,
            protocolVariantKey: videoDraftKey, protocolVariantDrafts: { [videoDraftKey]: videoProtocolParams },
            videoId: 'saved-video-job', videoStatus: 'processing', videoStatusText: '正在处理已提交任务' },
        { id: 'inline-chat', type: 'TextChat', x: 520, y: 50, prompt: '待回答的问题', systemPrompt: '先分析再回答' },
        { id: 'idle-video', type: 'VideoGenerate', x: 930, y: 50, apiConfigId: 'video-model', providerId: 'p' },
        { id: 'inline-split', type: 'TextSplit', width: 320, height: 590, userResized: true, x: 60, y: 1000,
            text: '甲/乙/丙', delimiter: '/', outputCount: 3, previewEnabled: true },
        { id: 'inline-params', type: 'CustomParams', width: 320, x: 520, y: 1000, params }
    ],
    connections: []
};

test('inline node parameters group declared controls, preserve drafts and keep long lists inside their cards', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        const sectionHeadings = id => app.evaluate(`Array.from(document.querySelectorAll('#${id} .node-parameter-heading'), heading => heading.textContent)`);
        await app.waitFor("document.getElementById('inline-video-param-duration')?.id");
        assert.deepEqual(await sectionHeadings('inline-video'), ['创作内容', '输出设置', '任务与结果']);
        assert.deepEqual(await app.evaluate(`(() => {
            const field = suffix => document.getElementById('inline-video-param-' + suffix);
            return ['prompt', 'duration', 'resolution', 'generate_audio', 'systemPrompt', 'camera_fixed'].map(suffix => {
                const control = field(suffix);
                return [control.closest('[data-video-protocol-fields]').dataset.videoProtocolFields,
                    control.closest('#inline-video-protocol-params')?.id];
            });
        })()`), ['content', 'output', 'output', 'output', 'advanced', 'advanced'].map(section => [section, 'inline-video-protocol-params']));
        const video = suffix => `document.getElementById('inline-video-${suffix}')`;
        assert.equal(await app.evaluate(`${video('param-prompt')}.value`), '树影在傍晚随风晃动');
        const audioToggle = video('param-generate_audio');
        const audioTrackColor = `getComputedStyle(${audioToggle}.nextElementSibling).backgroundColor`;
        const offColor = await app.evaluate(audioTrackColor);
        assert.equal(offColor, await app.evaluate("getComputedStyle(document.querySelector('#inline-chat .node-chat-option .toggle-slider')).backgroundColor"));
        await app.evaluate(`${audioToggle}.click()`);
        await app.waitFor(`${audioToggle}.checked && ${audioTrackColor} !== ${JSON.stringify(offColor)}`);
        const advancedPrompt = video('param-systemPrompt');
        assert.equal(await app.evaluate(`${advancedPrompt}.checkVisibility()`), false);
        assert.ok(await app.evaluate(`${video('resume-video-id')}.closest('details').open && ${video('resume-video-id')}.value === 'saved-video-job'`));
        assert.match(await app.evaluate(`${video('video-status')}.textContent`), /正在处理已提交任务/);
        assert.ok(await app.evaluate("document.getElementById('idle-video-video-status').checkVisibility()"));
        assert.equal(await app.evaluate("document.getElementById('idle-video-response').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.getElementById('idle-video-download-video').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.querySelector('#idle-video .node-video-recovery').open"), false);

        await app.evaluate(`(() => {
            const prompt = ${advancedPrompt};
            const more = prompt.closest('details').querySelector('summary');
            more.click();
            prompt.value = '缓慢摇镜';
            prompt.dispatchEvent(new Event('change', { bubbles: true }));
            more.click();
        })()`);
        assert.equal(await app.evaluate(`${advancedPrompt}.checkVisibility()`), false);
        await app.evaluate(`${advancedPrompt}.closest('details').querySelector('summary').click()`);
        assert.equal(await app.evaluate(`${advancedPrompt}.value`), '缓慢摇镜');

        assert.deepEqual(await sectionHeadings('inline-chat'), ['提问内容', '回答设置', '对话回复']);
        assert.ok(await app.evaluate("document.querySelector('#inline-chat .node-chat-answer-section #inline-chat-system-settings').open === false"));
        assert.ok(await app.evaluate("document.querySelector('#inline-chat .node-chat-result-section #inline-chat-response')"));
        assert.equal(await app.evaluate("document.getElementById('inline-chat-generation-progress').checkVisibility()"), false);

        assert.deepEqual(await sectionHeadings('inline-split'), ['拆分规则', '输出方式', '片段预览']);
        assert.equal(await app.evaluate("document.querySelectorAll('#inline-split-split-preview .text-split-preview-item').length"), 3);
        assert.ok(await app.evaluate(`(() => {
            const preview = document.getElementById('inline-split-split-preview');
            const node = document.getElementById('inline-split');
            return preview.offsetHeight > 120 && preview.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom;
        })()`), 'manually allocated height leaves usable space for the preview inside the card');
        await app.evaluate("document.getElementById('inline-split-preview-enabled').click(); document.getElementById('inline-split-merge-output-enabled').click()");
        assert.equal(await app.evaluate("document.getElementById('inline-split-split-preview').checkVisibility()"), false);
        assert.match(await app.evaluate("document.getElementById('inline-split-split-summary').textContent"), /多合一输出为 1 个端口/);
        assert.equal(await app.evaluate("document.getElementById('inline-split-output-count').disabled"), true);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('#inline-split .node-port.output'), port => port.dataset.port)"), ['text']);

        const metrics = await app.evaluate(`(() => {
            const node = document.getElementById('inline-params');
            const list = document.getElementById('inline-params-params-list');
            const columns = node.querySelector('.custom-param-columns');
            const body = node.querySelector('.node-body');
            return {
                rowCount: list.children.length,
                scrolls: list.scrollHeight > list.clientHeight,
                aligned: Array.from(columns.children).every((label, index) =>
                    Math.abs(label.getBoundingClientRect().left - list.firstElementChild.children[index].getBoundingClientRect().left) < 1),
                listHeight: list.offsetHeight,
                bodyHeight: body.offsetHeight,
                tailHeight: node.offsetHeight - (body.offsetTop + body.offsetHeight),
                buttonBelow: node.querySelector('.custom-param-add').offsetTop > list.offsetTop
            };
        })()`);
        assert.equal(metrics.rowCount, 11);
        assert.ok(metrics.scrolls && metrics.aligned && metrics.buttonBelow && metrics.bodyHeight < metrics.listHeight + 140 && metrics.tailHeight < 24, JSON.stringify(metrics));
        await app.evaluate(`(() => {
            document.getElementById('inline-params-add-param').click();
            const key = document.getElementById('inline-params-param-key-11');
            key.value = 'new_param';
            key.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await app.evaluate('document.activeElement.id'), 'inline-params-param-key-11');
        assert.ok(await app.evaluate("document.getElementById('inline-params-params-list').scrollTop > 0"));
        assert.ok(await app.evaluate("Boolean(document.querySelector('#inline-params .node-port[data-port=param_new_param]'))"));
        await app.evaluate("document.querySelector('#inline-params-params-list > :last-child .custom-param-remove').click()");
        assert.equal(await app.evaluate("document.querySelectorAll('#inline-params-params-list > [data-param-row]').length"), 11);
        assert.equal(await app.evaluate("Boolean(document.querySelector('#inline-params .node-port[data-port=param_new_param]'))"), false);

        await reloadAppBrowser(app);
        assert.equal(await app.evaluate(`${advancedPrompt}.checkVisibility()`), false);
        await app.evaluate(`${advancedPrompt}.closest('details').querySelector('summary').click()`);
        assert.equal(await app.evaluate(`${advancedPrompt}.value`), '缓慢摇镜');
    });
});
