import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { openParameters } from './helpers/image-first-integrated-fixture.mjs';

test('主副图和详情图独立参考经过上传、保存恢复、规划及实际生图，替换移除不影响其他图位', { timeout: 40000 }, async () => {
    const [product, main, detail, replacement] = await Promise.all(['red', 'blue', 'green', 'yellow']
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
        nodes: [{ id: 'product', type: 'ImageImport', x: 30, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 400, y: 100, commerceImageSet: {
                platformId: 'taobao', selectedShotIds: ['main', 'detail-overview'],
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }],
        connections: [{ id: 'product-photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${product}`);
        await openParameters(app, 'commerce');
        await app.evaluate("document.querySelector('.commerce-shot-references').open=true");
        const upload = async (id, bytes, replacing = false) => {
            await app.evaluate(`(async()=>{const row=document.querySelector('[data-commerce-reference-shot=${id}]');
                ${replacing ? "row.querySelector('[data-commerce-reference-replace]').click();" : ''}
                const input=row.querySelector('input[type=file]'),files=new DataTransfer();
                files.items.add(new File([await(await fetch('data:image/png;base64,${bytes}')).blob()],'design.png',{type:'image/png'}));
                input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            await app.waitFor(`${stored}.then(settings=>settings.shotReferences?.[${JSON.stringify(id)}]?.length===1)`);
        };
        await upload('main', main);
        await upload('detail-overview', detail);
        const first = await app.evaluate(stored);
        assert.ok(first.shotReferences.main[0].startsWith('media:'));
        assert.notEqual(first.shotReferences.main[0], first.shotReferences['detail-overview'][0]);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.deepEqual((await app.evaluate(stored)).shotReferences, first.shotReferences);
        await app.evaluate("document.querySelector('[data-commerce-action=plan]').click()");
        await app.waitFor("!!document.querySelector('[data-commerce-action=generate]:not([disabled])')");
        const planning = await app.evaluate("designReferenceRequests.find(request=>request.kind==='plan')");
        assert.deepEqual(planning.images, [product, main, detail]);
        assert.deepEqual(planning.input.shotReferenceMap, { main: [2], 'detail-overview': [3] });
        await app.evaluate("document.querySelector('[data-commerce-action=generate]').click()");
        await app.waitFor(`${stored}.then(settings=>settings.results.filter(row=>row.status==='completed').length===2)`);
        const images = await app.evaluate("designReferenceRequests.filter(request=>request.kind==='image')");
        assert.equal(images.length, 2);
        assert.deepEqual(images[0].images, [product, main]);
        assert.deepEqual(images[1].images, [product, detail]);
        assert.match(images[0].prompt, /设计参考.*仅借鉴/);
        assert.match(images[1].prompt, /不复制设计参考中的商品、文字/);
        await app.evaluate("document.querySelector('.commerce-shot-references').open=true");
        await upload('main', replacement, true);
        await app.waitFor(`${stored}.then(settings=>settings.shotReferences.main[0]!==${JSON.stringify(first.shotReferences.main[0])})`);
        const changed = await app.evaluate(stored);
        assert.deepEqual(changed.shotReferences['detail-overview'], first.shotReferences['detail-overview']);
        assert.equal(changed.plan.confirmed, false);
        assert.equal(changed.plan.stale, undefined);
        await app.evaluate("document.querySelector('[data-commerce-reference-shot=main] [data-commerce-reference-remove]').click()");
        await app.waitFor(`${stored}.then(settings=>!settings.shotReferences?.main)`);
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            for (const [theme, width] of [['light', 1100], ['dark', 390]]) {
                await app.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
                await app.evaluate(`(()=>{document.documentElement.dataset.appTheme='${theme}';
                    const section=document.querySelector('.commerce-shot-references');section.open=true;
                    section.scrollIntoView({block:'start'});
                    document.querySelectorAll('#toast-container .toast').forEach(toast=>toast.remove());})()`);
                const geometry = await app.evaluate(`(()=>{const section=document.querySelector('.commerce-shot-references');
                    const bounds=section.getBoundingClientRect(), panel=document.getElementById('image-parameter-panel').getBoundingClientRect();
                    return {visible:section.checkVisibility(),left:bounds.left,right:bounds.right,panelLeft:panel.left,panelRight:panel.right,
                        overflow:section.scrollWidth>section.clientWidth, references:[...section.querySelectorAll('img')].map(image=>image.naturalWidth),
                        buttons:[...section.querySelectorAll('[data-commerce-reference-add], [data-commerce-reference-replace], [data-commerce-reference-remove]')]
                            .map(button=>({height:button.offsetHeight,whitespace:getComputedStyle(button).whiteSpace,fontSize:parseFloat(getComputedStyle(button).fontSize)}))};})()`);
                assert.ok(geometry.visible && geometry.left >= geometry.panelLeft && geometry.right <= geometry.panelRight + 1 && !geometry.overflow,
                    JSON.stringify(geometry));
                assert.ok(geometry.references.every(width => width > 0));
                assert.ok(geometry.buttons.every(button=>button.height>=26 && button.whitespace==='nowrap' && button.fontSize>=13));
                const capture = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                await writeFile(`${process.env.CAINFLOW_QA_SCREENSHOT_DIR}/shot-references-${theme}-${width}.png`, Buffer.from(capture.data, 'base64'));
            }
        }
    }, { initScript });
});
