import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { openParameters } from './helpers/image-first-integrated-fixture.mjs';

const panel = '#image-parameter-panel';
const artField = `${panel} [data-commerce-art-direction]`;
const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
const action = name => `${panel} [data-commerce-action=${name}]`;
const ready = name => `${query(action(name))}?.checkVisibility() && !${query(action(name))}.disabled`;
const stored = `fetch('/api/storage/documents/session').then(response=>response.json())
    .then(snapshot=>snapshot.value.nodes.find(node=>node.id==='commerce').commerceImageSet)`;
const autoStyle = '草木绿与米白，柔和侧光，真实细腻材质；按图位变化构图。';

function session(platformId, selectedShotIds) {
    return { autoCheckUpdatesOnLoad: false,
        nodes: [{ id: 'product', type: 'ImageImport', x: 30, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 400, y: 100, commerceImageSet: {
                platformId, selectedShotIds, plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p' } }],
        connections: [{ id: 'product-photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }] };
}

function modelScript(image) {
    return `window.artDirectionRequests=[];window.proposedArtDirection=${JSON.stringify(autoStyle)};
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url,options)=>{
            if(url!=='/proxy'||!options?.body)return actualFetch(url,options);
            if(options.body instanceof FormData){
                artDirectionRequests.push({kind:'image',prompt:options.body.get('prompt')});
                return Response.json({data:[{b64_json:${JSON.stringify(image)}}]});
            }
            const {messages}=JSON.parse(options.body),input=JSON.parse(messages.at(-1).content[0].text);
            artDirectionRequests.push({kind:'plan',input,system:messages.find(message=>message.role==='system').content});
            return Response.json({choices:[{message:{content:JSON.stringify({productInfo:{name:'随行杯',sellingPoints:['杯盖可拆卸']},
                artDirection:proposedArtDirection,
                shots:input.shots.map(shot=>({id:shot.id,prompt:'展示'+shot.id+'的商品重点，按整套风格选择构图。',headline:'轻松随行',body:'杯盖可拆卸'}))})}}]});
        };`;
}

async function editArt(app, value) {
    await app.evaluate(`(()=>{const input=${query(artField)};input.value=${JSON.stringify(value)};
        input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}

async function captureArtControls(app) {
    const directory = process.env.CAINFLOW_QA_SCREENSHOT_DIR;
    if (directory) await mkdir(directory, { recursive: true });
    for (const theme of ['light', 'dark']) {
        for (const width of [1100, 390]) {
            await app.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
            await app.evaluate(`document.documentElement.dataset.appTheme='${theme}';
                ${query(`${panel} .commerce-image-set-setup`)}.open=true;
                ${query(`${panel} .commerce-image-set-art-direction`)}.scrollIntoView({block:'start'});
                new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));`);
            const geometry = await app.evaluate(`(()=>{
                const section=${query(`${panel} .commerce-image-set-art-direction`)},input=${query(artField)},
                    mode=${query(`${panel} [data-commerce-field=mainImageMode]`)},language=${query(`${panel} [data-commerce-field=copyLanguage]`)},
                    reset=${query(`${panel} [data-commerce-art-direction-reset]`)},bounds=${query(panel)}.getBoundingClientRect();
                const measured=element=>{const rect=element.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width,height:rect.height};};
                return {visible:section.checkVisibility(),overflow:section.scrollWidth>section.clientWidth,
                    input:measured(input),mode:measured(mode),language:measured(language),panel:{left:bounds.left,right:bounds.right},
                    modeLabel:mode.selectedOptions[0].textContent,
                    sharedMode:mode.classList.contains('ui-select'),sharedReset:reset.classList.contains('btn')&&reset.classList.contains('btn-secondary')};})()`);
            assert.ok(geometry.visible && !geometry.overflow && geometry.input.width > 0 && geometry.mode.width > 0,
                JSON.stringify(geometry));
            assert.ok(geometry.input.left >= geometry.panel.left && geometry.input.right <= geometry.panel.right + 1,
                JSON.stringify(geometry));
            assert.ok(geometry.mode.left >= geometry.panel.left && geometry.mode.right <= geometry.panel.right + 1,
                JSON.stringify(geometry));
            assert.equal(geometry.sharedMode, true);
            assert.equal(geometry.sharedReset, true, 'the reset action uses the shared secondary button');
            assert.equal(geometry.modeLabel, '生成白底图');
            assert.ok(geometry.mode.height <= geometry.language.height + 1,
                `MAIN mode remains a readable single-line control at ${width}px: ${JSON.stringify(geometry)}`);
            if (directory) {
                const { data } = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                await writeFile(`${directory}/art-direction-${theme}-${width}.png`, Buffer.from(data, 'base64'));
            }
        }
    }
}

test('整套美术风格自动规划后保存恢复，单图沿用，自设与重置会保留成图并要求重新规划', { timeout: 45000 }, async () => {
    const image = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    await withAppBrowser(session('taobao', ['main', 'detail']), async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${image}`);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`${query(artField)}.value`), '');
        await app.evaluate(`${query(action('plan'))}.click()`);
        await app.waitFor(`${ready('generate')} && ${query(artField)}.value===${JSON.stringify(autoStyle)}`);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`${query(artField)}.value`), autoStyle);
        await app.evaluate(`${query(action('generate'))}.click()`);
        await app.waitFor(`${stored}.then(settings=>settings.results.filter(row=>row.status==='completed').length===2)`);
        let prompts = await app.evaluate(`artDirectionRequests.filter(request=>request.kind==='image').map(request=>request.prompt)`);
        assert.equal(prompts.length, 2);
        assert.ok(prompts.every(prompt => prompt.includes(autoStyle)));
        const previous = await app.evaluate(`${stored}.then(settings=>settings.results.map(row=>row.assetKey))`);
        const rewrite = `${panel} [data-commerce-shot-id=detail] [data-commerce-action=replan-shot]`;
        await app.evaluate(`${query(rewrite)}.click()`);
        await app.waitFor(`${stored}.then(settings=>settings.plan?.artDirection===${JSON.stringify(autoStyle)} && !settings.plan.confirmed)`);
        const rewriting = await app.evaluate(`artDirectionRequests.filter(request=>request.kind==='plan').at(-1)`);
        assert.ok(rewriting.system.includes(autoStyle));
        const manual = '冷蓝水彩，纸张肌理，安静通透；各图位自由安排空间。';
        await editArt(app, manual);
        await app.waitFor(`${stored}.then(settings=>settings.artDirection===${JSON.stringify(manual)} && settings.plan?.stale)`);
        assert.equal(await app.evaluate(`Boolean(${ready('generate')})`), false);
        assert.deepEqual(await app.evaluate(`${stored}.then(settings=>settings.results.map(row=>row.assetKey))`), previous);
        await app.evaluate(`${query(action('plan'))}.click()`);
        await app.waitFor(`${ready('generate')} && ${query(artField)}.value===${JSON.stringify(manual)}`);
        await app.evaluate(`${query(action('generate'))}.click()`);
        await app.waitFor(`artDirectionRequests.filter(request=>request.kind==='image').length===4`);
        await app.waitFor(`${stored}.then(settings=>settings.plan.confirmed && settings.results.filter(row=>row.status==='completed').length===2)`);
        prompts = await app.evaluate(`artDirectionRequests.filter(request=>request.kind==='image').slice(-2).map(request=>request.prompt)`);
        assert.ok(prompts.every(prompt => prompt.includes(manual)));
        await app.evaluate(`window.proposedArtDirection='暖棕真实摄影，柔和日光与木质氛围';
            ${query(`${panel} [data-commerce-art-direction-reset]`)}.click()`);
        await app.waitFor(`${stored}.then(settings=>!settings.artDirection && !settings.plan.artDirection && settings.plan.stale)`);
        await app.evaluate(`${query(action('plan'))}.click()`);
        await app.waitFor(`${ready('generate')} && ${query(artField)}.value==='暖棕真实摄影，柔和日光与木质氛围'`);
    }, { initScript: modelScript(image) });
});

