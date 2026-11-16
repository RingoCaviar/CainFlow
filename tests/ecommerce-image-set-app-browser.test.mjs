import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { key, nativeClick, openParameters } from './helpers/image-first-integrated-fixture.mjs';

const commerceProductField = field => `#image-parameter-panel [data-commerce-product-field=${field}]`;
const commerceProductValue = field => `document.querySelector('${commerceProductField(field)}').value`;

const measureProductField = (app, field) => app.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(commerceProductField(field))});
    const style = getComputedStyle(input);
    const extra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
        .reduce((total, name) => total + parseFloat(style[name]), 0);
    return { height: input.offsetHeight, line: parseFloat(style.lineHeight), extra,
        overflows: input.scrollHeight > input.clientHeight + 1 };
})()`);

function assertProductFieldRows(measurement, rows, description) {
    assert.ok(Math.abs(measurement.height - (rows * measurement.line + measurement.extra)) <= 2,
        `${description}: expected ${rows} rows, got ${JSON.stringify(measurement)}`);
}

async function captureProductInspector(app) {
    const directory = process.env.CAINFLOW_QA_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const currentTheme = await app.evaluate('document.documentElement.dataset.appTheme');
    const viewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 900, deviceScaleFactor: 1, mobile: false });
    try {
        for (const theme of ['light', 'dark']) {
            await app.evaluate(`document.documentElement.dataset.appTheme='${theme}';
                document.querySelector('#image-parameter-panel .image-parameter-scroll').scrollTop=0;
                document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
            const clip = await app.evaluate(`(()=>{
                const {x,y,width,height}=document.getElementById('image-parameter-panel').getBoundingClientRect();
                return {x,y,width,height,scale:1};
            })()`);
            const { data } = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
            await writeFile(join(directory, `ecommerce-product-${theme}.png`), Buffer.from(data, 'base64'));
        }
    } finally {
        await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(currentTheme)}`);
        await app.send('Emulation.setDeviceMetricsOverride', viewport);
    }
}

test('the commerce node generates selected shots, accepts a retry during generation and restores the set', { timeout: 45000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const workflowId = 'commerce-fixture';
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p', productNotes: '商品含一个杯盖' } },
        { id: 'set-preview', type: 'ImagePreview', x: 850, y: 100 }
    ];
    const connections = [
        { id: 'photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 },
        { id: 'suite', from: { nodeId: 'commerce', port: 'image' },
            to: { nodeId: 'set-preview', port: 'image' }, type: 'image', order: 0 }
    ];
    const initScript = `window.commerceCalls=[]; window.commerceNativeImages={}; let rejectDetail=true; const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (options.body instanceof FormData) {
                const files=[...options.body].filter(([key])=>key==='image'||key==='image[]').map(([,file])=>file);
                const refs=await Promise.all(files.map(async file=>btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))));
                const prompt=options.body.get('prompt');
                const shotId=prompt.match(/原商品图位 ([\\w-]+)$/m)?.[1];
                const size=options.body.get('size');
                commerceCalls.push({kind:'image',refs,prompt,shotId,size});
                if(rejectDetail&&shotId==='detail') {
                    rejectDetail=false;
                    return Response.json({error:{message:'Fixture detail failure'}},{status:500});
                }
                if(shotId==='detail-overview') {
                    await new Promise(resolve => { window.releaseCommerceDetail = resolve; });
                }
                const canvas=document.createElement('canvas');
                [canvas.width,canvas.height]=size.split('x').map(Number);
                const context=canvas.getContext('2d');
                context.fillStyle=window.commerceProviderColor||'#0055ff';
                context.fillRect(0,0,canvas.width,canvas.height);
                const image=canvas.toDataURL('image/png');
                commerceNativeImages[shotId]=image;
                return Response.json({data:[{b64_json:image.split(',')[1]}]});
            }
            const body=JSON.parse(options.body);
            if (!body.messages) throw new Error('Unexpected request without reference image form data');
            const [text,photo]=body.messages.at(-1).content;
            const input=JSON.parse(text.text);
            const shotIds=input.shots.map(shot=>shot.id);
            commerceCalls.push({kind:'plan',image:photo.image_url.url,shotIds,instructions:body.messages[0].content, input});
            if (window.commercePlanRevision) {
                await new Promise(resolve=>{window.releaseCommercePlan=resolve;});
                return Response.json({choices:[{message:{content:JSON.stringify({sellingPoints:['单张规划不得替换卖点'],
                    shots:shotIds.map(id=>({id,prompt:'原商品图位 '+id+'\\n杯盖居中，采用俯拍构图和暖色桌面。',
                        headline:'重新规划的标题',body:'俯拍呈现可拆下的杯盖。'}))})}}]});
            }
            return Response.json({choices:[{message:{content:JSON.stringify({sellingPoints:['可见杯盖'],
                productInfo:{name:'带盖随行杯',sellingPoints:['可见杯盖'],audience:'通勤人群',useCases:'日常饮水',details:'杯口配有杯盖'},
                shots:shotIds.map(id=>({id,prompt:'原商品图位 '+id+'\\n杯盖位于右侧，采用近景构图、柔和侧光和简洁商品摄影风格。标题和正文排在左上方。',
                    headline:id==='detail-overview'?'旧版标题':'握持方便',body:id==='detail-overview'?'旧版正文':'杯盖可拆卸'}))})}}]});
        };`;

    const saved = `fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.find(node=>node.id==='commerce'))`;
    const commerceLogs = `Array.from(document.querySelectorAll('#log-list .log-item'), row => ({
        title: row.querySelector('.log-summary-text').textContent,
        status: row.querySelector('.log-type-tag').textContent.trim(),
        summary: row.querySelector('.log-item-summary')?.textContent
    })).filter(log => log.title.startsWith('电商套图 · '))`;
    const planButton = "document.querySelector('[data-commerce-action=plan]')";
    const generateButton = "document.querySelector('[data-commerce-action=generate]')";
    const generationAvailable = `(${generateButton}?.checkVisibility() && !${generateButton}.disabled)`;
    const shotChoices = '#image-parameter-panel input[data-commerce-select-shot]';
    const available = `document.querySelectorAll('${shotChoices}').length`;
    const selected = `Array.from(document.querySelectorAll('${shotChoices}:checked'), input => input.dataset.commerceSelectShot)`;
    const planned = "Array.from(document.querySelectorAll('[data-commerce-shot-id]'), row => row.dataset.commerceShotId)";
    const select = id => `document.querySelector('input[data-commerce-select-shot=${id}]').click()`;
    const shotCard = id => `#image-parameter-panel [data-commerce-shot-id=${id}]`;
    const shotEditor = id => `${shotCard(id)} .commerce-image-set-shot-editor`;
    const shotToggle = id => `${shotCard(id)} .commerce-image-set-shot-toggle`;
    const waitForShotEditor = (app, id, open) => app.waitFor(`(() => {
        const toggle=document.querySelector(${JSON.stringify(shotToggle(id))});
        const editor=document.querySelector(${JSON.stringify(shotEditor(id))});
        return toggle?.getAttribute('aria-expanded')==='${open}' && editor?.hidden===${!open};
    })()`);
    const toggleShotEditor = async (app, id, open = true) => {
        const toggle = shotToggle(id);
        await app.evaluate(`document.querySelector(${JSON.stringify(toggle)}).scrollIntoView({block:'nearest'})`);
        await nativeClick(app, toggle);
        await waitForShotEditor(app, id, open);
    };
    const openedShotIds = `Array.from(document.querySelectorAll('#image-parameter-panel .commerce-image-set-shot-editor:not([hidden])'),
        editor=>editor.closest('[data-commerce-shot-id]').dataset.commerceShotId)`;
    const scrollBody = "document.querySelector('#image-parameter-panel .image-parameter-scroll')";
    const actionPlacement = (app, action) => app.evaluate(`(()=>{
        const panel=document.getElementById('image-parameter-panel');
        const scroll=${scrollBody};
        const button=panel.querySelector('[data-commerce-action=${action}]');
        const box=button.getBoundingClientRect(), panelBox=panel.getBoundingClientRect();
        return {inDockFooter:!scroll.contains(button)&&box.top>=scroll.getBoundingClientRect().bottom-1&&box.bottom<=panelBox.bottom+1,
            top:box.top, scrollTop:scroll.scrollTop,
            visible:button.checkVisibility()&&box.top>=0&&box.bottom<=innerHeight,
            reachable:button.contains(document.elementFromPoint((box.left+box.right)/2,(box.top+box.bottom)/2))};
    })()`);
    const thumbnail = id => `#image-parameter-panel [data-commerce-shot-id=${id}] [data-commerce-action=preview]`;
    const retryIcon = id => `#image-parameter-panel [data-commerce-shot-id=${id}] [data-commerce-action=retry]`;
    const replanIcon = id => `#image-parameter-panel [data-commerce-shot-id=${id}] [data-commerce-action=replan-shot]`;
    const fullscreenImage = '.fullscreen-overlay .fullscreen-img-wrapper img';
    const closePreview = async (app, trigger) => {
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await app.waitFor(`!document.querySelector('.fullscreen-overlay') &&
            document.querySelector('#image-parameter-panel[data-mode=docked][data-node-id=commerce]:not([hidden]):not([inert])') &&
            document.activeElement===document.querySelector(${JSON.stringify(trigger)})`);
    };
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections,
        activeWorkflowId: workflowId, activeWorkflowName: '商品套图',
        workflowTabs: [{ workflowId, name: '商品套图', data: { workflowId, nodes, connections } }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        if (await app.evaluate("CSS.supports('appearance: base-select') && CSS.supports('selector(select:open)')")) {
            const platform = "document.querySelector('[data-commerce-field=platformId]')";
            const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
            const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
            await app.evaluate(`${platform}.focus()`);
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ' });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
            await app.waitFor(`${platform}.matches(':open')`);
            await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...escape });
            await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape });
            await app.waitFor(`!${platform}.matches(':open') && document.activeElement === ${platform} && ${platform}.value === 'amazon'`);
        }
        const featureSwitch = "document.querySelector('input[data-commerce-select-shot=feature]')";
        await app.evaluate(`${featureSwitch}.focus()`);
        const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
        assert.equal(await app.evaluate(`${featureSwitch}.checked && getComputedStyle(${featureSwitch}.nextElementSibling).outlineStyle === 'solid'`), true);
        await app.evaluate(select('feature'));
        assert.equal(await app.evaluate("document.querySelector('.commerce-image-set-references [data-input-role]').checkVisibility()"), false);
        assert.equal(await app.evaluate(commerceProductValue('details')), '商品含一个杯盖');
        assert.equal(await app.evaluate(available), 10);
        assert.deepEqual(await app.evaluate(`(()=>{const panel=document.getElementById('image-parameter-panel');
            const canvas=document.getElementById('canvas-container');
            return [panel.dataset.mode,panel.parentNode.id,panel.getBoundingClientRect().left===canvas.getBoundingClientRect().right];})()`),
        ['docked', 'main-layout', true]);
        await app.evaluate("document.body.classList.add('toolbar-pinned')");
        await app.waitFor(`document.querySelector('#image-parameter-panel .image-parameter-header').getBoundingClientRect().top >=
            document.getElementById('toolbar').getBoundingClientRect().bottom - 1`);
        await app.evaluate("document.body.classList.remove('toolbar-pinned')");
        assert.deepEqual(await app.evaluate(selected), []);
        assert.equal(await app.evaluate(`${planButton}.disabled`), true);
        const initialAction = await actionPlacement(app, 'plan');
        assert.ok(initialAction.inDockFooter && initialAction.visible, JSON.stringify(initialAction));
        await app.evaluate(`${planButton}.click()`);
        assert.equal(await app.evaluate('commerceCalls.length'), 0);

        await app.evaluate(`${select('main')}; ${select('detail')}; ${planButton}.click()`);
        await app.waitFor(generationAvailable);
        assert.deepEqual(await app.evaluate('commerceCalls.map(call=>call.kind)'), ['plan']);
        assert.equal(await app.evaluate('commerceCalls[0].image'), `data:image/png;base64,${reference}`);
        assert.deepEqual(await app.evaluate('commerceCalls[0].shotIds'), ['detail']);
        assert.equal(await app.evaluate('commerceCalls[0].input.productInfo.details'), '商品含一个杯盖');
        assert.equal(await app.evaluate(commerceProductValue('name')), '带盖随行杯');
        assert.equal(await app.evaluate(commerceProductValue('sellingPoints')), '可见杯盖');
        assert.equal(await app.evaluate(commerceProductValue('audience')), '通勤人群');
        assert.equal(await app.evaluate(commerceProductValue('details')), '商品含一个杯盖');
        const instructions = await app.evaluate('commerceCalls[0].instructions');
        for (const requirement of [/画面内容/, /构图/, /摄影风格/, /文字布局/, /层级/, /字体/, /字色/]) {
            assert.match(instructions, requirement);
        }
        assert.deepEqual(await app.evaluate(planned), ['main', 'detail']);

        const setup = '#image-parameter-panel .commerce-image-set-setup';
        assert.equal(await app.evaluate(`document.querySelector('${setup}').open`), false);
        await nativeClick(app, `${setup} > summary`);
        await app.evaluate(`${select('feature')}; ${select('detail-overview')}`);
        assert.equal(await app.evaluate(`Boolean(${generationAvailable})`), false);
        await app.evaluate(`${planButton}.click()`);
        await app.waitFor(generationAvailable);
        assert.deepEqual(await app.evaluate('commerceCalls.map(call=>call.kind)'), ['plan', 'plan']);
        assert.deepEqual(await app.evaluate('commerceCalls[1].shotIds'), ['detail', 'feature', 'detail-overview']);
        assert.deepEqual(await app.evaluate(planned), ['main', 'detail', 'feature', 'detail-overview']);
        assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#image-parameter-panel [data-commerce-action=retry]')]
            .filter(button=>button.checkVisibility()).map(button=>[button.closest('[data-commerce-shot-id]').dataset.commerceShotId,button.disabled])`),
        [['detail', false], ['feature', false], ['detail-overview', false]]);
        assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#image-parameter-panel [data-commerce-action=replan-shot]')]
            .filter(button=>button.checkVisibility()).map(button=>[button.closest('[data-commerce-shot-id]').dataset.commerceShotId,button.disabled])`),
        [['detail', false], ['feature', false], ['detail-overview', false]]);
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-selling-points]').value"), '可见杯盖');
        const cardLayout = await app.evaluate(`(()=>{
            const groups=[...document.querySelectorAll('#image-parameter-panel .commerce-image-set-result-group')];
            const cards=groups.flatMap(group=>[...group.querySelectorAll('[data-commerce-shot-id]')]);
            return {groups:groups.map(group=>({title:group.querySelector('h3,h4').textContent.trim(),
                ids:[...group.querySelectorAll('[data-commerce-shot-id]')].map(card=>card.dataset.commerceShotId)})),
                cards:cards.map((card,index)=>{
                    const style=getComputedStyle(card);
                    return {id:card.dataset.commerceShotId, framed:['Top','Right','Bottom','Left'].every(side=>
                        parseFloat(style['border'+side+'Width'])>0&&style['border'+side+'Style']!=='none'&&
                        style['border'+side+'Color']!=='rgba(0, 0, 0, 0)'&&parseFloat(style['padding'+side])>0),
                        gap:index ? card.getBoundingClientRect().top-cards[index-1].getBoundingClientRect().bottom : null};
                })};
        })()`);
        assert.deepEqual(cardLayout.groups, [
            { title: '主副图', ids: ['main', 'detail', 'feature'] }, { title: '详情图', ids: ['detail-overview'] }
        ]);
        assert.ok(cardLayout.cards.every(card => card.framed && (card.gap === null || card.gap > 0)), JSON.stringify(cardLayout.cards));
        assert.equal(await app.evaluate(`Array.from(document.querySelectorAll('#image-parameter-panel [data-commerce-shot-id]')).every(card=>{
            const toggle=card.querySelector('button.commerce-image-set-shot-toggle');
            const editor=card.querySelector('.commerce-image-set-shot-editor');
            return toggle?.getAttribute('aria-controls')===editor?.id && toggle?.getAttribute('aria-expanded')==='false' &&
                editor.hidden && !/编辑文案与提示词|编辑提示词/.test(card.innerText);
        })`), true, 'each card header controls its own editor with no separate disclosure row');
        await toggleShotEditor(app, 'main');
        assert.match(await app.evaluate(`document.querySelector(${JSON.stringify(shotEditor('main'))}).innerText`), /参考图/);
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(shotEditor('main'))}).querySelectorAll('input,textarea').length`), 0);
        await app.evaluate(`const points=document.querySelector('[data-commerce-selling-points]');
            points.value='用户已核对杯盖';points.dispatchEvent(new Event('input',{bubbles:true}));`);
        const headlineField = `${shotEditor('detail-overview')} [data-commerce-shot-field=headline]`;
        const bodyField = `${shotEditor('detail-overview')} [data-commerce-shot-field=body]`;
        await toggleShotEditor(app, 'detail-overview');
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview']);
        await app.evaluate(`document.querySelector(${JSON.stringify(headlineField)}).scrollIntoView({block:'nearest'})`);
        await nativeClick(app, headlineField);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview'], 'clicking an edit field leaves the card open');
        await app.evaluate(`const headline=document.querySelector(${JSON.stringify(headlineField)});
            headline.value='轻松拿取杯盖';headline.dispatchEvent(new Event('input',{bubbles:true}));
            const body=document.querySelector(${JSON.stringify(bodyField)});
            body.value='拆下杯盖再清洗。';body.dispatchEvent(new Event('input',{bubbles:true}));`);
        await toggleShotEditor(app, 'detail-overview', false);
        assert.deepEqual(await app.evaluate(openedShotIds), []);
        const padding = await app.evaluate(`(()=>{const card=document.querySelector(${JSON.stringify(shotCard('feature'))});
            card.scrollIntoView({block:'nearest'});
            const rect=card.getBoundingClientRect(),x=rect.left+4,y=rect.top+rect.height/2;
            return {x,y,onCard:document.elementFromPoint(x,y)===card};})()`);
        assert.equal(padding.onCard, true, 'the frame outside the card header is visible and clickable');
        const { x, y } = padding;
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        await waitForShotEditor(app, 'feature', true);
        assert.deepEqual(await app.evaluate(openedShotIds), ['feature']);
        await app.evaluate(`document.querySelector(${JSON.stringify(shotToggle('detail-overview'))}).focus()`);
        await key(app, 'Enter');
        await waitForShotEditor(app, 'detail-overview', true);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview']);
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(headlineField)}).value`), '轻松拿取杯盖');
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(bodyField)}).value`), '拆下杯盖再清洗。');

        const viewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
        await app.send('Emulation.setDeviceMetricsOverride', { ...viewport, height: 460 });
        try {
            await app.waitFor(`${scrollBody}.scrollHeight>${scrollBody}.clientHeight`);
            await app.evaluate(`${scrollBody}.scrollTop=0`);
            const top = await actionPlacement(app, 'generate');
            await app.evaluate(`${scrollBody}.scrollTop=${scrollBody}.scrollHeight`);
            await app.waitFor(`${scrollBody}.scrollTop>0`);
            const bottom = await actionPlacement(app, 'generate');
            assert.ok([top, bottom].every(place => place.inDockFooter && place.visible && place.reachable), JSON.stringify({ top, bottom }));
            assert.ok(bottom.scrollTop > top.scrollTop && Math.abs(bottom.top - top.top) <= 1, JSON.stringify({ top, bottom }));
        } finally {
            await app.send('Emulation.setDeviceMetricsOverride', viewport);
        }

        await app.evaluate(`${generateButton}.click()`);
        await app.waitFor(`typeof window.releaseCommerceDetail==='function' &&
            document.querySelector('[data-commerce-shot-id=feature] img:not([hidden])')?.naturalWidth>0`);
        assert.equal(await app.evaluate("document.getElementById('modal-error').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-shot-id=detail-overview] img').hidden"), true);
        const running = await app.evaluate(`(()=>{
            const panel=document.getElementById('image-parameter-panel');
            const status=panel.querySelector('.commerce-image-set-status');
            const progress=panel.querySelector('.commerce-image-set-progress');
            const fields=[...panel.querySelectorAll('[data-commerce-shot-field]')];
            return {message:status.textContent.trim(), statusVisible:status.checkVisibility(), fieldsLocked:fields.length>0&&fields.every(field=>field.disabled),
                progress:[progress.checkVisibility(),progress.value,progress.max],
                canSubmit:[...panel.querySelectorAll('[data-commerce-action=plan],[data-commerce-action=generate]')].some(button=>button.checkVisibility()&&!button.disabled),
                shotStatus:panel.querySelector('[data-commerce-shot-id=detail-overview] .commerce-image-set-shot-status').textContent.trim()};
        })()`);
        assert.match(running.message, /正在生成/);
        assert.match(running.shotStatus, /正在生成/);
        assert.ok(running.statusVisible && running.fieldsLocked && !running.canSubmit, JSON.stringify(running));
        assert.deepEqual(running.progress, [true, 2, 4]);
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(headlineField)}).value`), '轻松拿取杯盖');
        assert.equal(await app.evaluate(`document.querySelector('#commerce .commerce-image-set-cover').src ===
            document.querySelector('[data-commerce-shot-id=feature] img').src`), true);
        const liveThumbnail = thumbnail('feature');
        await app.evaluate(`document.querySelector(${JSON.stringify(liveThumbnail)}).scrollIntoView({block:'nearest'})`);
        await nativeClick(app, liveThumbnail);
        await app.waitFor(`(()=>{const image=document.querySelector('${fullscreenImage}');
            return image?.naturalWidth>0 && image.src===document.querySelector('${liveThumbnail} img').src;})()`);
        assert.deepEqual(await app.evaluate("Array.from(document.querySelectorAll('.fullscreen-overlay .fullscreen-thumb-item'), item=>item.classList.contains('is-active'))"), [false, true]);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft' });
        await app.waitFor(`document.querySelector('${fullscreenImage}')?.src === document.querySelector('${thumbnail('main')} img').src`);
        await closePreview(app, liveThumbnail);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview'], 'thumbnail preview does not toggle a card');
        assert.equal(await app.evaluate("commerceCalls.filter(call=>call.kind==='image').length"), 3);
        const failureButton = `${shotCard('detail')} button[data-commerce-action=error-detail]`;
        const errorDialog = "document.getElementById('modal-error')";
        assert.equal(await app.evaluate(`document.querySelector('${shotCard('detail')}').textContent.includes('Fixture detail failure')`), false);
        assert.equal(await app.evaluate(`document.querySelector('${failureButton}')?.textContent.trim()`), '生成失败');
        await app.evaluate(`document.querySelector('${failureButton}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, failureButton);
        await app.waitFor(`${errorDialog}.checkVisibility()`);
        assert.equal(await app.evaluate(`${errorDialog}.getAttribute('role')`), 'dialog');
        assert.equal(await app.evaluate(`${errorDialog}.contains(document.activeElement)`), true);
        assert.match(await app.evaluate("document.getElementById('error-modal-title').textContent"), /商品特写/);
        assert.equal(await app.evaluate("document.getElementById('error-modal-msg').textContent"), 'Fixture detail failure');
        await key(app, 'Escape');
        await app.waitFor(`!${errorDialog}.checkVisibility()`);
        assert.equal(await app.evaluate(`document.activeElement===document.querySelector('${failureButton}')`), true);
        await key(app, 'Enter');
        await app.waitFor(`${errorDialog}.checkVisibility()`);
        await key(app, 'Escape');
        await app.waitFor(`!${errorDialog}.checkVisibility()`);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview'], 'reading a failed shot does not toggle a card');
        const liveLogs = await app.evaluate(commerceLogs);
        assert.ok(liveLogs.some(log => log.title.includes('生成方案') && log.status === '成功'));
        assert.ok(liveLogs.some(log => log.title.includes('生成图片「商品特写」') && log.status === '失败'
            && log.summary.includes('Fixture detail failure')));
        assert.ok(liveLogs.some(log => log.title.includes('生成图片「详情首屏」') && log.status === '请求中'));
        const retryFailedShot = retryIcon('detail');
        assert.equal(await app.evaluate(`document.querySelector('${retryIcon('detail-overview')}').disabled`), true);
        assert.equal(await app.evaluate(`document.querySelector('${retryFailedShot}').disabled`), false,
            'a failed shot can be retried while another shot is generating');
        assert.equal(await app.evaluate(`document.querySelector('${retryIcon('feature')}').disabled`), false,
            'a completed shot can also be regenerated while another shot is generating');
        assert.equal(await app.evaluate(`document.querySelector('${replanIcon('detail')}').disabled`), true);
        await app.evaluate(`document.querySelector('${retryFailedShot}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, retryFailedShot);
        await app.waitFor(`document.querySelector('${shotCard('detail')}').dataset.resultStatus==='queued'`);
        assert.equal(await app.evaluate(`document.querySelector('${shotCard('detail')} .commerce-image-set-shot-status').textContent`), '排队重试');
        assert.equal(await app.evaluate(`document.querySelector('${retryFailedShot}').disabled`), true);
        assert.equal(await app.evaluate("commerceCalls.filter(call=>call.kind==='image').length"), 3,
            'the queued retry waits for the active generation');
        await app.evaluate('window.releaseCommerceDetail()');
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet?.results?.filter(row=>row.status==='completed').length===4)`);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview'], 'retrying a failed shot does not toggle a card');
        await app.waitFor("document.querySelector('[data-commerce-shot-id=detail] [data-commerce-action=preview]')?.getAttribute('aria-pressed')==='true'");
        const requests = await app.evaluate("commerceCalls.filter(call=>call.kind==='image')");
        const finishedLogs = await app.evaluate(commerceLogs);
        assert.equal(finishedLogs.length, await app.evaluate('commerceCalls.length'), 'each provider request has one log entry');
        assert.ok(finishedLogs.some(log => log.title.includes('生成图片「详情首屏」') && log.status === '成功'));
        assert.ok(finishedLogs.some(log => log.title.includes('重试图片「商品特写」') && log.status === '成功'));
        assert.deepEqual(requests.map(request => request.shotId), ['detail', 'feature', 'detail-overview', 'detail']);
        assert.deepEqual(requests.map(request => request.size), ['1024x1024', '1024x1024', '864x1536', '1024x1024']);
        for (const request of requests) {
            assert.deepEqual(request.refs, [reference]);
            assert.match(request.prompt, /用户已核对杯盖/);
        }
        const detailRequest = requests.find(request => request.shotId === 'detail-overview');
        assert.match(detailRequest.prompt, /杯盖位于右侧.*近景构图.*柔和侧光.*商品摄影风格.*左上方/);
        assert.match(detailRequest.prompt, /同一次出图中完成商品画面与文案排版/);
        assert.match(detailRequest.prompt, /标题：\s*"轻松拿取杯盖"/);
        assert.match(detailRequest.prompt, /正文：\s*"拆下杯盖再清洗。"/);
        assert.doesNotMatch(detailRequest.prompt, /旧版标题|旧版正文/);
        const before = await app.evaluate(saved);
        assert.deepEqual(before.commerceImageSet.selectedShotIds, ['main', 'detail', 'feature', 'detail-overview']);
        assert.deepEqual(before.commerceImageSet.results.map(row => row.shotId), ['main', 'detail', 'feature', 'detail-overview']);
        assert.equal(before.commerceImageSet.plan.shots.at(-1).headline, '轻松拿取杯盖');
        assert.equal(before.commerceImageSet.plan.shots.at(-1).body, '拆下杯盖再清洗。');
        assert.equal(before.commerceImageSet.results[0].assetKey, before.mediaAssetKeys[0]);
        const artwork = await app.evaluate(`(async()=>{
            const assetUrl='/api/storage/assets/'+encodeURIComponent(${JSON.stringify(before.mediaAssetKeys[3])});
            const providerUrl=commerceNativeImages['detail-overview'];
            const [output, provider]=await Promise.all([assetUrl,providerUrl].map(async url=>
                new Uint8Array(await (await fetch(url)).arrayBuffer())));
            const bitmap=await createImageBitmap(new Blob([output],{type:'image/png'}));
            const dimensions=[bitmap.width,bitmap.height];
            bitmap.close();
            return {dimensions,matchesProvider:output.length===provider.length&&output.every((byte,index)=>byte===provider[index])};
        })()`);
        assert.deepEqual(artwork.dimensions, [864, 1536]);
        assert.equal(artwork.matchesProvider, true, 'the saved artwork is the unmodified image provider result');
        const product = await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.find(node=>node.id==='product'))");
        assert.equal(before.mediaAssetKeys[0], product.mediaAssetKeys[0]);
        const previewKeys = "fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes.find(node=>node.id==='set-preview')?.mediaAssetKeys)";
        await app.waitFor(`${previewKeys}.then(keys=>keys?.length===4)`);
        assert.deepEqual(await app.evaluate(previewKeys), before.mediaAssetKeys);

        const beforeToolbarRun = await app.evaluate('commerceCalls.length');
        await app.evaluate("window.releaseCommerceDetail=null;document.getElementById('btn-run').click()");
        await app.waitFor(`typeof window.releaseCommerceDetail==='function' && !document.getElementById('btn-stop').disabled &&
            document.querySelector('${shotCard('detail-overview')}').dataset.resultStatus==='running'`);
        const retryFeature = retryIcon('feature');
        await app.evaluate(`document.querySelector('${retryFeature}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, retryFeature);
        await app.waitFor(`document.querySelector('${shotCard('feature')}').dataset.resultStatus==='queued'`);
        await app.evaluate("document.getElementById('btn-stop').click();window.releaseCommerceDetail()");
        await app.waitFor(`document.getElementById('btn-stop').disabled && !document.querySelector('${retryFeature}').disabled &&
            document.querySelector('${shotCard('feature')}').dataset.resultStatus==='completed'`);
        assert.deepEqual(await app.evaluate(`commerceCalls.slice(${beforeToolbarRun}).map(call=>call.shotId)`),
            ['detail', 'feature', 'detail-overview'], 'stopping a toolbar run drops its queued retry');

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate('commerceCalls.length'), 0);
        assert.deepEqual(await app.evaluate(selected), ['main', 'detail', 'feature', 'detail-overview']);
        assert.equal(await app.evaluate("document.querySelectorAll('.commerce-image-set-shot img:not([hidden])').length"), 4);
        assert.equal(await app.evaluate("document.querySelectorAll('.commerce-image-set-shot [download]').length"), 0);
        assert.deepEqual((await app.evaluate(saved)).mediaAssetKeys, before.mediaAssetKeys);
        const regenerate = retryIcon('detail-overview');
        const replan = replanIcon('detail-overview');
        await app.waitFor(`[${JSON.stringify(regenerate)},${JSON.stringify(replan)}].every(selector=>{
            const button=document.querySelector(selector);return button?.checkVisibility()&&!button.disabled;
        })`);
        const iconLayout = await app.evaluate(`(()=>{
            const image=document.querySelector('${regenerate}'),plan=document.querySelector('${replan}');
            const status=image.closest('[data-commerce-shot-id]').querySelector('.commerce-image-set-shot-status').getBoundingClientRect();
            const buttons=[plan,image],rects=buttons.map(button=>button.getBoundingClientRect());
            return {names:buttons.map(button=>button.getAttribute('aria-label')),
                glyphs:buttons.map(button=>button.querySelector('svg')?.innerHTML),
                besideStatus:rects.every(icon=>status.right<=icon.left&&status.top<icon.bottom&&status.bottom>icon.top),
                separate:rects[0].right<=rects[1].left||rects[1].right<=rects[0].left};
        })()`);
        assert.deepEqual(iconLayout.names, ['重新生成详情首屏方案', '重新生成详情首屏图片']);
        assert.ok(iconLayout.glyphs.every(Boolean)&&new Set(iconLayout.glyphs).size===2&&iconLayout.besideStatus&&iconLayout.separate, JSON.stringify(iconLayout));
        await toggleShotEditor(app, 'detail-overview');
        const detailThumbnail = thumbnail('detail-overview');
        const originalThumbnail = await app.evaluate(`document.querySelector('${detailThumbnail} img').src`);
        await app.evaluate(`window.commercePlanRevision=true;document.querySelector('${replan}').scrollIntoView({block:'nearest'});`);
        await nativeClick(app, replan);
        await app.waitFor(`typeof window.releaseCommercePlan==='function' &&
            document.querySelector('${replan}').disabled && document.querySelector('${regenerate}').disabled`);
        assert.deepEqual(await app.evaluate(openedShotIds), ['detail-overview'], 'replanning a shot leaves its editor open');
        const planCalls = await app.evaluate('commerceCalls.map(({kind,shotIds})=>[kind,shotIds])');
        assert.deepEqual(planCalls, [['plan', ['detail-overview']]]);
        assert.equal(await app.evaluate(`document.querySelector('${detailThumbnail} img').src`), originalThumbnail);
        await app.evaluate('window.releaseCommercePlan()');
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.plan.shots.at(-1).headline==='重新规划的标题')`);
        const replanned = await app.evaluate(saved);
        assert.deepEqual(replanned.mediaAssetKeys, before.mediaAssetKeys);
        assert.deepEqual(replanned.commerceImageSet.results, before.commerceImageSet.results);
        assert.deepEqual(replanned.commerceImageSet.plan.sellingPoints, before.commerceImageSet.plan.sellingPoints);
        assert.deepEqual(replanned.commerceImageSet.plan.shots.slice(0,-1), before.commerceImageSet.plan.shots.slice(0,-1));
        assert.equal(replanned.commerceImageSet.plan.confirmed, false);
        assert.equal(await app.evaluate(`document.querySelector('${detailThumbnail} img').src`), originalThumbnail);
        await waitForShotEditor(app, 'detail-overview', true);
        await app.waitFor(`document.querySelector(${JSON.stringify(headlineField)}).value==='重新规划的标题'`);
        await app.waitFor(`!document.querySelector('${replan}').disabled&&!document.querySelector('${regenerate}').disabled`);
        await app.evaluate(`const headline=document.querySelector(${JSON.stringify(headlineField)});
            headline.value='方便取下杯盖';headline.dispatchEvent(new Event('input',{bubbles:true}));`);
        await toggleShotEditor(app, 'detail-overview', false);
        await app.evaluate(`window.commerceProviderColor='#c05220';document.querySelector('${regenerate}').scrollIntoView({block:'nearest'});`);
        await nativeClick(app, regenerate);
        await app.waitFor(`typeof window.releaseCommerceDetail==='function' &&
            document.querySelector('[data-commerce-shot-id=detail-overview]').dataset.resultStatus==='running'`);
        assert.equal(await app.evaluate(`document.querySelector('${regenerate}').disabled`), true);
        assert.deepEqual(await app.evaluate(openedShotIds), [], 'regenerating a completed shot leaves its card collapsed');
        assert.equal(await app.evaluate(`document.querySelector('${detailThumbnail} img').src`), originalThumbnail);
        assert.deepEqual(await app.evaluate('commerceCalls.map(({ kind, shotId, shotIds }) => [kind, shotId || shotIds])'),
            [['plan', ['detail-overview']], ['image', 'detail-overview']]);
        const regeneratedPrompt = await app.evaluate('commerceCalls.at(-1).prompt');
        assert.match(regeneratedPrompt, /杯盖居中，采用俯拍构图和暖色桌面/);
        assert.match(regeneratedPrompt, /标题：\s*"方便取下杯盖"/);
        assert.match(regeneratedPrompt, /正文：\s*"俯拍呈现可拆下的杯盖。"/);
        await app.evaluate('window.releaseCommerceDetail()');
        await app.waitFor(`${saved}.then(node=>node.mediaAssetKeys?.length===4&&node.mediaAssetKeys[3]!==${JSON.stringify(before.mediaAssetKeys[3])})`);
        const regenerated = await app.evaluate(saved);
        assert.deepEqual(regenerated.mediaAssetKeys.slice(0, 3), before.mediaAssetKeys.slice(0, 3));
        assert.equal(regenerated.commerceImageSet.plan.confirmed, false);
        assert.deepEqual(regenerated.commerceImageSet.results.map(row => [row.shotId, row.status, row.assetKey]),
            before.commerceImageSet.results.map((row, index) => [row.shotId, 'completed', regenerated.mediaAssetKeys[index]]));
        await app.waitFor(`${previewKeys}.then(keys=>JSON.stringify(keys)===${JSON.stringify(JSON.stringify(regenerated.mediaAssetKeys))})`);
        await app.waitFor(`document.activeElement===document.querySelector('${regenerate}')&&
            document.querySelector('${detailThumbnail} img').src!==${JSON.stringify(originalThumbnail)}`);
        await app.evaluate(`document.querySelector('${detailThumbnail}').scrollIntoView({block:'nearest'});`);
        await nativeClick(app, detailThumbnail);
        await app.waitFor(`(()=>{const image=document.querySelector('${fullscreenImage}');
            return image?.naturalWidth>0 && image.naturalWidth*16===image.naturalHeight*9;})()`);
        assert.equal(await app.evaluate("!!document.querySelector('.fullscreen-overlay .fullscreen-download-btn')"), true);
        assert.equal(await app.evaluate(`document.querySelector('${detailThumbnail}').getAttribute('aria-pressed')`), 'true');
        await closePreview(app, detailThumbnail);
        await app.waitFor(`(()=>{const image=document.querySelector('#commerce .commerce-image-set-cover');
            return image.naturalWidth>0 && image.naturalWidth*16===image.naturalHeight*9;})()`);
        await nativeClick(app, '#image-parameter-panel [data-parameter-action=close]');
        const resize = await app.evaluate(`(()=>{const node=document.getElementById('commerce');
            const handle=node.querySelector('.node-resize-handle--bottom-right'), rect=handle.getBoundingClientRect();
            const x=rect.x+rect.width/2, y=rect.y+rect.height/2;
            return {x,y,width:node.offsetWidth,viewportHeight:innerHeight,reachable:handle.contains(document.elementFromPoint(x,y))};})()`);
        assert.ok(resize.reachable, `the portrait resize handle can receive native input: ${JSON.stringify(resize)}`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: resize.x, y: resize.y, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resize.x + 48, y: resize.y + 44, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resize.x + 48, y: resize.y + 44, button: 'left', buttons: 0, clickCount: 1 });
        await app.waitFor(`document.getElementById('commerce').offsetWidth>${resize.width}`);
        assert.equal(await app.evaluate("document.getElementById('image-parameter-panel').hidden"), true);
        const geometry = await app.evaluate(`(()=>{const node=document.getElementById('commerce'), image=node.querySelector('.commerce-image-set-cover');
            return {width:node.offsetWidth,height:node.offsetHeight,ratio:image.naturalWidth/image.naturalHeight,
                border:getComputedStyle(node).borderTopWidth};})()`);
        assert.equal(geometry.border, '0px');
        assert.ok(Math.abs(geometry.width / geometry.ratio - geometry.height) <= 1, JSON.stringify(geometry));
        await openParameters(app, 'product');
        const selectionRing = await app.evaluate("getComputedStyle(document.querySelector('#product.selected')).boxShadow");
        assert.notEqual(selectionRing, 'none');
        await app.waitFor(`(()=>{const node=document.querySelector('#commerce:not(.selected)');
            return !!node&&getComputedStyle(node).boxShadow==='none';})()`);
        await nativeClick(app, '#commerce .commerce-image-set-cover');
        await app.waitFor("!!document.querySelector('#image-parameter-panel[data-node-id=commerce]:not([hidden])')");
        const selectedStyle = await app.evaluate(`(()=>{const node=document.querySelector('#commerce.selected');
            const style=getComputedStyle(node);
            return {ring:style.boxShadow,border:style.borderTopWidth,width:node.offsetWidth,height:node.offsetHeight};})()`);
        assert.deepEqual(selectedStyle, { ring: selectionRing, border: '0px', width: geometry.width, height: geometry.height });
        await nativeClick(app, `${setup} > summary`);
        await app.evaluate(`const platform=document.querySelector('#image-parameter-panel [data-commerce-field=platformId]');
            platform.value='taobao'; platform.dispatchEvent(new Event('change',{bubbles:true}));`);
        assert.deepEqual(await app.evaluate(selected), []);
        assert.equal(await app.evaluate(`${planButton}.disabled`), true);
        assert.equal(await app.evaluate("!!document.querySelector('#image-parameter-panel [data-commerce-select-shot=white]')"), true);
        assert.equal(await app.evaluate("!!document.querySelector('#image-parameter-panel [data-commerce-select-shot=included]')"), false);
        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',
            {bubbles:true,cancelable:true,clientX:75,clientY:380}));
            document.querySelector('#context-menu-image-nodes [data-type=ECommerceImageSet]').click();`);
        await app.waitFor("document.querySelectorAll('#nodes-layer .node-commerce-image-set').length===2");
        await openParameters(app, await app.evaluate("document.querySelector('#nodes-layer .node-commerce-image-set:not(#commerce)').id"));
        assert.equal(await app.evaluate(available), 9);
        assert.deepEqual(await app.evaluate(selected), []);
    }, { initScript });
});

