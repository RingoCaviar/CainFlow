import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

test('a short viewport with a pinned toolbar keeps model setup and the image footer reachable', { timeout: 30000 }, async () => {
    await withAppBrowser({
        autoCheckUpdatesOnLoad: false,
        toolbarPinned: true,
        nodes: [{ id: 'needs-model', type: 'ImageGenerate', x: 100, y: 100, prompt: '保留提示词' }],
        connections: []
    }, async ({ evaluate, send, waitFor }) => {
        await evaluate("document.getElementById('needs-model').click()");
        await waitFor("document.body.classList.contains('toolbar-pinned') && document.querySelector('.image-parameter-configuration').checkVisibility()");
        const hit = (selector) => evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            return { x, y, reachable: element.contains(document.elementFromPoint(x, y)) };
        })()`);
        const click = async ({ x, y }) => {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        };
        const sizeSelector = '#image-parameter-panel [data-parameter-group-toggle="size"]';
        const setupSelector = '#image-parameter-panel [data-parameter-action="configure-model"]';
        for (const [width, height, showBatch] of [[700, 260, false], [390, 320, false], [700, 260, true]]) {
            await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
            await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            if (showBatch) {
                await evaluate(`(async () => {
                    const { registry, state } = await (await import('/js/app/bootstrap.js')).bootstrapCainFlowApp();
                    const node = state.nodes.get('needs-model');
                    node.data.concurrentRequestStatus = { total: 2, requests: [{ status: 'failed' }, { status: 'canceled' }] };
                    registry.imageFirstCanvasApi.refreshNode(node.id);
                })()`);
                const batchSelector = '#image-parameter-panel [data-image-batch-toggle]';
                await waitFor(`document.querySelector(${JSON.stringify(batchSelector)})?.checkVisibility()`);
                await evaluate(`document.querySelector(${JSON.stringify(batchSelector)}).scrollIntoView({ block: 'center' })`);
                const batch = await hit(batchSelector);
                assert.ok(batch.reachable, 'batch details remain reachable in the short editor');
                await click(batch);
                await waitFor(`document.querySelector(${JSON.stringify(batchSelector)}).getAttribute('aria-expanded') === 'true'`);
            }
            const size = await hit(sizeSelector);
            assert.ok(size.reachable, `size menu is clickable at ${width}×${height}${showBatch ? ' with a batch' : ''}`);
            for (const selector of ['[data-parameter-group-toggle="model"]', '[data-parameter-group-toggle="more"]',
                '.generation-count-btn[data-delta="1"]', '[data-parameter-action="generate"]']) {
                assert.ok((await hit(`#image-parameter-panel ${selector}`)).reachable, `${selector} stays on screen at ${width}×${height}`);
            }
            await click(size);
            await waitFor(`document.querySelector(${JSON.stringify(sizeSelector)}).getAttribute('aria-expanded') === 'true'`);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await waitFor(`document.querySelector(${JSON.stringify(sizeSelector)}).getAttribute('aria-expanded') === 'false'`);
            await evaluate(`document.querySelector(${JSON.stringify(setupSelector)}).scrollIntoView({ block: 'center' })`);
            assert.ok((await hit(setupSelector)).reachable, `model setup is clickable after scrolling at ${width}×${height}`);
            assert.ok((await hit(sizeSelector)).reachable, 'scrolling to setup keeps the footer clickable');
        }
        await click(await hit(setupSelector));
        await waitFor("!document.getElementById('settings-modal').classList.contains('hidden')");
        assert.equal(await evaluate("document.getElementById('needs-model-prompt').value"), '保留提示词');
    });
});

