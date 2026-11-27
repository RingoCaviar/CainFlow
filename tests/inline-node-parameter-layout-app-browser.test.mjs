import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { key, nativeClick, openParameters, persist } from './helpers/image-first-integrated-fixture.mjs';
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

test('chat introduces the question first and explains what is needed to generate', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', name: '对话模型', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '供应商', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [
            { id: 'blank-chat', type: 'TextChat', x: 140, y: 90, apiConfigId: 'chat', providerId: 'p' },
            { id: 'linked-chat', type: 'TextChat', x: 640, y: 90, apiConfigId: 'chat', providerId: 'p' },
            { id: 'empty-linked-chat', type: 'TextChat', x: 640, y: 450, apiConfigId: 'chat', providerId: 'p' },
            { id: 'source', type: 'Text', x: 140, y: 450, text: '来自文本节点的问题' },
            { id: 'empty-source', type: 'Text', x: 140, y: 700, text: '   ' }
        ],
        connections: [
            { id: 'question-link', type: 'text', from: { nodeId: 'source', port: 'text' }, to: { nodeId: 'linked-chat', port: 'prompt' } },
            { id: 'empty-question-link', type: 'text', from: { nodeId: 'empty-source', port: 'text' }, to: { nodeId: 'empty-linked-chat', port: 'prompt' } }
        ]
    }, async app => {
        const action = "document.querySelector('#image-parameter-panel [data-parameter-action=generate]')";
        const message = "document.querySelector('#image-parameter-panel .image-parameter-feedback')";
        await openParameters(app, 'blank-chat');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel .image-first-parameter-content > section').getAttribute('aria-labelledby')"), 'blank-chat-question-heading');
        assert.equal(await app.evaluate(`${action}.disabled`), true);
        assert.equal(await app.evaluate(`${message}.textContent`), '先输入你想问的问题');

        await nativeClick(app, '#blank-chat-prompt');
        await app.send('Input.insertText', { text: '帮我总结这段文案' });
        assert.equal(await app.evaluate(`${action}.disabled`), false);
        await openParameters(app, 'linked-chat');
        assert.equal(await app.evaluate(`${action}.disabled`), false);
        assert.equal(await app.evaluate("document.getElementById('linked-chat-question-source').textContent"), '运行时优先使用连接的文本');
        await app.evaluate("document.querySelector('#source .node-bypass-btn').click()");
        await app.waitFor(`${action}.disabled`);
        assert.equal(await app.evaluate("document.getElementById('linked-chat-question-source').hidden"), true);
        assert.equal(await app.evaluate(`${message}.textContent`), '先输入你想问的问题');
        await openParameters(app, 'empty-linked-chat');
        assert.equal(await app.evaluate(`${action}.disabled`), true);
        assert.equal(await app.evaluate("document.getElementById('empty-linked-chat-question-source').textContent"), '连接的节点还没有文本');
        await nativeClick(app, '#empty-linked-chat-prompt');
        await app.send('Input.insertText', { text: '使用本地提问' });
        await nativeClick(app, '#image-parameter-panel [data-parameter-action=generate]');
        await app.waitFor("window.sentChatQuestion === '使用本地提问'");
        await app.waitFor("document.getElementById('empty-linked-chat-response').textContent.trim() === '收到问题'");
    }, { initScript: `
        const originalFetch = window.fetch;
        window.fetch = async (url, options) => {
            if (url !== '/proxy' || !options?.body) return originalFetch(url, options);
            window.sentChatQuestion = JSON.parse(options.body).messages.find(message => message.role === 'user').content;
            return Response.json({ choices: [{ message: { content: '收到问题' } }] });
        };
    ` });
});

test('an unconfigured chat directs the user to model settings', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'unconfigured-chat', type: 'TextChat', x: 140, y: 90, prompt: '帮我总结这段文案' }]
    }, async app => {
        await openParameters(app, 'unconfigured-chat');
        const config = "document.querySelector('#image-parameter-panel .image-parameter-configuration')";
        assert.equal(await app.evaluate(`${config}.checkVisibility()`), true);
        assert.equal(await app.evaluate(`${config}.querySelector('button').textContent`), '配置对话模型');
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-parameter-action=generate]').disabled"), true);
        await nativeClick(app, '#image-parameter-panel [data-parameter-action=configure-model]');
        await app.waitFor("document.getElementById('settings-modal').checkVisibility()");
    });
});

