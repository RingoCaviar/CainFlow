import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { key, nativeClick, openParameters } from './helpers/image-first-integrated-fixture.mjs';
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
        { id: 'idle-video', type: 'VideoGenerate', x: 930, y: 50, apiConfigId: 'video-model', providerId: 'p' },
        { id: 'inline-split', type: 'TextSplit', width: 320, height: 590, userResized: true, x: 60, y: 1000,
            text: '甲/乙/丙', delimiter: '/', outputCount: 3, previewEnabled: true },
        { id: 'inline-params', type: 'CustomParams', width: 320, x: 520, y: 1000, params }
    ],
    connections: []
};

test('chat uses a compact canvas card and keeps its editable parameters and reply through reload', { timeout: 30000 }, async () => {
    const chatId = 'compact-chat';
    const prompt = '整理这段材料';
    const nextPrompt = '再用一句话概括';
    const reply = '这是新的对话回复。';
    const revisedPrompt = '补充一个实际例子';
    const revisedReply = '这是补充的例子。';
    const chatSession = {
        ...session,
        models: [{ id: 'chat-model', modelId: 'chat', name: '对话模型', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        nodes: [{ id: chatId, type: 'TextChat', x: 180, y: 120, height: 620, chatLayoutVersion: 3,
            apiConfigId: 'chat-model', providerId: 'p', prompt, sysprompt: '先分析再回答', search: true }]
    };
    await withAppBrowser(chatSession, async app => {
        const card = `#${chatId}`;
        const editor = `#${chatId}-prompt`;
        const parameterButton = `${card} button.node-chat-parameter-button`;
        const panel = '#image-parameter-panel';
        const run = `${panel} [data-parameter-action=generate]`;
        const hasVisiblePanel = `document.querySelector('${panel}[data-node-id=${chatId}]')?.checkVisibility()`;
        const text = selector => app.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
        const userRequest = "window.chatRequest?.messages.find(message => message.role === 'user').content";
        const editPrompt = async value => {
            await nativeClick(app, editor);
            await app.evaluate(`document.querySelector('${editor}').select()`);
            await app.send('Input.insertText', { text: value });
        };
        const useKeyboardToOpenAndCloseParameters = async () => {
            await app.evaluate(`document.querySelector('${parameterButton}').focus()`);
            await key(app, 'Enter');
            await app.waitFor(`${hasVisiblePanel} && document.activeElement === document.querySelector('${editor}')`);
            await key(app, 'Escape');
            await app.waitFor(`!(${hasVisiblePanel}) && document.activeElement === document.querySelector('${parameterButton}')`);
        };
        const collapsed = await app.evaluate(`(() => {
            const card = document.querySelector('${card}');
            const style = getComputedStyle(card);
            const portRow = card.querySelector('.node-ports-row');
            return {
                height: card.offsetHeight, opaque: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
                titleHidden: !card.querySelector('.node-header').checkVisibility(),
                editorInCard: !!card.querySelector('${editor}'),
                edgePorts: getComputedStyle(portRow).position === 'absolute',
                output: portRow.querySelector('.node-port.output')?.dataset.port,
                placeholder: card.querySelector('.node-body')?.textContent.includes('智能对话')
            };
        })()`);
        assert.ok(collapsed.height < 400, 'old automatic inline height is replaced by the compact card');
        const { height: cardHeight, ...appearance } = collapsed;
        assert.deepEqual(appearance, {
            opaque: true, titleHidden: true, editorInCard: false, edgePorts: true, output: 'text', placeholder: true
        });
        await useKeyboardToOpenAndCloseParameters();
        await nativeClick(app, `${card} > .node-body`);
        await app.waitFor(hasVisiblePanel);
        assert.ok(await app.evaluate(`document.querySelector('${card} > .node-header').checkVisibility()`));
        const visibleCardHeight = () => app.evaluate(`document.querySelector('${card}').offsetHeight`);
        assert.equal(await visibleCardHeight(), cardHeight, 'selecting the card leaves its geometry unchanged');
        assert.deepEqual(await app.evaluate(`(() => {
            const panel = document.querySelector('${panel}');
            return ['prompt', 'apiconfig', 'provider', 'sysprompt', 'search', 'fixed'].map(suffix => {
                const input = document.getElementById('${chatId}-' + suffix);
                return panel.contains(input) && (input.type === 'checkbox' ? input.checked : input.value);
            });
        })()`), [prompt, 'chat-model', 'p', '先分析再回答', true, false]);
        assert.equal(await app.evaluate(`document.querySelectorAll('${editor}').length`), 1);
        const answerSummary = `${panel} .node-chat-answer-settings > summary`;
        const systemSettings = `document.getElementById('${chatId}-system-settings')`;
        assert.equal(await text(answerSummary), '回答设置');
        assert.equal(await app.evaluate(`${systemSettings}.checkVisibility()`), false);
        await nativeClick(app, answerSummary);
        assert.ok(await app.evaluate(`${systemSettings}.checkVisibility() && !${systemSettings}.open`));
        await nativeClick(app, `label[for=${chatId}-fixed]`);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-fixed').checked`), true);
        await nativeClick(app, answerSummary);
        assert.equal(await app.evaluate(`${systemSettings}.checkVisibility()`), false);
        assert.equal(await text(run), '生成回复');

        await editPrompt(nextPrompt);
        await key(app, 'Escape');
        await app.waitFor(`!(${hasVisiblePanel})`);
        await openParameters(app, chatId);
        assert.equal(await app.evaluate(`document.querySelector('${editor}').value`), nextPrompt);
        assert.equal(await visibleCardHeight(), cardHeight, 'editing the floating parameters does not grow the card');

        await nativeClick(app, run);
        await app.waitFor('window.chatRequest');
        assert.equal(await app.evaluate(userRequest), nextPrompt);
        assert.equal(await app.evaluate(`document.querySelector('${run}').disabled`), true);
        await app.evaluate('window.releaseChatReply()');
        await app.waitFor(`document.querySelector('${card} #${chatId}-response')?.textContent.includes(${JSON.stringify(reply)})`);
        await app.waitFor(`!document.querySelector('${run}').disabled`);
        assert.equal(await text(`#${chatId}-response`), reply);
        const replyHeight = await visibleCardHeight();
        assert.ok(replyHeight < 300, 'a short reply keeps the card compact');

        await key(app, 'Escape');
        await app.waitFor(`!(${hasVisiblePanel})`);
        const drag = await app.evaluate(`(() => {
            const response = document.getElementById('${chatId}-response');
            const range = document.createRange();
            range.selectNodeContents(response.querySelector('p') || response);
            const line = range.getBoundingClientRect();
            const y = line.top + line.height / 2;
            return [{ x: line.left + 1, y }, { x: line.right - 1, y }];
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...drag[0], button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...drag[1], button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...drag[1], button: 'left', buttons: 0, clickCount: 1 });
        assert.match(await app.evaluate('window.getSelection().toString()'), /对话回复/);
        assert.equal(await app.evaluate(`Boolean(${hasVisiblePanel})`), false, 'selecting reply text leaves the parameters closed');
        await useKeyboardToOpenAndCloseParameters();
        await nativeClick(app, `#${chatId}-preview-btn`);
        await app.waitFor("document.querySelector('#node-text-response-preview-dialog')?.checkVisibility()");
        assert.equal(await text('.node-text-response-preview-text'), reply);
        await key(app, 'Escape');
        await app.waitFor("!document.querySelector('#node-text-response-preview-dialog')");
        await nativeClick(app, `#${chatId}-response`);
        await app.waitFor(hasVisiblePanel);
        assert.equal(await visibleCardHeight(), replyHeight);

        await reloadAppBrowser(app);
        assert.equal(await text(`#${chatId}-response`), reply);
        await app.evaluate(`
            document.getElementById('btn-theme-toggle').click();
            document.querySelector('#theme-menu [data-theme-id=paper]').click();
        `);
        await app.waitFor("document.documentElement.dataset.appTheme === 'paper'");
        await app.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 640, deviceScaleFactor: 1, mobile: false });
        await openParameters(app, chatId);
        await app.waitFor(`(() => {
            const bounds = document.querySelector('${panel}').getBoundingClientRect();
            const button = document.querySelector('${run}').getBoundingClientRect();
            return bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth
                && button.height > 0 && button.top >= 0 && button.bottom <= innerHeight;
        })()`);
        assert.equal(await app.evaluate(`document.querySelector('${editor}').value`), nextPrompt);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-search').checked`), true);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-fixed').checked`), true);
        await editPrompt(revisedPrompt);
        await nativeClick(app, run);
        await app.waitFor(`${userRequest} === ${JSON.stringify(revisedPrompt)}`);
        await app.evaluate('window.releaseChatReply()');
        await app.waitFor(`document.getElementById('${chatId}-response').textContent.includes(${JSON.stringify(revisedReply)})`);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-fixed').checked`), true);
    }, { initScript: `
        const originalFetch = window.fetch;
        window.fetch = async (url, options) => {
            if (url !== '/proxy' || !options?.body) return originalFetch(url, options);
            window.chatRequest = JSON.parse(options.body);
            await new Promise(resolve => { window.releaseChatReply = resolve; });
            const question = window.chatRequest.messages.find(message => message.role === 'user').content;
            const content = question === ${JSON.stringify(revisedPrompt)} ? ${JSON.stringify(revisedReply)} : ${JSON.stringify(reply)};
            return Response.json({ choices: [{ message: { content } }] });
        };
    ` });
});

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
        assert.equal(offColor, await app.evaluate("getComputedStyle(document.querySelector('#inline-split-merge-output-enabled + .toggle-slider')).backgroundColor"));
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
