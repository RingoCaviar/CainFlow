import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reloadAppBrowser, withAppBrowser } from './helpers/app-browser.mjs';
import { openParameters } from './helpers/image-first-integrated-fixture.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';

const overview = 'detail-overview';
const feature = 'detail-feature';
const nodeId = 'commerce';
const preview = '#commerce-detail-page-dialog';
const exportDialog = '#commerce-export-dialog';
const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
const copy = '便携随行\n单手开合';
const changedCopy = '顺手开盖\n单手开合';

function readStoredZipImages(bytes) {
    const entries = [];
    let offset = 0;
    while (bytes.readUInt32LE(offset) === 0x04034b50) {
        assert.equal(bytes.readUInt16LE(offset + 8), 0, 'original export uses uncompressed ZIP entries');
        const size = bytes.readUInt32LE(offset + 18);
        const nameLength = bytes.readUInt16LE(offset + 26);
        const extraLength = bytes.readUInt16LE(offset + 28);
        const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
        const beginning = offset + 30 + nameLength + extraLength;
        offset = beginning + size;
        entries.push({ name, data: bytes.subarray(beginning, offset).toString('base64') });
    }
    return entries;
}

test('详情图由模型直接生成带文案的成品，连续预览与 ZIP 保留原始图片', { timeout: 65000 }, async () => {
    const [product, firstImage, secondImage, revisedImage] = await Promise.all(['red', 'blue', 'yellow', 'green'].map(async color =>
        (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    const masterTypography = '全页统一用深绿粗体标题，左边距保持一致。';
    const page = {
        version: 2,
        theme: { background: '#f4eee3', foreground: '#24221c', accent: '#425336', surface: '#e9ded0' },
        guide: { typography: masterTypography, lighting: '整套采用右侧柔和窗光。' },
        sections: [
            { shotId: feature, layout: 'image-left', anchor: 'center-left', tone: 'surface', height: 'short', transition: 'flat', bottomEdge: '暖米色铺满下缘' },
            { shotId: overview, layout: 'hero', anchor: 'top-left', tone: 'base', height: 'medium', transition: 'curve', topEdge: '暖米色沿用上一屏' }
        ]
    };
    const initScript = `window.detailCalls=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url,options)=>{
            if(url!=='/proxy'||!options?.body)return actualFetch(url,options);
            if(options.body instanceof FormData){
                const prompt=options.body.get('prompt');
                detailCalls.push({kind:'image',prompt});
                const image=prompt.includes('顺手开盖')?${JSON.stringify(revisedImage)}
                    :prompt.includes('${overview}')?${JSON.stringify(firstImage)}:${JSON.stringify(secondImage)};
                return Response.json({data:[{b64_json:image}]});
            }
            const content=JSON.parse(options.body).messages.at(-1).content;
            const input=JSON.parse(Array.isArray(content)?content[0].text:content);
            const response=input.direction ? {detailPage:{ sections: input.detailPage.sections
                .filter(section=>section.shotId===input.targetShotId).map(section=>({...section,anchor:'top-right',layout:'hero'})) }}
                : {productInfo:{ name:'随行杯',sellingPoints:['单手开合'] }, artDirection:'暖色自然光', detailPage:${JSON.stringify(page)},
                    shots:input.shots.map(({id})=>({id,prompt:'展示真实商品结构 '+id,copy:'轻松随行\\n单手开合'}))};
            detailCalls.push({kind:'plan',input});
            return Response.json({choices:[{message:{content:JSON.stringify(response)}}]});
        };`;
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        nodes: [
            { id: 'product', type: 'ImageImport', x: 30, y: 130 },
            { id: nodeId, type: 'ECommerceImageSet', x: 400, y: 150, commerceImageSet: {
                platformId: 'taobao', selectedShotIds: [overview, feature], plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p' } }
        ],
        connections: [{ id: 'product-photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId, port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [
            { id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }
        ],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    };
    await withAppBrowser(fixture, async app => {
        const readSaved = `fetch('/api/storage/documents/session').then(response=>response.json())
            .then(snapshot=>snapshot.value.nodes.find(node=>node.id===${JSON.stringify(nodeId)}))`;
        const click = selector => app.evaluate(`${query(selector)}.click()`);
        const control = (target, value, event) => app.evaluate(`(()=>{const element=${query(target)};
            element.value=${JSON.stringify(value)};element.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
        const action = name => `[data-commerce-action=${name}]`;
        const card = `[data-commerce-shot-id=${overview}]`;
        const copyField = `${card} [data-commerce-shot-field=copy]`;
        const images = `${preview} [data-detail-preview-shot]`;
        const readImages = () => app.evaluate(`Promise.all([...document.querySelectorAll('${images}')].map(async image=>({
            shotId:image.dataset.detailPreviewShot,
            data:btoa(String.fromCharCode(...new Uint8Array(await (await fetch(image.src)).arrayBuffer())))
        })))`);
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${product}`);
        await openParameters(app, nodeId);
        await click(action('plan'));
        await app.waitFor(`!${query(action('preview-detail-page'))}.hidden`);

        await click(action('preview-detail-page'));
        assert.match(await app.evaluate(`${query(`${preview} [data-detail-preview-feedback]`)}.textContent`), /生成详情图后/);
        assert.equal(await app.evaluate(`Boolean(${query(`${preview} canvas, ${images}`)})`), false);
        await click(`${preview} .dialog-style-1-close`);
        await app.waitFor(`!${query(preview)} && !${query(action('generate'))}.hidden && !${query(action('generate'))}.disabled`);
        await click(`${card} .commerce-image-set-shot-toggle`);
        assert.equal(await app.evaluate(`${query(copyField)}.checkVisibility()`), true);
        await control(copyField, copy, 'input');
        await click(action('generate'));
        await app.waitFor(`${readSaved}.then(node=>node.commerceImageSet.results.length===2 && node.mediaAssetKeys?.length===2 &&
            node.commerceImageSet.results.every(row=>row.status==='completed' && row.detailAssetKind==='finished' && !row.detailOutputKey))`);
        const before = await app.evaluate(readSaved);
        assert.deepEqual(before.mediaAssetKeys, [feature, overview].map(id => before.commerceImageSet.results.find(row => row.shotId === id).assetKey));
        const prompts = await app.evaluate("detailCalls.filter(call=>call.kind==='image').map(call=>call.prompt)");
        assert.equal(prompts.length, 2);
        assert.ok(prompts.every(prompt => prompt.includes(masterTypography) && prompt.includes('单手开合')));
        assert.ok(prompts.find(prompt => prompt.includes(overview)).includes(copy));
        await click(action('preview-detail-page'));
        await app.waitFor(`document.querySelectorAll('${images}').length===2 && [...document.querySelectorAll('${images}')].every(img=>img.naturalWidth)`);
        assert.equal(await app.evaluate(`Boolean(${query(`${preview} canvas`)})`), false);
        assert.deepEqual(await readImages(), [{ shotId: feature, data: secondImage }, { shotId: overview, data: firstImage }]);
        assert.equal(await app.evaluate(`(()=>{const [first,second]=document.querySelectorAll('${images}');
            return Math.abs(first.getBoundingClientRect().bottom-second.getBoundingClientRect().top)<1;})()`), true);

        await click(`${preview} .dialog-style-1-close`);
        await app.waitFor(`!${query(preview)} && !${query(copyField)}.disabled`);
        await control(copyField, changedCopy, 'input');
        await click(action('preview-detail-page'));
        await app.waitFor(`${query(`${preview} [data-detail-preview-feedback]`)}.textContent.includes('上一版成图')`);
        assert.deepEqual(await readImages(), [{ shotId: feature, data: secondImage }, { shotId: overview, data: firstImage }]);
        await control(`${preview} [data-detail-section]`, overview, 'change');
        await control(`${preview} [data-detail-direction]`, '标题移到右上角', 'input');
        await click(`${preview} [data-detail-revise]`);
        await app.waitFor(`${query(`${preview} [data-detail-feedback]`)}.textContent.includes('重新生成相关图位')`);
        assert.equal(await app.evaluate("detailCalls.at(-1).input.targetShotId"), overview);
        assert.equal(await app.evaluate("detailCalls.filter(call=>call.kind==='image').length"), 2);
        assert.deepEqual(await readImages(), [{ shotId: feature, data: secondImage }, { shotId: overview, data: firstImage }]);
        await app.waitFor(`${readSaved}.then(node=>node.commerceImageSet.plan.detailPage.sections
            .some(section=>section.shotId==='${overview}' && section.anchor==='top-right'))`);
        const relayout = await app.evaluate(readSaved);
        assert.deepEqual(relayout.mediaAssetKeys, before.mediaAssetKeys);

        await click(`${preview} .dialog-style-1-close`);
        const retry = `${card} [data-commerce-action=retry]`;
        await app.waitFor(`!${query(preview)} && !${query(retry)}.disabled`);
        await click(retry);
        await app.waitFor(`${readSaved}.then(node=>node.mediaAssetKeys.length===2 && node.mediaAssetKeys[1]!==${JSON.stringify(before.mediaAssetKeys[1])})`);
        const updatedPrompt = await app.evaluate("detailCalls.filter(call=>call.kind==='image').at(-1).prompt");
        assert.ok(updatedPrompt.includes(changedCopy));
        assert.match(updatedPrompt, /文案位于右上/);

        await app.evaluate(`window.detailDownloads=[];window.__cainflowDesktop={saveFile:async (name,mime,blob)=>{
            detailDownloads.push({name,mime,bytes:[...new Uint8Array(await blob.arrayBuffer())]});return true;
        }};`);
        await click(action('export'));
        await click(`${exportDialog} [data-commerce-export-scope=detail]`);
        await app.waitFor(`!${query(`${exportDialog} [data-commerce-export-download]`)}.disabled`);
        await click(`${exportDialog} [data-commerce-export-download]`);
        await app.waitFor('detailDownloads.length===1');
        const download = await app.evaluate('detailDownloads[0]');
        assert.match(download.name, /_详情图\.zip$/);
        assert.equal(download.mime, 'application/zip');
        assert.deepEqual(readStoredZipImages(Buffer.from(download.bytes)), [
            { name: '01_核心卖点说明.png', data: secondImage }, { name: '02_详情首屏.png', data: revisedImage }
        ]);

        await click(`${exportDialog} [data-commerce-export-close]`);
        await reloadAppBrowser(app);
        await openParameters(app, nodeId);
        await click(action('preview-detail-page'));
        await app.waitFor(`document.querySelectorAll('${images}').length===2`);
        assert.deepEqual(await readImages(), [{ shotId: feature, data: secondImage }, { shotId: overview, data: revisedImage }]);
    }, { initScript });
});