test('chat settings stay reachable in a narrow window without growing the primary panel', { timeout: 30000 }, async () => {
    const initialSystemPrompt = `${'甲'.repeat(27)}👩‍💻 سلام`;
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'narrow-chat', type: 'TextChat', x: 70, y: 210, prompt: '概括这段描述',
            sysprompt: initialSystemPrompt }]
    }, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 470, deviceScaleFactor: 1, mobile: false });
        await openParameters(app, 'narrow-chat');
        const panel = "document.getElementById('image-parameter-panel')";
        assert.equal(await app.evaluate("document.getElementById('narrow-chat-question-heading').checkVisibility()"), false);
        assert.equal(await app.evaluate(`(() => {
            const prompt = document.getElementById('narrow-chat-prompt').getBoundingClientRect();
            const buttons = [...${panel}.querySelectorAll('.image-parameter-footer button')].map(button => button.getBoundingClientRect());
            return Math.abs(buttons[0].left - prompt.left) < 1 &&
                Math.abs(buttons.at(-1).right - prompt.right) < 1 &&
                buttons.every(rect => Math.abs(rect.top - buttons[0].top) < 1 && rect.height === buttons[0].height);
        })()`), true, 'footer controls align with each other and with both edges of the prompt');
        const { nodes: accessibilityNodes } = await app.send('Accessibility.getFullAXTree');
        assert.ok(accessibilityNodes.some(node => node.role?.value === 'textbox' && node.name?.value === '提问内容'));
        const before = await app.evaluate(`${panel}.offsetHeight`);
        const trigger = '#image-parameter-panel [data-parameter-group-toggle=answer]';
        await app.evaluate(`document.querySelector('${trigger}').focus()`);
        await key(app, 'Enter');
        const popup = `${panel}.querySelector('.image-parameter-settings-popup')`;
        await app.waitFor(`${popup}.matches(':popover-open')`);
        assert.equal(await app.evaluate(`${popup}.contains(document.activeElement)`), true);
        assert.deepEqual(await app.evaluate(`(() => {
            const popup = ${popup};
            return {
                name: popup.getAttribute('aria-label'),
                heading: document.getElementById('narrow-chat-answer-heading').checkVisibility(),
                helpSize: getComputedStyle(document.getElementById('narrow-chat-search-help')).fontSize,
                labelSize: getComputedStyle(popup.querySelector('label[for="narrow-chat-search"]')).fontSize
            };
        })()`), { name: '回答设置', heading: false, helpSize: '11px', labelSize: '13px' });
        const fit = await app.evaluate(`(() => {
            const menu = ${popup};
            const bounds = menu.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight &&
                menu.scrollWidth <= menu.clientWidth + 1;
        })()`);
        assert.equal(fit, true);
        assert.equal(await app.evaluate(`(() => {
            const answer = ${popup}.querySelector('.node-chat-answer-section');
            const disclosure = answer.querySelector('summary');
            const inset = parseFloat(getComputedStyle(disclosure).paddingInlineStart);
            const disclosureLeft = disclosure.getBoundingClientRect().left + inset;
            return [...answer.querySelectorAll('.node-chat-option')].every(option => {
                const copy = option.querySelector('.node-chat-option-copy').getBoundingClientRect();
                const toggle = option.querySelector('.toggle-switch').getBoundingClientRect();
                return Math.abs(copy.left - disclosureLeft) < 1 &&
                    Math.abs(toggle.right - (disclosure.getBoundingClientRect().right - inset)) < 1 &&
                    Math.abs(copy.top + copy.height / 2 - toggle.top - toggle.height / 2) < 1;
            });
        })()`), true, 'switches center on the accompanying text and share the disclosure insets');
        const previewText = "document.getElementById('narrow-chat-system-summary').textContent";
        assert.equal(await app.evaluate(previewText), `已设置 · ${'甲'.repeat(27)}👩‍💻`);
        const summary = '#narrow-chat-system-settings > summary';
        assert.equal(await app.evaluate(`(() => {
            const [label, preview] = document.querySelector('${summary}').children;
            return preview.textContent.startsWith('已设置') &&
                Math.abs(label.getBoundingClientRect().top - preview.getBoundingClientRect().top) < 4 &&
                preview.getBoundingClientRect().right <= document.querySelector('${summary}').getBoundingClientRect().right;
        })()`), true);
        await app.evaluate(`document.querySelector('${summary}').focus()`);
        await key(app, 'Enter');
        await app.waitFor("document.getElementById('narrow-chat-system-settings').open");
        const promptField = "document.getElementById('narrow-chat-sysprompt')";
        assert.equal(await app.evaluate(`${promptField}.checkVisibility()`), true);
        await app.evaluate(`${promptField}.focus(); ${promptField}.select()`);
        const updatedPreview = `${'丁'.repeat(27)}e\u0301`;
        await app.send('Input.insertText', { text: `${updatedPreview} 테스트` });
        await app.evaluate(`document.querySelector('${summary}').focus()`);
        await app.waitFor(`${previewText} === ${JSON.stringify(`已设置 · ${updatedPreview}`)}`);
        assert.equal(await app.evaluate(`${panel}.offsetHeight`), before);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 275, deviceScaleFactor: 1, mobile: false });
        await app.waitFor(`${popup}.getBoundingClientRect().bottom < document.querySelector('${trigger}').getBoundingClientRect().top`);
        const model = '#image-parameter-panel [data-parameter-group-toggle=model]';
        await nativeClick(app, model);
        await app.waitFor(`${popup}.getAttribute('aria-label') === '模型与供应商'`);
        await nativeClick(app, trigger);
        await app.waitFor(`${popup}.getAttribute('aria-label') === '回答设置'`);
        assert.equal(await app.evaluate(previewText), `已设置 · ${updatedPreview}`);
        await key(app, 'Escape');
        assert.equal(await app.evaluate(`document.activeElement.matches('${trigger}')`), true);

        await app.send('Emulation.setDeviceMetricsOverride', { width: 280, height: 470, deviceScaleFactor: 1, mobile: false });
        await app.waitFor(`${panel}.offsetWidth === 256`);
        assert.equal(await app.evaluate(`(() => {
            const footer = ${panel}.querySelector('.image-parameter-footer');
            const [model, answer, generate] = [...footer.querySelectorAll('button')].map(button => button.getBoundingClientRect());
            const right = footer.getBoundingClientRect().right - parseFloat(getComputedStyle(footer).paddingInlineEnd);
            return Math.abs(model.top - answer.top) < 1 && Math.abs(model.bottom - answer.bottom) < 1 &&
                Math.abs(generate.top - answer.bottom - 6) < 1 && Math.abs(generate.right - right) < 1;
        })()`), true, 'ultra-narrow chat keeps settings together and aligns the primary action with the footer edge');
    });
});