test('commerce copy language persists and reaches planning, generation and retry', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', selectedShotIds: ['detail'], productInfo: { name: '带盖随行杯' },
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
    ];
    const connections = [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
        to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }];
    const initScript = `window.commerceLanguageRequests=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (options.body instanceof FormData) {
                commerceLanguageRequests.push({ kind:'image', prompt:options.body.get('prompt') });
                return Response.json({data:[{b64_json:${JSON.stringify(reference)}}]});
            }
            const {messages}=JSON.parse(options.body);
            const input=JSON.parse(messages.at(-1).content[0].text);
            commerceLanguageRequests.push({ kind:'plan', input, instructions:messages[0].content });
            const japanese=input.copyLanguage==='ja';
            const plan={sellingPoints:['杯盖可以拆卸'],shots:[{id:'detail',prompt:'近景展示杯盖，使用柔和侧光。',
                headline:japanese?'取り外せるフタ':'Removable lid',body:japanese?'お手入れしやすい設計':'Designed for easy cleaning'}]};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const language = "document.querySelector('#image-parameter-panel [data-commerce-field=copyLanguage]')";
    const planButton = "document.querySelector('[data-commerce-action=plan]')";
    const generateButton = "document.querySelector('[data-commerce-action=generate]')";
    const generationAvailable = `(${generateButton}?.checkVisibility() && !${generateButton}.disabled)`;
    const setup = '#image-parameter-panel .commerce-image-set-setup';
    const retry = "document.querySelector('[data-commerce-shot-id=detail] [data-commerce-action=retry]')";
    const saved = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(snapshot=>snapshot.value.nodes.find(node=>node.id==='commerce').commerceImageSet)`;
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections,
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        const control = await app.evaluate(`(() => {
            const select=${language};
            const label=select.labels[0].cloneNode(true);
            label.querySelector('select')?.remove();
            return { shared:select.matches('select.ui-select'), label:label.textContent.trim(),
                value:select.value, options:[...select.options].map(option=>option.value) };
        })()`);
        assert.equal(control.shared, true);
        assert.equal(control.label, '图中文字语言');
        assert.equal(control.value, 'auto');
        assert.ok(control.options.includes('en') && control.options.includes('ja'));
        await app.evaluate(`${planButton}.click()`);
        await app.waitFor(generationAvailable);
        const automatic = await app.evaluate('commerceLanguageRequests[0]');
        assert.equal(automatic.input.copyLanguage, 'auto');
        assert.match(automatic.instructions, /亚马逊.*英[语文]/);

        await nativeClick(app, `${setup} > summary`);
        await app.evaluate(`${language}.value='ja'; ${language}.dispatchEvent(new Event('change',{bubbles:true}));`);
        assert.equal(await app.evaluate(`Boolean(${generationAvailable})`), false, 'the previous language plan needs to be regenerated');
        assert.equal(await app.evaluate(`!${retry}?.checkVisibility() || ${retry}.disabled`), true);
        assert.equal(await app.evaluate(`${language}.checkVisibility()`), true, 'the stale plan leaves the selected language visible');
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-select-shot=detail]').checked"), true);
        await app.waitFor(`${saved}.then(settings=>settings.copyLanguage==='ja' && settings.plan?.stale===true)`);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`${language}.value`), 'ja');
        assert.equal(await app.evaluate(`Boolean(${generationAvailable})`), false);
        await app.evaluate(`${planButton}.click()`);
        await app.waitFor(generationAvailable);
        const request = await app.evaluate('commerceLanguageRequests[0]');
        assert.equal(request.input.copyLanguage, 'ja');
        assert.equal(request.input.productInfo.name, '带盖随行杯');
        assert.match(request.instructions, /日[语文]/);

        await app.evaluate(`${generateButton}.click()`);
        await app.waitFor(`${saved}.then(settings=>settings.results.some(result=>result.status==='completed'))`);
        await app.waitFor(`${retry}?.checkVisibility() && !${retry}.disabled`);
        await app.evaluate(`${retry}.click()`);
        await app.waitFor(`commerceLanguageRequests.filter(request=>request.kind==='image').length===2 && !${retry}.disabled`);
        const prompts = await app.evaluate("commerceLanguageRequests.filter(request=>request.kind==='image').map(request=>request.prompt)");
        for (const prompt of prompts) {
            assert.match(prompt, /日[语文]/);
            assert.match(prompt, /标题：\s*"取り外せるフタ"/);
            assert.match(prompt, /正文：\s*"お手入れしやすい設計"/);
            assert.doesNotMatch(prompt, /Removable lid/);
        }
    }, { initScript });
});

