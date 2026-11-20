import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { openParameters } from './helpers/image-first-integrated-fixture.mjs';

test('连线与场景、历史选图支持图位类型与整套参考，保存重开后按范围规划、生图', { timeout: 55000 }, async () => {
    const [product, main, detail, shared, replacement] = await Promise.all(['red', 'blue', 'green', 'yellow', 'orange']
        .map(color => readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url)).then(buffer => buffer.toString('base64'))));
    const stored = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(snapshot=>snapshot.value.nodes.find(node=>node.id==='commerce').commerceImageSet)`;
    const initScript = `window.designReferenceRequests=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url,options)=>{
            if(url!=='/proxy'||!options?.body)return actualFetch(url,options);
            if(options.body instanceof FormData){
                const images=await Promise.all([...options.body.values()].filter(value=>value instanceof Blob).map(file=>new Promise(resolve=>{
                    const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(file);
                })));
                designReferenceRequests.push({kind:'image',prompt:options.body.get('prompt'),images});
                return Response.json({data:[{b64_json:${JSON.stringify(product)}}]});
            }
            const {messages}=JSON.parse(options.body),content=messages.at(-1).content;
            const input=JSON.parse(content[0].text);
            designReferenceRequests.push({kind:'plan',input,images:content.filter(part=>part.type==='image_url').map(part=>part.image_url.url.split(',')[1])});
            return Response.json({choices:[{message:{content:JSON.stringify({sellingPoints:['可拆杯盖'],
                artDirection:'冷蓝清透的商业摄影，柔和侧光，统一简洁字形；各图按用途选择不同构图。',
                shots:input.shots.map(shot=>({id:shot.id,prompt:'设计'+shot.id+'，保持真实商品。',headline:'轻松随行',body:'可拆杯盖'}))})}}]});
        };`;
    await withAppBrowser({ autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'product', type: 'ImageImport', x: 30, y: 620 },
            { id: 'layout', type: 'ImageImport', customTitle: '主图样张', x: 440, y: 620 },
            { id: 'lighting', type: 'ImageImport', customTitle: '详情样张', x: 30, y: 180 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 480, y: 180, commerceImageSet: {
                platformId: 'taobao', selectedShotIds: ['main'],
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }],
        connections: [{ id: 'product-photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await writeFile(join(app.server.dataDir, 'exports', 'shared.png'), Buffer.from(shared, 'base64'));
        await writeFile(join(app.server.dataDir, 'exports', 'replacement.png'), Buffer.from(replacement, 'base64'));
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${product}`);
        await uploadImageOriginal(app, 'lighting', `data:image/png;base64,${detail}`);
        await uploadImageOriginal(app, 'layout', `data:image/png;base64,${main}`);
        const hitPoint = async (selector, horizontalFraction) => {
            const point = await app.evaluate(`(()=>{const dot=document.querySelector(${JSON.stringify(selector)});
                if(!dot)return null;
                const box=dot.getBoundingClientRect(),x=box.x+box.width*${horizontalFraction},y=box.y+box.height/2;
                return dot.contains(document.elementFromPoint(x,y)) ? {x,y} : null;})()`);
            assert.ok(point, '端口应可由鼠标直接命中 ' + selector);
            return point;
        };
        const from = await hitPoint('#lighting .node-port.output .port-dot', 0.75);
        const to = await hitPoint('#commerce .node-port[data-port=styleReferenceImages] .port-dot', 0.25);
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 24, y: from.y, buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
        await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(saved=>saved.value.connections.some(edge=>edge.from.nodeId==='lighting' && edge.to.nodeId==='commerce' && edge.to.port==='styleReferenceImages'))");
        await openParameters(app, 'commerce');
        const click = selector => app.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
        const openReferences = async () => {
            await app.evaluate(`(() => {
                const configuration = document.querySelector('.commerce-image-set-configuration');
                if (!configuration.open) configuration.querySelector(':scope > summary').click();
                const references = configuration.querySelector('.commerce-shot-references');
                if (!references.open) references.querySelector(':scope > summary').click();
            })()`);
            await app.waitFor("document.querySelector('.commerce-shot-references [data-commerce-reference-add]').checkVisibility()");
        };
        const picker = 'dialog.commerce-reference-picker[open]';
        const referenceKeys = "[...document.querySelectorAll('[data-commerce-reference-key]')].map(row=>row.dataset.commerceReferenceKey)";
        const row = key => `[data-commerce-reference-key=${JSON.stringify(key)}]`;
        const select = async (key, type) => {
            const selector = JSON.stringify(row(key) + ' [data-commerce-reference-type]');
            await app.evaluate(`(()=>{const select=document.querySelector(${selector});select.value=${JSON.stringify(type)};
                select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        };
        const pick = async (source, choice, replaceKey) => {
            const before = await app.evaluate(referenceKeys);
            await click(replaceKey ? row(replaceKey) + ' [data-commerce-reference-replace]' : '[data-commerce-reference-add]');
            await app.waitFor(`Boolean(document.querySelector('${picker}'))`);
            await click(`${picker} [data-reference-source="${source}"]`);
            const target = source === 'canvas'
                ? `document.querySelector('${picker} [data-reference-node="${choice}"]')`
                : `[...document.querySelectorAll('${picker} [data-reference-history]')].find(button=>button.textContent.includes(${JSON.stringify(choice)}))`;
            await app.waitFor(`Boolean(${target})`);
            await app.evaluate(`${target}.click()`);
            const added = `${referenceKeys}.find(key=>!${JSON.stringify(before)}.includes(key))`;
            await app.waitFor(`!document.querySelector('${picker}') && Boolean(${added})`);
            return app.evaluate(added);
        };
        await openReferences();
        assert.match(await app.evaluate("document.querySelector('.commerce-shot-references summary').textContent"), /风格参考图/);
        await app.waitFor(`${referenceKeys}.length===1`);
        const [connectedKey] = await app.evaluate(referenceKeys);
        await select(connectedKey, 'detail-overview');
        const mainKey = await pick('canvas', 'layout');
        await select(mainKey, 'main');
        const sharedKey = await pick('history', 'shared.png');
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        const typeOf = key => app.evaluate(`document.querySelector(${JSON.stringify(row(key) + ' [data-commerce-reference-type]')}).value`);
        assert.deepEqual(await Promise.all([typeOf(connectedKey), typeOf(mainKey), typeOf(sharedKey)]), ['detail-overview', 'main', '']);
        await click('[data-commerce-select-shot="detail-overview"]');
        await app.evaluate("document.querySelector('[data-commerce-action=plan]').click()");
        await app.waitFor("!!document.querySelector('[data-commerce-action=generate]:not([disabled])')");
        const planning = await app.evaluate("designReferenceRequests.find(request=>request.kind==='plan')");
        assert.equal(planning.input.productReferenceCount, 1);
        assert.equal(planning.images[0], product);
        assert.deepEqual(planning.images.slice(1).sort(), [shared, main, detail].sort());
        for (const [id, scoped] of [['main', main], ['detail-overview', detail]]) {
            assert.deepEqual(planning.input.shotReferenceMap[id].map(index => planning.images[index - 1]).sort(), [shared, scoped].sort());
        }
        await app.evaluate("document.querySelector('[data-commerce-action=generate]').click()");
        await app.waitFor(`${stored}.then(settings=>settings.results.filter(row=>row.status==='completed').length===2)`);
        const images = await app.evaluate("designReferenceRequests.filter(request=>request.kind==='image')");
        assert.equal(images.length, 2);
        for (const [id, scoped] of [['main', main], ['detail-overview', detail]]) {
            const request = images.find(item => item.prompt.includes('设计' + id));
            assert.ok(request, id);
            assert.equal(request.images[0], product);
            assert.deepEqual(request.images.slice(1).sort(), [shared, scoped].sort());
        }
        assert.match(images[0].prompt, /设计参考.*仅借鉴/);
        assert.match(images[1].prompt, /不复制设计参考中的商品、文字/);
        await openReferences();
        const replacedKey = await pick('history', 'replacement.png', mainKey);
        assert.equal(await typeOf(replacedKey), 'main');
        await app.waitFor(`${stored}.then(settings=>settings.plan.confirmed===false)`);
        await click(row(replacedKey) + ' [data-commerce-reference-remove]');
        assert.deepEqual((await app.evaluate(referenceKeys)).sort(), [connectedKey, sharedKey].sort());
        assert.equal(await typeOf(connectedKey), 'detail-overview');
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            for (const [theme, width] of [['light', 1100], ['dark', 390]]) {
                await app.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
                await openReferences();
                await app.evaluate(`(()=>{document.documentElement.dataset.appTheme='${theme}';
                    const section=document.querySelector('.commerce-shot-references');
                    section.scrollIntoView({block:'start'});
                    document.querySelectorAll('#toast-container .toast').forEach(toast=>toast.remove());})()`);
                const geometry = await app.evaluate(`(()=>{const section=document.querySelector('.commerce-shot-references');
                    const bounds=section.getBoundingClientRect(), panel=document.getElementById('image-parameter-panel').getBoundingClientRect();
                    return {visible:section.checkVisibility(),left:bounds.left,right:bounds.right,panelLeft:panel.left,panelRight:panel.right,
                        overflow:section.scrollWidth>section.clientWidth, references:[...section.querySelectorAll('img')].map(image=>image.naturalWidth),
                        buttons:[...section.querySelectorAll('[data-commerce-reference-add], [data-commerce-reference-replace], [data-commerce-reference-remove]')]
                            .filter(button=>button.checkVisibility())
                            .map(button=>({height:button.offsetHeight,whitespace:getComputedStyle(button).whiteSpace,fontSize:parseFloat(getComputedStyle(button).fontSize)}))};})()`);
                assert.ok(geometry.visible && geometry.left >= geometry.panelLeft && geometry.right <= geometry.panelRight + 1 && !geometry.overflow,
                    JSON.stringify(geometry));
                assert.ok(geometry.references.every(width => width > 0));
                assert.ok(geometry.buttons.length > 0 && geometry.buttons.every(button=>button.height>=26 && button.whitespace==='nowrap' && button.fontSize>=13),
                    JSON.stringify(geometry.buttons));
                const capture = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                await writeFile(`${process.env.CAINFLOW_QA_SCREENSHOT_DIR}/shot-references-${theme}-${width}.png`, Buffer.from(capture.data, 'base64'));
            }
        }
    }, { initScript });
});