test('chat keeps its saved card size when an oversized reply viewport is restored', { timeout: 30000 }, async () => {
    const reply = '这是一段保存在工作流中的长回复。'.repeat(40);
    await withAppBrowser({
        ...session,
        nodes: [{ id: 'compact-resized-chat', type: 'TextChat', x: 60, y: 60,
            width: 360, height: 338, userResized: true, chatLayoutVersion: 3,
            textareaHeights: { response: 720 }, lastText: reply }]
    }, async app => {
        const assertCard = async () => {
            const layout = await app.evaluate(`(() => {
                const card = document.getElementById('compact-resized-chat');
                const response = document.getElementById('compact-resized-chat-response');
                response.scrollTop = response.scrollHeight;
                return {
                    width: card.offsetWidth,
                    height: card.offsetHeight,
                    replyFits: response.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom,
                    replyScrolls: response.scrollTop > 0 && getComputedStyle(response).overflowY === 'auto'
                };
            })()`);
            assert.deepEqual(layout, { width: 360, height: 338, replyFits: true, replyScrolls: true });
            assert.equal(await app.evaluate("document.getElementById('compact-resized-chat-response').textContent"), reply);
        };
        await assertCard();
        await openParameters(app, 'compact-resized-chat');
        await app.evaluate(`(() => {
            const prompt = document.getElementById('compact-resized-chat-prompt');
            prompt.value = '保留原来的卡片尺寸';
            prompt.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const saved = (await persist(app)).nodes.find(node => node.id === 'compact-resized-chat');
        assert.equal(saved.prompt, '保留原来的卡片尺寸');
        assert.equal(saved.height, 338);
        assert.ok(saved.textareaHeights.response > 0 && saved.textareaHeights.response < 338);

        const previousPid = app.server.pid;
        await app.send('Page.navigate', { url: 'about:blank' });
        await app.waitFor("location.href === 'about:blank'");
        await app.server.restart();
        assert.notEqual(app.server.pid, previousPid);
        await app.send('Page.navigate', { url: app.server.baseUrl });
        await app.waitFor('window.__cainflowAppReady === true');
        await assertCard();
    });
});

test('chat restores automatic and manually resized card heights across reloads', { timeout: 30000 }, async () => {
    await withAppBrowser({
        ...session,
        nodes: [
            { id: 'auto-chat', type: 'TextChat', x: 60, y: 60, height: 780, chatLayoutVersion: 3,
                textareaHeights: { response: 720 }, lastText: '已保存的回复' },
            { id: 'manual-chat', type: 'TextChat', x: 520, y: 60, width: 440, height: 360, userResized: true,
                chatLayoutVersion: 3, textareaHeights: { response: 240 }, lastText: '已保存的回复' }
        ]
    }, async app => {
        const cardHeight = id => app.evaluate(`document.getElementById('${id}').offsetHeight`);
        const automaticHeight = await cardHeight('auto-chat');
        assert.ok(automaticHeight < 300, `automatic card restored at ${automaticHeight}px`);
        assert.equal(await cardHeight('manual-chat'), 360);

        const resizeHandle = '#manual-chat .node-resize-handle--bottom-right';
        const start = await app.evaluate(`(() => {
            const rect = document.querySelector('${resizeHandle}').getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        const end = { x: start.x + 28, y: start.y + 40 };
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
        const snapshot = await persist(app);
        const resized = snapshot.nodes.find(node => node.id === 'manual-chat');
        assert.ok(resized.width > 440 && resized.height > 360);
        assert.ok(resized.textareaHeights.response > 240);
        assert.equal(snapshot.nodes.find(node => node.id === 'auto-chat').textareaHeights?.response, undefined);

        await reloadAppBrowser(app);
        assert.equal(await cardHeight('auto-chat'), automaticHeight);
        assert.equal(await cardHeight('manual-chat'), resized.height);
        assert.equal(await app.evaluate("document.getElementById('manual-chat').offsetWidth"), resized.width);
        assert.equal(await app.evaluate("document.getElementById('manual-chat-response').style.height"), `${resized.textareaHeights.response}px`);
        assert.equal(await app.evaluate("document.getElementById('auto-chat-response').textContent"), '已保存的回复');

        await app.evaluate(`document.querySelector('${resizeHandle}')
            .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        assert.equal(await cardHeight('manual-chat'), automaticHeight, 'fitting to content clears the manual reply height');
        await reloadAppBrowser(app);
        assert.equal(await cardHeight('manual-chat'), automaticHeight);
    });
});

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
        nodes: [
            { id: chatId, type: 'TextChat', x: 180, y: 120, height: 620, chatLayoutVersion: 3,
                apiConfigId: 'chat-model', providerId: 'p', prompt, sysprompt: '先分析再回答', search: true },
            { id: 'linked-chat', type: 'TextChat', x: 680, y: 120, lastText: '查看例子',
                lastResponse: '<p><a href="#reply-example">查看例子</a></p>' }
        ]
    };
    await withAppBrowser(chatSession, async app => {
        const card = `#${chatId}`;
        const editor = `#${chatId}-prompt`;
        const response = `#${chatId}-response`;
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
        const replyLine = selector => app.evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            const range = document.createRange();
            range.selectNodeContents(element.querySelector('p') || element);
            const line = range.getBoundingClientRect();
            const y = line.top + line.height / 2;
            return { start: { x: line.left + 1, y }, end: { x: line.right - 1, y },
                center: { x: line.left + line.width / 2, y } };
        })()`);
        const clickAt = async point => {
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
        };
        const dragAcrossReply = async selector => {
            const { start, end } = await replyLine(selector);
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 });
        };
        await nativeClick(app, '#linked-chat-response a[href="#reply-example"]');
        await app.waitFor('location.hash === "#reply-example"');
        assert.equal(await app.evaluate("document.getElementById('linked-chat').classList.contains('selected')"), false,
            'a reply link activates without selecting the card');
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').checkVisibility()"), false);
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
        const answerSummary = `${panel} [data-parameter-group-toggle=answer]`;
        const modelControl = `${panel} [data-parameter-group-toggle=model]`;
        const popupVisible = `document.querySelector('${panel} .image-parameter-settings-popup').matches(':popover-open')`;
        const panelBounds = () => app.evaluate(`document.querySelector('${panel}').getBoundingClientRect().toJSON()`);
        const systemSettings = `document.getElementById('${chatId}-system-settings')`;
        const initialPanel = await panelBounds();
        assert.equal(initialPanel.width, 390);
        assert.match(await text(answerSummary), /^回答设置/);
        assert.equal(await text(`${panel} .node-chat-answer-state`), '已开启联网 · 已设置系统提示语');
        assert.equal(await app.evaluate(`${systemSettings}.checkVisibility()`), false);
        await nativeClick(app, answerSummary);
        await app.waitFor(popupVisible);
        assert.equal((await panelBounds()).height, initialPanel.height);
        assert.ok(await app.evaluate(`${systemSettings}.checkVisibility() && !${systemSettings}.open`));
        await nativeClick(app, `label[for=${chatId}-fixed]`);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-fixed').checked`), true);
        assert.match(await text(`${panel} .node-chat-answer-state`), /已开启复用/);
        await nativeClick(app, modelControl);
        assert.equal(await app.evaluate(`document.getElementById('${chatId}-provider').closest('.node-model-settings').checkVisibility()`), true);
        assert.equal(await app.evaluate(`${systemSettings}.checkVisibility()`), false);
        await key(app, 'Escape');
        await app.waitFor(`!(${popupVisible})`);
        assert.ok(await app.evaluate(`document.activeElement.matches('${modelControl}')`));
        assert.ok(await app.evaluate(hasVisiblePanel));
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
        assert.equal(await text(run), '生成回复中…');
        await app.evaluate('window.releaseChatReply()');
        await app.waitFor(`document.querySelector('${card} #${chatId}-response')?.textContent.includes(${JSON.stringify(reply)})`);
        await app.waitFor(`!document.querySelector('${run}').disabled`);
        assert.equal(await text(`#${chatId}-response`), reply);
        const replyHeight = await visibleCardHeight();
        assert.ok(replyHeight < 300, 'a short reply keeps the card compact');

        await key(app, 'Escape');
        await app.waitFor(`!(${hasVisiblePanel})`);
        await clickAt(await app.evaluate('({ x: innerWidth - 125, y: innerHeight / 2 })'));
        const selected = `document.querySelector('${card}').classList.contains('selected')`;
        await app.waitFor(`!${selected}`);
        await nativeClick(app, response);
        await app.waitFor(`${selected} && ${hasVisiblePanel}`);
        assert.equal(await app.evaluate('window.getSelection().toString()'), '', 'one click on the reply selects the node without selecting text');
        await key(app, 'Escape');
        await app.waitFor(`!(${hasVisiblePanel})`);
        const cardLeft = `document.querySelector('${card}').getBoundingClientRect().left`;
        const leftBeforeDrag = await app.evaluate(cardLeft);
        await dragAcrossReply(response);
        assert.equal(await app.evaluate('window.getSelection().toString()'), '', 'dragging across the canvas reply does not select text');
        await app.waitFor(`${cardLeft} > ${leftBeforeDrag + 24}`);
        assert.equal(await app.evaluate(`Boolean(${hasVisiblePanel})`), false, 'dragging the reply does not open the parameters');
        await useKeyboardToOpenAndCloseParameters();
        await nativeClick(app, `#${chatId}-preview-btn`);
        await app.waitFor("document.querySelector('#node-text-response-preview-dialog')?.checkVisibility()");
        const viewer = '.node-text-response-preview-text';
        assert.equal(await text(viewer), reply);
        await dragAcrossReply(viewer);
        assert.match(await app.evaluate('window.getSelection().toString()'), /对话回复/, 'the full reply viewer allows selecting text');
        await app.evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { value: async value => { window.copiedChatReply = value; } })");
        await nativeClick(app, '#node-text-response-preview-dialog [data-copy-text-response]');
        await app.waitFor(`window.copiedChatReply === ${JSON.stringify(reply)}`);
        await key(app, 'Escape');
        await app.waitFor("!document.querySelector('#node-text-response-preview-dialog')");
        await nativeClick(app, `#${chatId}-response`);
        await app.waitFor(hasVisiblePanel);
        assert.equal(await visibleCardHeight(), replyHeight);

        await reloadAppBrowser(app);
        assert.equal(await text(`#${chatId}-response`), reply);
        assert.ok(await visibleCardHeight() < 300, 'restoring a short reply keeps the card compact');
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
        const videoModel = "document.querySelector('#inline-video .node-model-settings')";
        assert.equal(await app.evaluate(`${videoModel}.open`), false);
        await app.evaluate(`${videoModel}.querySelector('summary').click()`);
        assert.ok(await app.evaluate(`${videoModel}.open`));
        await app.evaluate(`${videoModel}.querySelector('summary').click()`);
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