test('short parameter fields share rows while custom dimensions and long text keep their space', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'image', modelId: 'gpt-image-2', name: 'A deliberately long model name for compact selectors', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
            { id: 'animated', modelId: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare', protocol: 'openai', taskType: 'image', providerIds: ['p'] },
            { id: 'google', modelId: 'gemini-3.1-flash-image', name: 'Gemini Image', protocol: 'google', taskType: 'image', providerIds: ['p'], thinking: { profile: 'google-image' } },
            { id: 'google-fixed', modelId: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image', protocol: 'google', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', name: 'A deliberately long provider name', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [{ id: 'paired', type: 'ImageGenerate', x: 180, y: 60, apiConfigId: 'image', providerId: 'p' }], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('paired').click()");
        const settle = () => app.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const group = async name => { await app.evaluate(`document.querySelector('[data-parameter-group-toggle=${name}]').click()`); await settle(); };
        const rect = suffix => app.evaluate(`(() => { const r=document.getElementById('paired-${suffix}').closest('.node-field').getBoundingClientRect(); return {top:r.top,left:r.left,right:r.right,width:r.width}; })()`);
        const paired = async (first, second) => {
            const a = await rect(first), b = await rect(second);
            assert.ok(Math.abs(a.top-b.top)<1 && a.right<=b.left && Math.abs(a.width-b.width)<1, `${first}/${second} must share an equal-width row: ${JSON.stringify({a,b})}`);
        };
        for (const width of [1280, 390, 320, 280]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            await group('model');
            await paired('apiconfig', 'provider');
            await group('size');
            await paired('aspect', 'resolution');
            assert.equal(await app.evaluate("document.getElementById('paired-quality').closest('.node-field').checkVisibility()"), false, 'size entry excludes quality');
            await app.evaluate("(()=>{const select=document.getElementById('paired-resolution');select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("document.getElementById('paired-custom-resolution-field').checkVisibility()"), 'custom dimensions are genuinely open');
            assert.ok((await rect('custom-resolution-width')).width > (await rect('resolution')).width*1.8, 'custom dimensions retain a full row');
            await app.evaluate("(()=>{const select=document.getElementById('paired-resolution');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
            await group('more');
            await paired('quality', 'background');
            await paired('background', 'moderation');
            const sections = await app.evaluate(`(() => {
                const output = document.getElementById('paired-output-settings');
                const rules = document.getElementById('paired-generation-rules');
                const heading = section => document.getElementById(section?.getAttribute('aria-labelledby'))?.textContent.trim();
                return {
                    labels: [heading(output), heading(rules)],
                    bothVisible: output?.checkVisibility() && rules?.checkVisibility(),
                    outputFirst: Boolean(output?.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING),
                    outputFields: ['quality', 'background', 'moderation', 'param-output_format', 'param-output_compression']
                        .every(suffix => output?.contains(document.getElementById('paired-' + suffix))),
                    ruleFields: ['param-systemPrompt', 'search'].map(suffix => Boolean(rules?.contains(document.getElementById('paired-' + suffix)))),
                    thinkingInRules: Boolean(rules?.querySelector('.thinking-control'))
                };
            })()`);
            assert.deepEqual(sections, { labels: ['输出设置', '生成规则'], bothVisible: true, outputFirst: true, outputFields: true,
                ruleFields: [true, true], thinkingInRules: true });
            assert.ok((await rect('param-systemPrompt')).width > (await rect('moderation')).width*1.8, 'long text remains full width');
            assert.ok(await app.evaluate("document.querySelector('.image-parameter-settings-popup').offsetWidth<=400"), 'more settings use a content-sized popup');
            const textLayout = await app.evaluate(`(()=>{const t=document.getElementById('paired-param-systemPrompt'),field=t.closest('.node-field'),grid=document.querySelector('.image-parameter-output-options');return {gap:field.getBoundingClientRect().top-grid.getBoundingClientRect().bottom,height:t.offsetHeight,line:parseFloat(getComputedStyle(t).lineHeight),border:parseFloat(getComputedStyle(t).borderTopWidth)}})()`);
            assert.ok(textLayout.gap>=10 && textLayout.border>=1, 'system prompt has deliberate spacing and a visible input border');
            assert.ok(textLayout.height<textLayout.line*3+16, 'empty system prompt starts at two lines');
            await app.evaluate("(()=>{const t=document.getElementById('paired-param-systemPrompt');t.value='长系统提示词\\n'.repeat(9);t.dispatchEvent(new Event('input',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("document.getElementById('paired-param-systemPrompt').offsetHeight")>textLayout.height, 'system prompt grows as content is entered');
            await app.evaluate("(()=>{const t=document.getElementById('paired-param-systemPrompt');t.value='';t.dispatchEvent(new Event('input',{bubbles:true}))})()");
            await settle();
            assert.ok(await app.evaluate("[...document.querySelectorAll('.image-parameter-settings-popup,#paired-output-settings,#paired-generation-rules,.image-parameter-settings-popup .node-field')].filter(e=>e.checkVisibility()).every(e=>e.scrollWidth<=e.clientWidth+1)"), `${width}px fields have no horizontal overflow`);
        }
        await app.evaluate(`(() => {
            for (const [suffix, value] of [['output_format', 'webp'], ['output_compression', '70'], ['systemPrompt', '保留产品原有颜色']]) {
                const control = document.getElementById('paired-param-' + suffix);
                control.value = value;
                control.dispatchEvent(new Event('change', { bubbles: true }));
            }
        })()`);
        assert.ok(await app.evaluate("document.getElementById('paired-output_compression-field').checkVisibility()"), 'WebP reveals compression inside output settings');
        await app.evaluate("(()=>{const s=document.getElementById('paired-apiconfig');s.value='google';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await settle();
        await app.evaluate("(()=>{const p=document.querySelector('#image-parameter-panel .image-parameter-settings-popup');if(!p.matches(':popover-open'))document.querySelector('[data-parameter-group-toggle=more]').click()})()");
        await app.waitFor("document.querySelector('#image-parameter-panel .thinking-control')?.checkVisibility()");
        await app.evaluate("document.querySelector('#image-parameter-panel .thinking-control > summary').click()");
        await settle();
        const supported = await app.evaluate(`(() => {
            const output = document.getElementById('paired-output-settings');
            const rules = document.getElementById('paired-generation-rules');
            const thinking = rules.querySelector('.thinking-control select');
            const search = document.getElementById('paired-search');
            const track = search.nextElementSibling;
            return {
                outputVisible: output.checkVisibility(),
                searchInRules: rules.contains(search) && search.closest('.node-field').checkVisibility(),
                thinkingHeight: thinking.offsetHeight,
                noteFont: parseFloat(getComputedStyle(rules.querySelector('.thinking-control small')).fontSize),
                switchHeight: search.parentElement.offsetHeight,
                trackBorder: parseFloat(getComputedStyle(track).borderTopWidth),
                searchWidth: search.closest('.node-field').offsetWidth,
                rulesWidth: rules.clientWidth
            };
        })()`);
        assert.equal(supported.outputVisible, false, 'a model without output settings hides the whole section');
        assert.equal(supported.searchInRules, true, 'search belongs to generation rules when the model supports it');
        assert.equal(supported.thinkingHeight, 38, 'expanded thinking retains the full popup control height');
        assert.ok(supported.noteFont>=12 && supported.switchHeight>=24 && supported.trackBorder>=1, 'thinking notes and the search off state stay readable and reachable');
        assert.equal(supported.searchWidth, supported.rulesWidth, 'search uses the full generation rules row');
        assert.ok(await app.evaluate("[...document.querySelector('#image-parameter-panel .thinking-control select').options].some(option=>option.value==='level:high')"), 'switching models refreshes the detached thinking control options');
        assert.ok(await app.evaluate("document.querySelector('#paired-resolution option[value=\"512\"]')"));
        assert.ok(await app.evaluate("document.querySelector('#paired-aspect option[value=\"1:8\"]')"));
        await app.evaluate("(()=>{const s=document.getElementById('paired-apiconfig');s.value='google-fixed';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await app.waitFor("document.getElementById('paired-search-field').classList.contains('hidden')");
        assert.equal(await app.evaluate("document.getElementById('paired-output-settings').checkVisibility()"), false);
        assert.ok(await app.evaluate("document.getElementById('paired-generation-rules').checkVisibility() && document.getElementById('paired-param-systemPrompt').checkVisibility()"), 'system prompt keeps generation rules available without search');
        assert.deepEqual(await app.evaluate("[...document.getElementById('paired-resolution').options].map(option=>option.value)"), ['']);
        assert.equal(await app.evaluate("!!document.querySelector('#paired-aspect option[value=\"1:8\"]')"), false);
        await app.evaluate("(()=>{const s=document.getElementById('paired-apiconfig');s.value='image';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
        await app.waitFor("document.querySelector('#image-parameter-panel .thinking-control').hidden===true");
        assert.deepEqual(await app.evaluate("['output_format', 'output_compression', 'systemPrompt'].map(suffix => document.getElementById('paired-param-' + suffix).value)"),
            ['webp', '70', '保留产品原有颜色'], 'switching models preserves the configured output and rules');

        await app.evaluate(`(() => {
            const choose = (id, value) => {
                const select = document.getElementById(id);
                select.value = value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            };
            choose('paired-apiconfig', 'animated');
            choose('paired-param-output_format', 'gif');
        })()`);
        const frameControls = ['param-frame_count', 'param-frame_duration_ms'];
        for (const width of [1280, 280]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            await settle();
            assert.ok(await app.evaluate("document.getElementById('paired-param-frame_duration_ms').offsetWidth >= 55"), 'GIF frame duration has space for four digits');
            if (width === 1280) await paired(...frameControls);
            else {
                const [count, duration] = await Promise.all(frameControls.map(rect));
                assert.ok(count.top < duration.top && Math.abs(count.width - duration.width) < 1, 'the GIF controls stack at narrow widths');
            }
        }
    });
});

test('parameter editor uses viewport space and preserves scrolling without overlapping actions', { timeout: 60000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }, { id: 'image', modelId: 'gpt-image-1', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
        nodes: [{ id: 'image', type: 'ImageGenerate', x: 400, y: 230, width: 320, apiConfigId: 'image', providerId: 'p', prompt: 'A cat under an umbrella.\n'.repeat(6) }], connections: []
    }, async app => {
        await app.evaluate("document.getElementById('image').click()");
        await app.waitFor("document.getElementById('image-parameter-panel')?.hidden===false");
        const settle = () => app.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        await settle();
        const fits = await app.evaluate("(()=>{const s=document.querySelector('.image-parameter-scroll');return {horizontal:s.scrollWidth-s.clientWidth,available:s.clientHeight}})()");
        assert.ok(fits.horizontal <= 1 && fits.available >= 120, JSON.stringify(fits));
        const origin = await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()");
        for (const group of ['model', 'size', 'more', 'more']) {
            await app.evaluate(`document.querySelector('[data-parameter-group-toggle=${group}]').click()`);
            await settle();
            const position = await app.evaluate("(()=>{const r=document.getElementById('image-parameter-panel').getBoundingClientRect();return {left:r.left,top:r.top}})()");
            assert.ok(Math.abs(position.left-origin.left)<=0.5 && Math.abs(position.top-origin.top)<=0.5,
                `opening ${group} keeps the editor anchored within subpixel layout rounding`);
        }
        await app.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 260, deviceScaleFactor: 1, mobile: false });
        await settle();
        await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop=40");
        const before = await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop");
        assert.ok(before > 0, 'short viewport genuinely requires scrolling');
        await app.evaluate("document.querySelector('.image-parameter-scroll').dispatchEvent(new Event('input',{bubbles:true}))");
        await settle();
        assert.equal(await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop"), before, 'layout refresh preserves scroll offset');
        assert.ok(await app.evaluate("(()=>{const f=document.querySelector('.image-parameter-footer');return f.getBoundingClientRect().top>=f.previousElementSibling.getBoundingClientRect().bottom-1})()"), 'footer does not cover preceding parameters');
        await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop=10000");
        await app.waitFor("!document.querySelector('.toast')", 15000);
        await app.evaluate("document.querySelector('[data-parameter-group-toggle=more]').click();document.querySelector('#image-parameter-panel .image-parameter-settings-popup').scrollTop=10000");
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await settle();
        const button = await app.evaluate("(()=>{const r=document.querySelector('.generation-count-btn[data-delta=\"1\"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
        const offset = await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop");
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
        await settle();
        assert.equal(await app.evaluate("document.getElementById('image-generation-count').value"), '2', 'count click reaches its control');
        assert.equal(await app.evaluate("document.querySelector('.image-parameter-scroll').scrollTop"), offset, 'clicking count retains the scroll position');
        for (const width of [280, 310, 320, 390, 1280]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
            const panelWidth = Math.min(480, width - 24);
            await app.waitFor(`innerWidth === ${width} && innerHeight === 800 &&
                document.getElementById('image-parameter-panel').style.width === '${panelWidth}px'`);
            for (const count of [1, 10, 100]) {
                await app.evaluate(`(() => {
                    const input = document.getElementById('image-generation-count');
                    input.value = '${count}';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                })()`);
                assert.deepEqual(await app.evaluate("(()=>{const i=document.getElementById('image-generation-count');return {value:i.value,width:i.offsetWidth,max:i.getAttribute('max')}})()"), {value:String(count),width:32,max:null});
            }
            const generate = `document.querySelector('#image-parameter-panel [data-parameter-action="generate"]')`;
            await app.waitFor(`${generate}.textContent === '生成 ×100'`);
            await settle();
            await app.waitFor(`${generate}.getAnimations().every(animation => animation.playState !== 'running')`);
            const layout = await app.evaluate(`(() => {
                const panel = document.getElementById('image-parameter-panel');
                const footer = panel.querySelector('.image-parameter-footer');
                const midpoint = rect => rect.top + rect.height / 2;
                const controls = ['.image-parameter-settings-entry', '.image-parameter-model-entry', '.image-parameter-more-entry', '.generation-count-control', '[data-parameter-action=generate]'].map(selector => {
                    const element = footer.querySelector(selector), r = element.getBoundingClientRect();
                    return { top:r.top, bottom:r.bottom, left:r.left, right:r.right, width:r.width, height:r.height, font:parseFloat(getComputedStyle(element).fontSize), text:element.textContent.trim() };
                });
                const prompt = panel.querySelector('.image-node-prompt-field textarea');
                const border = getComputedStyle(prompt);
                const stepper = footer.querySelector('.generation-count-control');
                const stepperBounds = stepper.getBoundingClientRect();
                const stepperParts = Array.from(stepper.children, element => element.getBoundingClientRect());
                const compactEntries = [...footer.querySelectorAll('[data-compact-label]')].map(button => {
                    const rect = button.getBoundingClientRect();
                    return { label:getComputedStyle(button, '::before').content, width:rect.width };
                });
                return { controls, compactEntries,
                    stepperAligned: stepperParts.every(rect => Math.abs(midpoint(rect)-midpoint(stepperBounds))<1) &&
                        Math.abs(stepperParts[1].left+stepperParts[1].width/2-stepperBounds.left-stepperBounds.width/2)<1,
                    promptWidth:prompt.getBoundingClientRect().width, fieldWidth:prompt.closest('.image-node-prompt-field').getBoundingClientRect().width,
                    overflow:footer.scrollWidth-footer.clientWidth, borderWidth:parseFloat(border.borderTopWidth), borderStyle:border.borderTopStyle, borderColor:border.borderTopColor };
            })()`);
            assert.ok(layout.overflow <= 1, `${width}px footer must not overflow`);
            assert.ok(layout.stepperAligned, `${width}px stepper buttons and input share the control centerline`);
            assert.ok(layout.controls.every(r => Math.abs(r.height-32)<1 && r.font===13));
            const rows = width < 320 ? [layout.controls.slice(0, 3), layout.controls.slice(3)] : [layout.controls];
            for (const row of rows) {
                assert.ok(row.every(r => Math.abs(r.top-row[0].top)<1), `${width}px controls align on their row`);
                assert.ok(row.every((r,index)=>!index || Math.abs(r.left-row[index-1].right-6)<1), `${width}px footer gaps keep the shared 6px rhythm`);
            }
            if (width < 320) {
                assert.ok(Math.abs(rows[1][0].top - rows[0][0].bottom - 6) < 1);
                assert.ok(Math.abs(rows[1][1].right - rows[0][2].right) < 1);
            }
            if (width === 320) {
                assert.deepEqual(layout.compactEntries.map(entry => entry.label), ['"尺寸"', '"模型"']);
                assert.ok(layout.compactEntries.every(entry => entry.width >= 30), 'compact labels retain room for two characters');
            }
            assert.equal(layout.controls[2].text, '更多');
            assert.ok(layout.controls[2].width >= 32 && layout.controls[2].width <= 52, 'the More label fits a compact control');
            assert.equal(layout.controls[3].width, 82, 'count retains its three-digit input space even in a narrow window');
            if (width>=320) assert.ok(layout.controls[4].width>=72 && layout.controls[4].width<=82,
                `${width}px viewport: generate fits a three-digit batch label at ${layout.controls[4].width}px`);
            if (width===1280) assert.ok(layout.controls[0].width<=124 && layout.controls[0].width<layout.controls[1].width, 'short size summary uses compact width rather than an equal share');
            assert.ok(layout.controls.every(r => r.left>=0 && r.right<=width), 'all five controls remain on screen');
            assert.ok(Math.abs(layout.promptWidth-layout.fieldWidth)<1, 'More no longer takes width from the prompt');
            assert.ok(layout.borderWidth>0 && layout.borderStyle==='solid' && !['transparent','rgba(0, 0, 0, 0)'].includes(layout.borderColor), 'prompt keeps a visible border');
        }
    });
});
