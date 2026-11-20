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
    const [product, wideSource, tallSource, revisedImage] = await Promise.all(['red', 'blue', 'yellow', 'green'].map(async color =>
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
                    :prompt.includes('${overview}')?window.detailFixtureImages[0]:window.detailFixtureImages[1];
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
        const [firstImage, secondImage] = await app.evaluate(`(async () => {
            const samples = ${JSON.stringify([[wideSource, 320, 180], [tallSource, 180, 320]])};
            window.detailFixtureImages = await Promise.all(samples.map(async ([data, width, height]) => {
                const image = new Image();
                image.src = 'data:image/png;base64,' + data;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(image, 0, 0, width, height);
                return canvas.toDataURL('image/png').split(',')[1];
            }));
            return window.detailFixtureImages;
        })()`);
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
        assert.deepEqual(await app.evaluate(`Array.from(document.querySelectorAll('[data-commerce-result-group]'), group => ({
            group: group.dataset.commerceResultGroup,
            title: group.querySelector('h4').checkVisibility(),
            add: group.querySelector('[data-commerce-action=add-scene]').textContent.trim()
        }))`), [{ group: 'detail', title: true, add: '添加场景图' }, { group: 'gallery', title: false, add: '添加主副图场景图' }]);

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
        const viewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
        for (const [width, height] of [[viewport.width, viewport.height], [390, 560]]) {
            await app.send('Emulation.setDeviceMetricsOverride', { ...viewport, width, height });
            await app.waitFor(`innerWidth===${width} && document.querySelectorAll('.commerce-image-set-shot-preview img:not([hidden])').length===2
                && Array.from(document.querySelectorAll('.commerce-image-set-shot-preview img:not([hidden])')).every(img=>img.naturalWidth>0)`);
            const thumbnails = await app.evaluate(`(() => {
                const scroll = document.querySelector('.image-parameter-scroll');
                return Array.from(document.querySelectorAll('.commerce-image-set-shot-preview'), button => {
                    const card = button.closest('[data-commerce-shot-id]');
                    const bounds = card.getBoundingClientRect();
                    const image = button.querySelector('img');
                    const title = card.querySelector('.commerce-image-set-shot-toggle').getBoundingClientRect();
                    const thumb = image.getBoundingClientRect();
                    const scale = Math.min(thumb.width / image.naturalWidth, thumb.height / image.naturalHeight);
                    const actionsFit = Array.from(card.querySelectorAll('.commerce-image-set-shot-quick-actions button'))
                        .filter(action => action.checkVisibility()).every(action => {
                            const rect = action.getBoundingClientRect();
                            return rect.left >= bounds.left && rect.right <= bounds.right;
                        });
                    return { id: card.dataset.commerceShotId, width: image.naturalWidth * scale,
                        height: image.naturalHeight * scale, fit: getComputedStyle(image).objectFit,
                        clearTitle: title.width > 40 && title.left >= button.getBoundingClientRect().right,
                        actionsFit, overflow: scroll.scrollWidth > scroll.clientWidth + 1 };
                });
            })()`);
            const landscape = thumbnails.find(item => item.id === overview);
            const portrait = thumbnails.find(item => item.id === feature);
            assert.ok(landscape.width >= (width === 390 ? 63 : 80) && landscape.height >= 35, JSON.stringify(thumbnails));
            assert.ok(portrait.height >= 70 && portrait.height <= 73, JSON.stringify(thumbnails));
            assert.ok(thumbnails.every(item => item.fit === 'contain' && item.clearTitle && item.actionsFit && !item.overflow), JSON.stringify(thumbnails));
        }
        await app.send('Emulation.setDeviceMetricsOverride', viewport);
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

        await app.evaluate(`(() => {
            window.detailDownloads = [];
            window.detailArchiveWorkers = [];
            window.Worker = class extends Worker {
                constructor(url, options) {
                    super(url, options);
                    if (!new URL(url, location.href).pathname.endsWith('/zip-archive-worker.js')) return;
                    this.archiveRecord = { mode: options.type, entries: [], producedArchive: false, terminated: false };
                    detailArchiveWorkers.push(this.archiveRecord);
                    this.addEventListener('message', ({ data }) => {
                        this.archiveRecord.producedArchive = data.archive instanceof Blob;
                    });
                }

                postMessage(entries, ...rest) {
                    if (this.archiveRecord) this.archiveRecord.entries = entries.map(entry => [entry.path, entry.blob instanceof Blob]);
                    return super.postMessage(entries, ...rest);
                }

                terminate() {
                    if (this.archiveRecord) this.archiveRecord.terminated = true;
                    super.terminate();
                }
            };
            window.__cainflowDesktop = { async saveFile(name, mime, blob) {
                detailDownloads.push({ name, mime, bytes: [...new Uint8Array(await blob.arrayBuffer())] });
                return true;
            } };
        })()`);
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
        assert.deepEqual(await app.evaluate('detailArchiveWorkers'), [{ mode: 'module',
            entries: [['01_核心卖点说明.png', true], ['02_详情首屏.png', true]], producedArchive: true, terminated: true }]);

        await click(`${exportDialog} [data-commerce-export-close]`);
        await reloadAppBrowser(app);
        await openParameters(app, nodeId);
        await click(action('preview-detail-page'));
        await app.waitFor(`document.querySelectorAll('${images}').length===2`);
        assert.deepEqual(await readImages(), [{ shotId: feature, data: secondImage }, { shotId: overview, data: revisedImage }]);
    }, { initScript });
});