test('commerce product textareas adapt to six rows and retain a manually enlarged field while editing', { timeout: 30000 }, async () => {
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes: [{ id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100 }], connections: [] }, async app => {
        await openParameters(app, 'commerce');
        await app.evaluate("document.querySelector('.commerce-image-set-product-more').open=true");
        const edit = (field, value) => app.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(commerceProductField(field))});
            input.value = ${JSON.stringify(value)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        for (const field of ['sellingPoints', 'audience', 'useCases', 'details']) {
            for (const rows of [1, 4, 6, 8, 1]) {
                await edit(field, Array.from({ length: rows }, (_, index) => `短文 ${index + 1}`).join('\n'));
                const size = await measureProductField(app, field);
                assertProductFieldRows(size, Math.max(2, Math.min(6, rows)), field);
                assert.equal(size.overflows, rows > 6, `${field} scrolls only above the automatic cap`);
            }
        }

        const field = 'details';
        const selector = commerceProductField(field);
        await edit(field, '杯身和杯盖的外观说明。'.repeat(70));
        const wrapped = await measureProductField(app, field);
        assertProductFieldRows(wrapped, 6, 'visually wrapped product details');
        assert.equal(wrapped.overflows, true);
        const grip = await app.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(selector)});
            input.scrollIntoView({ block: 'center' });
            const { right, bottom } = input.getBoundingClientRect();
            return { x: right - 5, y: bottom - 5 };
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...grip });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...grip, button: 'left', buttons: 1, clickCount: 1 });
        const end = { x: grip.x, y: grip.y + 72 };
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 });
        await app.waitFor(`document.querySelector(${JSON.stringify(selector)}).offsetHeight > ${wrapped.height + 30}`);
        const manuallyResized = await measureProductField(app, field);
        await edit(field, '保留手动高度');
        assert.equal((await measureProductField(app, field)).height, manuallyResized.height);
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), '保留手动高度');
    });
});