test('亚马逊新 MAIN 默认生成白底精修，海报风格仅用于副图并保留共享控件', { timeout: 30000 }, async () => {
    const image = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    await withAppBrowser(session('amazon', ['main', 'detail']), async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${image}`);
        await openParameters(app, 'commerce');
        const mode = `${panel} [data-commerce-field=mainImageMode]`;
        assert.equal(await app.evaluate(`${query(mode)}.value`), 'generate');
        await editArt(app, '黑金海报，大标题与舞台背景');
        await captureArtControls(app);
        await app.evaluate(`${query(action('plan'))}.click()`);
        await app.waitFor(ready('generate'));
        const planning = await app.evaluate(`artDirectionRequests.find(request=>request.kind==='plan')`);
        assert.deepEqual(planning.input.shots.map(shot => shot.id), ['main', 'detail']);
        await app.evaluate(`${query(action('generate'))}.click()`);
        await app.waitFor(`${stored}.then(settings=>settings.results.filter(row=>row.status==='completed').length===2)`);
        const requests = await app.evaluate(`artDirectionRequests.filter(request=>request.kind==='image')`);
        assert.equal(requests.length, 2);
        assert.match(requests[0].prompt, /RGB.*255/);
        assert.match(requests[0].prompt, /主图要求.*优先/);
        assert.match(requests[0].prompt, /画面不添加标题、正文/);
        assert.doesNotMatch(requests[0].prompt, /风格描述：黑金海报/);
        assert.match(requests[1].prompt, /风格描述：黑金海报/);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`${query(mode)}.value`), 'generate');
        assert.equal((await app.evaluate(stored)).plan.shots[0].source, 'generate');
    }, { initScript: modelScript(image) });
});