test('commerce analysis saves editable fields and rejects a response for a replaced reference', { timeout: 30000 }, async () => {
    const reference = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const replacement = 'data:image/png;base64,' + (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p' } }
    ];
    const connections = [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
        to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }];
    const models = [
        { id: 'vision', name: '商品分析模型', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
        { id: 'image', name: '商品图片模型', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }
    ];
    const providers = [{ id: 'p', name: '商品摄影供应商', endpoint: 'https://fixture.test/v1', apikey: 'test' }];
    const inferred = { name: 'AI 随行杯', sellingPoints: ['附带杯盖', '圆润杯身'],
        audience: '日常通勤人群', useCases: '办公室饮水', details: '参考图中可见杯盖\n杯身圆润\n杯口可见\n底部平整' };
    const replacementDetails = '蓝色杯身配杯盖';
    const initScript = `window.commerceProductCalls=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            const body=JSON.parse(options.body);
            const [text,photo]=body.messages.at(-1).content;
            const input=JSON.parse(text.text);
            const planning=Array.isArray(input.shots);
            commerceProductCalls.push({kind:planning?'plan':'analyze',input,image:photo.image_url.url});
            const productInfo=${JSON.stringify(inferred)};
            if (!planning && commerceProductCalls.length>1) productInfo.details='基于旧参考图的分析';
            else if (photo.image_url.url===${JSON.stringify(replacement)}) productInfo.details=${JSON.stringify(replacementDetails)};
            const reply={productInfo};
            if (planning) {
                reply.sellingPoints=productInfo.sellingPoints;
                reply.shots=input.shots.map(({id})=>({id,prompt:'用柔和侧光突出杯盖。',headline:'日常随行',body:''}));
            } else {
                await new Promise(resolve=>{window.releaseProductAnalysis=resolve;});
            }
            return Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});
        };`;
    const analyze = '#image-parameter-panel [data-commerce-action=analyze]';
    const plan = '#image-parameter-panel [data-commerce-action=plan]';
    const generate = '#image-parameter-panel [data-commerce-action=generate]';
    const name = '用户命名的随行杯';
    const sellingPoints = ['便于拿取的杯盖', '杯身握持舒适'];
    const edit = (app, field, value) => app.evaluate(`(()=>{
        const control=document.querySelector(${JSON.stringify(commerceProductField(field))});
        control.value=${JSON.stringify(value)};
        control.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections, models, providers }, async app => {
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`document.querySelector('${analyze}').disabled`), true);
        await uploadImageOriginal(app, 'product', reference);
        await app.waitFor(`!document.querySelector('${analyze}')?.disabled`);
        assert.equal(await app.evaluate(`document.querySelector('${plan}').disabled`), true, 'analysis does not require selected shots');
        assert.equal(await app.evaluate(commerceProductValue('name')), '');
        await edit(app, 'name', name);
        await app.evaluate(`document.querySelector('${analyze}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, analyze);
        await app.waitFor(`typeof window.releaseProductAnalysis==='function' && document.querySelector('${analyze}').disabled`);
        assert.deepEqual(await app.evaluate('commerceProductCalls.map(call=>call.kind)'), ['analyze']);
        assert.equal(await app.evaluate('commerceProductCalls[0].image'), reference);
        assert.equal(await app.evaluate('commerceProductCalls[0].input.productInfo.name'), name);
        await app.evaluate('window.releaseProductAnalysis()');
        await app.waitFor(`${commerceProductValue('sellingPoints')}===${JSON.stringify(inferred.sellingPoints.join('\n'))}`);
        assert.equal(await app.evaluate(commerceProductValue('name')), name, 'analysis leaves the entered name intact');
        for (const field of ['audience', 'useCases', 'details']) {
            assert.equal(await app.evaluate(commerceProductValue(field)), inferred[field]);
        }
        await app.evaluate("document.querySelector('.commerce-image-set-product-more').open=true;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        assertProductFieldRows(await measureProductField(app, 'details'), 4, 'analysis fills the field and sizes it to the new text');
        assert.equal(await app.evaluate("document.querySelectorAll('[data-commerce-shot-id]').length"), 0);
        assert.equal(await app.evaluate(`document.querySelector('${generate}').checkVisibility()`), false);
        await edit(app, 'sellingPoints', sellingPoints.join('\n'));

        await app.waitFor(`!document.querySelector('${analyze}').disabled`);
        await app.evaluate(`window.releaseProductAnalysis=null;document.querySelector('${analyze}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, analyze);
        await app.waitFor("commerceProductCalls.length===2 && typeof window.releaseProductAnalysis==='function'");
        assert.equal(await app.evaluate('commerceProductCalls[1].image'), reference);
        await uploadImageOriginal(app, 'product', replacement);
        await app.evaluate('window.releaseProductAnalysis()');
        await app.waitFor("document.querySelector('.commerce-image-set-status').textContent.includes('商品参考图已改变')");
        assert.equal(await app.evaluate(commerceProductValue('details')), inferred.details);
        assert.equal(await app.evaluate(commerceProductValue('sellingPoints')), sellingPoints.join('\n'));

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(commerceProductValue('name')), name);
        assert.equal(await app.evaluate(commerceProductValue('sellingPoints')), sellingPoints.join('\n'));
        assert.equal(await app.evaluate(commerceProductValue('details')), inferred.details);
        const savedPlan = await app.evaluate(`fetch('/api/storage/documents/session').then(response=>response.json())
            .then(document=>document.value.nodes.find(node=>node.id==='commerce').commerceImageSet.plan)`);
        assert.equal(savedPlan, null);
        await app.evaluate("document.querySelector('input[data-commerce-select-shot=detail]').click()");
        await captureProductInspector(app);
        await nativeClick(app, plan);
        await app.waitFor(`document.querySelector('${generate}').checkVisibility() && !document.querySelector('${generate}').disabled`);
        assert.deepEqual(await app.evaluate('commerceProductCalls.map(call=>call.kind)'), ['plan']);
        assert.equal(await app.evaluate('commerceProductCalls[0].image'), replacement);
        assert.equal(await app.evaluate('commerceProductCalls[0].input.productInfo.name'), name);
        assert.deepEqual(await app.evaluate('commerceProductCalls[0].input.productInfo.sellingPoints'), sellingPoints);
        assert.equal(await app.evaluate(commerceProductValue('sellingPoints')), sellingPoints.join('\n'));
        assert.equal(await app.evaluate(commerceProductValue('details')), replacementDetails);
    }, { initScript });
});

test('failed commerce generation and retries leave error details closed until requested', { timeout: 25000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', selectedShotIds: ['detail'],
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
    ];
    const connections = [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
        to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }];
    const failure = 'Fixture commerce generation failure';
    const initScript = `window.commerceImageFailure=true;
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (options.body instanceof FormData) {
                return window.commerceImageFailure
                    ? Response.json({error:{message:${JSON.stringify(failure)}}},{status:500})
                    : Response.json({data:[{b64_json:${JSON.stringify(reference)}}]});
            }
            const plan={sellingPoints:[],shots:[{id:'detail',prompt:'近景展示杯盖，使用柔和侧光。',headline:'',body:''}]};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const row = "document.querySelector('#image-parameter-panel [data-commerce-shot-id=detail]')";
    const status = "document.querySelector('.commerce-image-set-status').textContent";
    const modal = "document.getElementById('modal-error')";
    const retry = `${row}.querySelector('[data-commerce-action=retry]')`;
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, autoRetry: false, nodes, connections,
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        await app.evaluate("document.querySelector('[data-commerce-action=plan]').click()");
        await app.waitFor("document.querySelector('[data-commerce-action=generate]')?.checkVisibility() && !document.querySelector('[data-commerce-action=generate]').disabled");
        await app.evaluate("document.querySelector('[data-commerce-action=generate]').click()");
        await app.waitFor(`${row}?.dataset.resultStatus==='failed' && ${status}.includes(${JSON.stringify(failure)})`);
        assert.equal(await app.evaluate(`${modal}.classList.contains('active')`), false, 'an entirely failed suite keeps the error dialog closed');

        const failureButton = '#image-parameter-panel [data-commerce-shot-id=detail] [data-commerce-action=error-detail]';
        await nativeClick(app, failureButton);
        await app.waitFor(`${modal}.classList.contains('active')`);
        assert.equal(await app.evaluate("document.getElementById('error-modal-msg').textContent"), failure);
        await key(app, 'Escape');
        await app.waitFor(`!${modal}.classList.contains('active')`);

        await app.evaluate(`window.commerceImageFailure=false; ${retry}.click()`);
        await app.waitFor(`${row}.dataset.resultStatus==='completed' && !${retry}.disabled && ${row}.querySelector('img').naturalWidth>0`);
        const original = await app.evaluate(`${row}.querySelector('img').src`);
        await app.evaluate(`window.commerceImageFailure=true; ${retry}.click()`);
        await app.waitFor(`${status}.includes(${JSON.stringify(failure)}) && !${retry}.disabled`);
        assert.equal(await app.evaluate(`${modal}.classList.contains('active')`), false, 'a failed regeneration also keeps the error dialog closed');
        assert.equal(await app.evaluate(`${row}.querySelector('img').src`), original, 'a failed regeneration preserves the previous image');
    }, { initScript });
});
