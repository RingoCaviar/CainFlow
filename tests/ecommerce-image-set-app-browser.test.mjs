import test from 'node:test';
import { runWorkflowShortcut } from './helpers/workflow-run-shortcut.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { withAppBrowser, reloadAppBrowser } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { key, nativeClick as clickVisibleControl, openParameters } from './helpers/image-first-integrated-fixture.mjs';
import { commerceImageSetSourceKey, normalizeCommerceImageSetPlan } from '../js/features/ecommerce-image-set/commerce-image-set-plan.js';

const commerceProductField = field => `#image-parameter-panel [data-commerce-product-field=${field}]`;
const commerceProductValue = field => `document.querySelector('${commerceProductField(field)}').value`;
async function nativeClick(app, selector, options) {
    await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
    return clickVisibleControl(app, selector, options);
}
const showsPreviousCommerceImage = selector => `(() => {
    const text = document.querySelector(${JSON.stringify(selector)})?.innerText || '';
    return text.includes('显示上一版') || text.includes('当前为上一版');
})()`;

async function assertCommerceTextTone(app, selector, token) {
    const { color, expected } = await app.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const color = getComputedStyle(element).color;
        const probe = document.createElement('span');
        probe.hidden = true;
        probe.style.color = ${JSON.stringify(`var(${token})`)};
        element.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return { color, expected };
    })()`);
    assert.equal(color, expected, `${selector} uses ${token}`);
}

const commerceRequestGates = `window.pendingCommerceRequests = Object.create(null);
    window.canceledCommerceRequests = [];
    function holdCommerceRequest(key, signal) {
        return new Promise((resolve, reject) => {
            const cancel = () => {
                delete pendingCommerceRequests[key];
                canceledCommerceRequests.push(key);
                reject(signal.reason);
            };
            if (signal?.aborted) { cancel(); return; }
            signal?.addEventListener('abort', cancel, { once: true });
            pendingCommerceRequests[key] = () => {
                delete pendingCommerceRequests[key];
                signal?.removeEventListener('abort', cancel);
                resolve();
            };
        });
    }`;

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

async function captureCommerceInspector(app, { name = 'product', width = 1120, height = 900, shotId, selector, surface = '#image-parameter-panel' } = {}) {
    const directory = process.env.CAINFLOW_QA_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const currentTheme = await app.evaluate('document.documentElement.dataset.appTheme');
    const viewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
    const anchor = selector || (shotId && `[data-commerce-shot-id=${shotId}]`);
    await app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    try {
        for (const theme of ['light', 'dark']) {
            await app.evaluate(`document.documentElement.dataset.appTheme='${theme}';
                ${anchor ? `document.querySelector(${JSON.stringify(anchor)}).scrollIntoView({block:'start'});`
                    : "document.querySelector('#image-parameter-panel .image-parameter-scroll').scrollTop=0;"}
                document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
            const clip = await app.evaluate(`(()=>{
                const {x,y,width,height}=document.querySelector(${JSON.stringify(surface)}).getBoundingClientRect();
                return {x,y,width,height,scale:1};
            })()`);
            const { data } = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
            await writeFile(join(directory, `ecommerce-${name}-${theme}.png`), Buffer.from(data, 'base64'));
        }
    } finally {
        await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(currentTheme)}`);
        await app.send('Emulation.setDeviceMetricsOverride', viewport);
    }
}

test('whole-workflow run reports an unplanned commerce set before sending an upstream image request', { timeout: 30000 }, async () => {
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        models: [{ id: 'image', modelId: 'gpt-image-2', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
        providers: [{ id: 'p', name: '测试供应商', endpoint: 'https://controlled.test/v1', apikey: 'fixture' }],
        nodes: [
            { id: 'source', type: 'ImageGenerate', x: 40, y: 160, apiConfigId: 'image', providerId: 'p', prompt: '上游商品图' },
            { id: 'commerce', type: 'ECommerceImageSet', x: 490, y: 160, customTitle: '尚未规划的套图' }
        ],
        connections: [{ id: 'product', from: { nodeId: 'source', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }]
    };
    const initScript = `window.commercePreflightRequests=0;
        const originalFetch=window.fetch.bind(window);
        window.fetch=(url, options)=>{
            if (url==='/proxy' && options?.body) {
                window.commercePreflightRequests++;
                return Promise.resolve(Response.json({error:{message:'Upstream request escaped preflight'}},{status:400}));
            }
            return originalFetch(url,options);
        };`;
    await withAppBrowser(fixture, async app => {
        await app.evaluate(runWorkflowShortcut);
        await app.waitFor("window.commercePreflightRequests || document.getElementById('toast-container').textContent.includes('尚未规划的套图')");
        assert.equal(await app.evaluate('window.commercePreflightRequests'), 0);
        assert.match(await app.evaluate("document.getElementById('toast-container').textContent"), /尚未规划的套图.*(?:生成方案|规划)/);
        await app.waitFor("document.getElementById('btn-stop').disabled");
    }, { initScript });
});

test('a confirmed original-only commerce set runs from canvas scope without a generation provider', { timeout: 30000 }, async () => {
    const reference = `data:image/png;base64,${(await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64')}`;
    const settings = { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['main'] };
    const normalizedPlan = normalizeCommerceImageSetPlan({ sellingPoints: [], shots: [{ id: 'main' }] },
        settings.platformId, settings.selectedShotIds, settings);
    const plan = { ...normalizedPlan, confirmed: true,
        sourceKey: await commerceImageSetSourceKey({ settings, references: [reference] }) };
    const fixture = {
        autoCheckUpdatesOnLoad: false, models: [], providers: [],
        nodes: [
            { id: 'product', type: 'ImageImport', x: 40, y: 160 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 490, y: 160, commerceImageSet: { ...settings, plan } }
        ],
        connections: [{ id: 'product-input', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }]
    };
    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', reference);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-action=fill]').hidden"), true);
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-action=generate]').textContent"), '生成套图');
        await app.evaluate("document.querySelector('.canvas-run-scope-trigger').click()");
        await app.waitFor("document.querySelector('#canvas-run-scope:popover-open [data-confirm-run-scope]:enabled')");
        await app.evaluate("document.querySelector('[data-confirm-run-scope]').click()");
        await app.waitFor(`fetch('/api/storage/documents/session').then(r=>r.json()).then(d=>d.value.nodes
            .some(node=>node.id==='commerce' && node.commerceImageSet.results?.[0]?.status==='completed'))`);
    });
});

test('canvas run scope shows commerce slot counts, changing upstream references, and keyboard recovery', { timeout: 30000 }, async () => {
    const settings = { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['main', 'detail'] };
    const nodes = [
        { id: 'scope-upstream', type: 'ImageGenerate', x: 40, y: 100, apiConfigId: 'image', providerId: 'p', prompt: '上游产品图' },
        { id: 'scope-commerce', type: 'ECommerceImageSet', x: 390, y: 100, customTitle: '杯具套图', commerceImageSet: settings },
        { id: 'scope-other', type: 'ECommerceImageSet', x: 750, y: 100, customTitle: '另一套图',
            commerceImageSet: { ...settings, selectedShotIds: ['main'] } }
    ];
    const connections = [{ id: 'scope-ref', from: { nodeId: 'scope-upstream', port: 'image' },
        to: { nodeId: 'scope-commerce', port: 'referenceImages' }, type: 'image', order: 0 }];
    const initScript = `window.scopeRequests=0;const actualFetch=window.fetch.bind(window);
        window.fetch=(url,options)=>{if(url==='/proxy'){window.scopeRequests++;return Promise.resolve(Response.json({error:{message:'unexpected request'}},{status:409}));}
        return actualFetch(url,options);};`;
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections,
        models: [{ id: 'image', modelId: 'gpt-image-1', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        const panel = '#canvas-run-scope';
        const trigger = '.canvas-run-scope-trigger';
        const row = `${panel} [data-commerce-run-node="scope-commerce"]`;
        const other = `${panel} [data-commerce-run-node="scope-other"]`;
        await openParameters(app, 'scope-commerce');
        await nativeClick(app, trigger);
        const rowText = selector => app.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
        assert.match(await rowText(row), /2 个图位 · 模型生成 1 张 · 复用原图 1 张/);
        assert.match(await rowText(row), /请先规划电商套图/);
        assert.doesNotMatch(await rowText(row), /本次也会运行上游节点/);
        assert.equal(await app.evaluate(`document.querySelector('${panel} [data-confirm-run-scope]').disabled`), true);
        await nativeClick(app, `${panel} label:has([value=target-node])`);
        assert.match(await rowText(row), /本次也会运行上游节点，商品参考图可能变化/);
        assert.match(await rowText(row), /参考图变化后需重新规划并确认套图/);

        await nativeClick(app, `${panel} label:has([value=all])`);
        assert.match(await rowText(other), /1 个图位 · 模型生成 0 张 · 复用原图 1 张/);
        await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 470, deviceScaleFactor: 1, mobile: false });
        await app.waitFor(`(()=>{const r=document.querySelector('${panel}').getBoundingClientRect();
            return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`);
        const compactScope = await app.evaluate(`(() => {
            const scope = document.querySelector('${panel}');
            const first = scope.querySelector('[data-commerce-run-settings="scope-commerce"]');
            const confirm = scope.querySelector('[data-confirm-run-scope]');
            const content = scope.querySelector('.canvas-run-scope-scroll');
            const visible = element => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
            };
            return { recovery: visible(first), paired: first.parentElement.textContent.includes('请先规划电商套图'),
                action: visible(confirm) && confirm.disabled, scrolls: content.scrollHeight > content.clientHeight };
        })()`);
        assert.deepEqual(compactScope, { recovery: true, paired: true, action: true, scrolls: true });
        await app.evaluate(`document.querySelector('${panel} input:checked').focus()`);
        await key(app, 'Tab');
        await key(app, 'Tab');
        assert.equal(await app.evaluate("document.activeElement.dataset.commerceRunSettings"), 'scope-other');
        await key(app, 'Enter');
        await app.waitFor("!document.querySelector('#canvas-run-scope:popover-open') && document.querySelector('#image-parameter-panel[data-node-id=scope-other]:not([hidden])')");
        assert.equal(await app.evaluate('scopeRequests'), 0, 'preview and its recovery entry never start a provider request');
    }, { initScript });
});

test('commerce footer fills only unfinished slots and keeps an explicit whole-set redo', { timeout: 30000 }, async () => {
    const image = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        notificationsEnabled: true,
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }],
        nodes: [{ id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100, commerceImageSet: {
                platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['main', 'angle', 'detail'], plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p'
            } }],
        connections: [{ id: 'product-reference', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }]
    };
    const initScript = `window.fillRequests=[];window.rejectDetail=true;
        window.partialNotifications=[];window.partialTaskbarStatuses=[];
        window.__cainflowDesktop={info:{platform:'darwin'},clearTaskbarStatus:()=>partialTaskbarStatuses.push('clear'),
            setTaskbarStatus:status=>partialTaskbarStatuses.push(status)};
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url==='/api/system-notification'&&options?.method==='POST') {
                partialNotifications.push(JSON.parse(options.body));return Response.json({success:true});
            }
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (!(options.body instanceof FormData)) {
                const plan={sellingPoints:['可见杯盖'],shots:['angle','detail'].map(id=>({
                    id,prompt:'套图测试图位 '+id+'\\n商品在画面右侧，近景构图与柔和光线。'
                }))};
                return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
            }
            const shot=options.body.get('prompt').match(/^画面设计：套图测试图位 ([a-z]+)$/m)?.[1];
            fillRequests.push(shot);
            if (window.rejectDetail&&shot==='detail') return Response.json({error:{message:'Fixture detail failure'}},{status:400});
            return Response.json({data:[{b64_json:${JSON.stringify(image)}}]});
        };`;
    const selector = action => `#image-parameter-panel [data-commerce-action=${action}]`;
    const button = action => `document.querySelector('${selector(action)}')`;
    const ready = action => `${button(action)}?.checkVisibility() && !${button(action)}.disabled`;
    const rows = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(session=>session.value.nodes.find(node=>node.id==='commerce').commerceImageSet.results)`;
    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${image}`);
        await openParameters(app, 'commerce');
        await app.evaluate(`${button('plan')}.click()`);
        await app.waitFor(ready('generate'));
        await app.waitFor("partialNotifications.some(notice=>notice.title==='CainFlow 套图方案已生成')");
        await app.evaluate('partialNotifications.length=0;partialTaskbarStatuses.length=0');
        assert.equal(await app.evaluate(`${button('generate')}.textContent`), '确认并生成套图');
        assert.equal(await app.evaluate(`${button('fill')}.hidden`), true);
        await nativeClick(app, selector('generate'));
        await app.waitFor(`${rows}.then(results=>results?.find(row=>row.shotId==='detail')?.status==='failed')`);
        await app.waitFor(ready('fill'));
        await app.waitFor("document.querySelector('#commerce > .node-card-run-status:not([hidden])')?.textContent==='部分完成 · 2/3'");
        const partialMessage = '套图部分完成 · 2/3 个图位，1 个待补齐。';
        await app.waitFor(`document.querySelector('#toast-container .toast.warning')?.textContent.includes(${JSON.stringify(partialMessage)})`);
        await app.waitFor("partialNotifications.some(notice=>notice.title==='CainFlow 套图部分完成')");
        assert.deepEqual(await app.evaluate('partialNotifications.map(({title,body})=>[title,body])'), [['CainFlow 套图部分完成', partialMessage]]);
        assert.deepEqual(await app.evaluate('partialTaskbarStatuses'), ['clear'], 'the taskbar does not report partial success as complete');
        assert.doesNotMatch(await app.evaluate("document.getElementById('toast-container').textContent"), /工作流运行完成/);
        const toastViewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 560, deviceScaleFactor: 1, mobile: false });
        const narrowToasts = await app.evaluate(`import('/js/app/bootstrap.js').then(async ({bootstrapCainFlowApp}) => {
            const { toastControllerApi } = (await bootstrapCainFlowApp()).registry;
            const older = Array.from({length:4}, (_, index) => toastControllerApi.showToast('待处理的说明 '.repeat(8) + index, 'warning'));
            const latest = toastControllerApi.showToast('最近一条通知保持完整可见。', 'warning');
            const container = document.getElementById('toast-container');
            const stack = container.getBoundingClientRect();
            const notice = latest.element.getBoundingClientRect();
            const footer = document.querySelector('${selector('fill')}').getBoundingClientRect();
            const header = document.querySelector('#image-parameter-panel .image-parameter-header').getBoundingClientRect();
            const measured = { compact: stack.width>=350 && stack.height<=140 && stack.top>=header.bottom && stack.bottom<footer.top,
                latestVisible: notice.top>=stack.top && notice.bottom<=stack.bottom && notice.width>300,
                reachesOlder: container.scrollHeight>container.clientHeight };
            older.forEach(toast=>toast.element.remove()); latest.element.remove();
            return measured;
        })`);
        assert.deepEqual(narrowToasts, { compact: true, latestVisible: true, reachesOlder: true });
        await app.send('Emulation.setDeviceMetricsOverride', toastViewport);
        await nativeClick(app, '#commerce > .node-card-run-status');
        await app.waitFor("document.activeElement.closest('[data-commerce-shot-id=detail]') && document.activeElement.dataset.commerceAction==='error-detail'");
        const prior = (await app.evaluate(rows)).filter(row => row.status === 'completed');
        assert.deepEqual(prior.map(row => row.shotId), ['main', 'angle']);
        assert.equal(await app.evaluate(`${button('fill')}.textContent`), '补齐 1 个图位');
        assert.equal(await app.evaluate(`${button('generate')}.textContent`), '重做已确认图位');
        assert.match(await app.evaluate("document.querySelector('[data-commerce-run-summary=generate]').textContent"), /预计调用生图模型 2 次.*沿用原图 1 张/);
        assert.match(await app.evaluate("document.querySelector('[data-commerce-run-summary=fill]').textContent"), /预计调用生图模型 1 次.*沿用原图 0 张/);
        await captureCommerceInspector(app, { name: 'fill-actions' });
        await app.evaluate('window.rejectDetail=false;fillRequests.length=0');
        await nativeClick(app, '.canvas-run-scope-trigger');
        const scope = '#canvas-run-scope';
        const recovery = `${scope} [data-commerce-run-settings="commerce"]`;
        assert.equal(await app.evaluate(`document.querySelector('${scope} [data-confirm-run-scope]').textContent`), '重做已确认图位');
        assert.equal(await app.evaluate(`document.querySelector(${JSON.stringify(recovery)}).textContent`), '去参数面板补齐 1 个图位');
        await nativeClick(app, recovery);
        await app.waitFor(`!document.querySelector('${scope}:popover-open') && document.activeElement === ${button('fill')}`);
        assert.deepEqual(await app.evaluate('fillRequests'), [], 'reviewing the range only focuses the action');
        const editPrompt = '#image-parameter-panel [data-commerce-shot-id=detail] [data-commerce-shot-field=prompt]';
        await app.evaluate(`(() => {
            const field = document.querySelector('${editPrompt}');
            field.value += '\\n在构图中保留杯盖。';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await app.evaluate(`${button('generate')}.textContent`), '确认方案并重做');
        assert.equal(await app.evaluate(`${button('fill')}.textContent`), '确认并补齐 1 个图位');
        assert.deepEqual(await app.evaluate('fillRequests'), [], 'editing a shot does not confirm or produce it');
        const viewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
        await app.send('Emulation.setDeviceMetricsOverride', { width: 620, height: 560, deviceScaleFactor: 1, mobile: false });
        await app.waitFor(`(() => {
            const dock = document.getElementById('image-parameter-panel').getBoundingClientRect();
            const buttons = [${button('plan')}, ${button('generate')}, ${button('fill')}];
            return innerWidth === 620 && buttons.every(button => {
                const box = button.getBoundingClientRect();
                return box.width > 0 && box.left >= dock.left && box.right <= dock.right && box.bottom <= innerHeight;
            });
        })()`);
        await app.send('Emulation.setDeviceMetricsOverride', viewport);
        await app.evaluate(`${button('fill')}.focus()`);
        await key(app, 'Enter');
        await app.waitFor(`${rows}.then(results=>results?.length===3 && results.every(row=>row.status==='completed'))`);
        await app.waitFor(`(${ready('generate')}) && ${button('fill')}.hidden`);
        const complete = await app.evaluate(rows);
        assert.deepEqual(complete.map(row => row.shotId), ['main', 'angle', 'detail']);
        assert.deepEqual(complete.slice(0, 2), prior);
        assert.deepEqual(await app.evaluate('fillRequests'), ['detail']);
        assert.equal(await app.evaluate(`${button('generate')}.textContent`), '重做已确认图位');
    }, { initScript });
});

test('commerce setup provides direct recovery for missing references and an empty model configuration', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const fixture = { autoCheckUpdatesOnLoad: false, nodes: [
        { id: 'product', type: 'ImageImport', x: 40, y: 100, customTitle: '待导入商品' },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100 }
    ] };
    const panel = '#image-parameter-panel';
    const recovery = `${panel} [data-commerce-action=resolve-blocker]`;
    const status = `document.querySelector('${panel} .commerce-image-set-status').textContent`;
    const label = `document.querySelector('${recovery}')?.textContent`;
    await withAppBrowser(fixture, async app => {
        await app.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 720, deviceScaleFactor: 1, mobile: false });
        await openParameters(app, 'commerce');
        assert.match(await app.evaluate(status), /请连接 1 至 5 张/);
        assert.equal(await app.evaluate(label), '连接参考图');
        await nativeClick(app, recovery);
        await app.waitFor("document.querySelector('.canvas-connection-choice [role=menuitem]')?.textContent.includes('待导入商品')");
        await key(app, 'Enter');
        await app.waitFor(`${label}==='定位参考图来源'`);
        assert.match(await app.evaluate(status), /已连接参考图来源，请先运行上游或导入图片/);
        await nativeClick(app, recovery);
        await app.waitFor("document.querySelector('#image-parameter-panel[data-node-id=product]:not([hidden])')");
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        await app.waitFor(`${label}==='配置规划模型'`);
        assert.match(await app.evaluate(status), /规划模型/);
        await nativeClick(app, recovery);
        await app.waitFor("document.activeElement.id==='btn-add-provider'");
        await key(app, 'Escape');
        await app.waitFor(`document.activeElement===document.querySelector('${recovery}')`);
        await captureCommerceInspector(app, { name: 'configure-model', width: 1120, height: 720 });
    });
});

test('the commerce node generates selected shots, accepts a retry during generation and restores the set', { timeout: 45000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const workflowId = 'commerce-fixture';
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', plannerModelId: 'vision', plannerProviderId: 'p',
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
                if(shotId==='detail'&&window.holdCommerceRetry) {
                    await new Promise(resolve => { window.releaseCommerceRetry = resolve; });
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
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] },
            { id: 'no-reference', modelId: 'dall-e-3', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
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
        await assertCommerceTextTone(app, '#image-parameter-panel label:has(input[data-commerce-select-shot=feature]:checked:enabled)', '--text-link');
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

        const desktopViewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:1,mobile:false})');
        await app.send('Emulation.setDeviceMetricsOverride', { ...desktopViewport, width: 1024, height: 700 });
        await app.evaluate("document.querySelector('.commerce-image-set-setup').open=false");
        const choose = '#image-parameter-panel [data-commerce-action=choose-shots]';
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-selection-recovery] p').textContent"), '请至少勾选一个图位。');
        const recoveryAction = await actionPlacement(app, 'choose-shots');
        assert.ok(recoveryAction.inDockFooter && recoveryAction.visible && recoveryAction.reachable, JSON.stringify(recoveryAction));
        await captureCommerceInspector(app, { name: 'choose-shots', width: 1024, height: 700 });
        await app.evaluate(`document.querySelector('${choose}').focus()`);
        await key(app, 'Enter');
        await app.waitFor(`(() => {
            const first = document.querySelector('${shotChoices}');
            const label = first.closest('label').getBoundingClientRect();
            const scroll = ${scrollBody}.getBoundingClientRect();
            return document.activeElement === first && document.querySelector('.commerce-image-set-setup').open
                && label.top >= scroll.top - 1 && label.bottom <= scroll.bottom + 1;
        })()`);
        await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...space, text: ' ' });
        await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
        assert.deepEqual(await app.evaluate(selected), ['main']);
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-selection-recovery]').hidden"), true);
        await app.send('Emulation.setDeviceMetricsOverride', desktopViewport);
        await app.evaluate(`${select('detail')}; ${planButton}.focus()`);
        await key(app, 'Enter');
        await app.waitFor(generationAvailable);
        await app.waitFor(`(() => {
            const target = document.querySelector('${shotToggle('detail')}');
            const row = target.getBoundingClientRect();
            const scroll = ${scrollBody}.getBoundingClientRect();
            return document.activeElement === target && row.top >= scroll.top - 1 && row.bottom <= scroll.bottom + 1;
        })()`);
        await app.waitFor("document.getElementById('toast-container').textContent.includes('方案已生成，请检查图位。')");
        assert.doesNotMatch(await app.evaluate("document.getElementById('toast-container').textContent"), /工作流运行完成/);
        assert.equal(await app.evaluate("getComputedStyle(document.getElementById('commerce-time')).fontSize"), '12px');
        await assertCommerceTextTone(app, '#commerce-time', '--text-success');
        assert.deepEqual(await app.evaluate('commerceCalls.map(call=>call.kind)'), ['plan']);
        assert.equal(await app.evaluate('commerceCalls[0].image'), `data:image/png;base64,${reference}`);
        assert.deepEqual(await app.evaluate('commerceCalls[0].shotIds'), ['detail']);
        assert.equal(await app.evaluate('commerceCalls[0].input.productInfo.details'), '商品含一个杯盖');
        assert.equal(await app.evaluate(commerceProductValue('name')), '带盖随行杯');
        assert.equal(await app.evaluate(commerceProductValue('sellingPoints')), '可见杯盖');
        assert.equal(await app.evaluate(commerceProductValue('audience')), '通勤人群');
        assert.equal(await app.evaluate(commerceProductValue('details')), '商品含一个杯盖');
        const instructions = await app.evaluate('commerceCalls[0].instructions');
        for (const requirement of [/展示目标/, /构图/, /视觉表达/, /文字布局/, /层级/, /字体/, /字色/]) {
            assert.match(instructions, requirement);
        }
        assert.deepEqual(await app.evaluate(planned), ['main', 'detail']);

        const setup = '#image-parameter-panel .commerce-image-set-setup';
        assert.equal(await app.evaluate(`document.querySelector('${setup}').open`), false);
        const modelSettings = '#image-parameter-panel .commerce-image-set-settings > details.node-model-settings';
        const modelHeading = `document.querySelector('${modelSettings} > summary')`;
        assert.equal(await app.evaluate(`${modelHeading}?.checkVisibility() && ${modelHeading}.textContent.trim()`), '模型与供应商');
        await app.evaluate(`${modelHeading}.scrollIntoView({block:'nearest'})`);
        await nativeClick(app, `${modelSettings} > summary`);
        assert.deepEqual(await app.evaluate(`Array.from(document.querySelectorAll('${modelSettings} select'),
            select => [select.dataset.commerceField, select.checkVisibility()])`), [
            ['plannerModelId', true], ['plannerProviderId', true], ['imageModelId', true], ['imageProviderId', true]
        ], 'both model and provider pairs remain directly available after planning');
        const imageModel = "document.querySelector('[data-commerce-field=imageModelId]')";
        await app.evaluate(`${imageModel}.value='no-reference'; ${imageModel}.dispatchEvent(new Event('change',{bubbles:true}));`);
        assert.equal(await app.evaluate(`${generateButton}.disabled`), true);
        assert.match(await app.evaluate("document.querySelector('.commerce-image-set-status').textContent"), /不支持.*参考图/);
        await app.evaluate(`${generateButton}.click()`);
        assert.deepEqual(await app.evaluate('commerceCalls.map(call=>call.kind)'), ['plan']);
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.imageModelId==='no-reference')`);
        assert.equal((await app.evaluate(saved)).commerceImageSet.plan.confirmed, false);
        await app.evaluate(`${imageModel}.value='image'; ${imageModel}.dispatchEvent(new Event('change',{bubbles:true}));`);
        await app.waitFor(generationAvailable);
        assert.equal(await app.evaluate(`document.querySelector('${setup}').open`), false);
        await nativeClick(app, `${modelSettings} > summary`);
        await app.evaluate(`document.querySelector('${setup} > summary').scrollIntoView({block:'nearest'})`);
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
        await captureCommerceInspector(app, { name: 'batch', shotId: 'feature' });
        assert.equal(await app.evaluate("document.getElementById('modal-error').checkVisibility()"), false);
        assert.equal(await app.evaluate("document.querySelector('[data-commerce-shot-id=detail-overview] img').hidden"), true);
        const running = await app.evaluate(`(()=>{
            const panel=document.getElementById('image-parameter-panel');
            const status=panel.querySelector('.commerce-image-set-status');
            const progress=panel.querySelector('.commerce-image-set-progress');
            const fields=id=>[...panel.querySelectorAll('[data-commerce-shot-id='+id+'] [data-commerce-shot-field]')];
            return {message:status.textContent.trim(), statusVisible:status.checkVisibility(), runningLocked:fields('detail-overview').every(field=>field.disabled),
                idleEditable:fields('feature').every(field=>!field.disabled), progressVisible:progress.checkVisibility(),
                shotStatus:panel.querySelector('[data-commerce-shot-id=detail-overview] .commerce-image-set-shot-status').textContent.trim()};
        })()`);
        assert.match(running.message, /正在生成/);
        assert.match(running.shotStatus, /正在生成/);
        assert.ok(running.statusVisible && running.runningLocked && running.idleEditable && running.progressVisible, JSON.stringify(running));
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
        assert.equal(await app.evaluate(`document.querySelector('${replanIcon('detail')}').disabled`), false,
            'an idle shot can also be replanned while another shot is generating');
        await app.evaluate(`window.holdCommerceRetry=true;document.querySelector('${retryFailedShot}').scrollIntoView({block:'nearest'})`);
        await nativeClick(app, retryFailedShot);
        await app.waitFor(`typeof window.releaseCommerceRetry==='function' &&
            document.querySelector('${shotCard('detail')}').dataset.resultStatus==='running'`);
        assert.equal(await app.evaluate(`document.querySelector('${retryFailedShot}').disabled`), true);
        assert.equal(await app.evaluate(`document.querySelector('${shotCard('detail-overview')}').dataset.resultStatus`), 'running',
            'retry reaches the image provider while another shot is still generating');
        await app.evaluate('window.releaseCommerceDetail()');
        await app.waitFor(`document.querySelector('${shotCard('detail-overview')}').dataset.resultStatus==='completed'`);
        await app.evaluate('window.holdCommerceRetry=false;window.releaseCommerceRetry()');
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
        await app.evaluate(`window.releaseCommerceDetail=null;${runWorkflowShortcut}`);
        await app.waitFor(`typeof window.releaseCommerceDetail==='function' && !document.getElementById('btn-stop').disabled &&
            document.querySelector('${shotCard('detail-overview')}').dataset.resultStatus==='running'`);
        await app.evaluate("document.getElementById('btn-stop').click();window.releaseCommerceDetail()");
        await app.waitFor(`document.getElementById('btn-stop').disabled && !document.querySelector('${retryIcon('feature')}').disabled &&
            document.querySelector('${shotCard('feature')}').dataset.resultStatus==='completed'`);
        assert.deepEqual(await app.evaluate(`commerceCalls.slice(${beforeToolbarRun}).map(call=>call.shotId)`),
            ['detail', 'feature', 'detail-overview']);

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
        const shotActions = await app.evaluate(`(()=>{
            const image=document.querySelector('${regenerate}'),plan=document.querySelector('${replan}');
            return [plan, image].map(button => [button.textContent.trim(), button.getAttribute('aria-label')]);
        })()`);
        assert.deepEqual(shotActions, [['重写方案', '重写方案「详情首屏」'], ['重新生图', '重新生图「详情首屏」']]);
        await app.send('Emulation.setDeviceMetricsOverride', { ...viewport, width: 390, height: 640 });
        await app.waitFor(`(() => {
            const row = document.querySelector('${shotCard('detail-overview')}').getBoundingClientRect();
            const [plan, image] = ['${replan}', '${regenerate}'].map(selector => document.querySelector(selector).getBoundingClientRect());
            return innerWidth === 390 && [plan, image].every(button => button.width > 0 && button.left >= row.left && button.right <= row.right)
                && (plan.right <= image.left || plan.bottom <= image.top);
        })()`);
        await app.send('Emulation.setDeviceMetricsOverride', viewport);
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
        assert.equal(await app.evaluate(showsPreviousCommerceImage(shotCard('detail-overview'))), true,
            'a new plan marks the retained image as the previous version');
        assert.equal(await app.evaluate(showsPreviousCommerceImage(shotCard('feature'))), false,
            'replanning has no effect on another completed shot');
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
        assert.equal(await app.evaluate(showsPreviousCommerceImage(shotCard('detail-overview'))), false,
            'successful generation with the updated plan clears the version notice');
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
        await app.waitFor("document.getElementById('image-parameter-panel').hidden");
        const resizeTarget = `(()=>{const node=document.getElementById('commerce');
            const handle=node.querySelector('.node-resize-handle--bottom-right'), rect=handle.getBoundingClientRect();
            const x=rect.x+rect.width/2, y=rect.y+rect.height/2;
            const hit=document.elementFromPoint(x,y);
            return {x,y,width:node.offsetWidth,viewportHeight:innerHeight,reachable:handle.contains(hit),
                hit:hit?.id||hit?.getAttribute('class')||hit?.tagName};})()`;
        let resize;
        try {
            await app.waitFor(async () => {
                resize = await app.evaluate(resizeTarget);
                return resize.reachable;
            });
        } catch (error) {
            throw new Error(`The portrait resize handle did not become reachable: ${JSON.stringify(resize)}`, { cause: error });
        }
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

test('the commerce dock resizes from its left edge and restores its width independently', { timeout: 30000 }, async () => {
    const nodes = [
        { id: 'commerce', type: 'ECommerceImageSet', x: 200, y: 100 },
        { id: 'retouch', type: 'ProductRetouch', x: 40, y: 100 }
    ];
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes, connections: [] }, async app => {
        const panel = "document.getElementById('image-parameter-panel')";
        const grip = `${panel}.querySelector('[data-parameter-resize=width]')`;
        const width = `Math.round(${panel}.getBoundingClientRect().width)`;
        const resizeViewport = pixels => app.send('Emulation.setDeviceMetricsOverride', {
            width: pixels, height: 820, deviceScaleFactor: 1, mobile: false
        });
        const drag = async (delta, expectedWidth) => {
            const origin = await app.evaluate(`(() => {
                const grip = ${grip};
                const rect = grip.getBoundingClientRect();
                const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
                return { x, y, reachable: grip.contains(document.elementFromPoint(x, y)),
                    leftEdge: Math.abs(rect.left - ${panel}.getBoundingClientRect().left) <= 2 };
            })()`);
            assert.ok(origin.reachable && origin.leftEdge, 'the dock exposes a real pointer target on its left edge');
            const { x, y } = origin;
            await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
            await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + delta, y, button: 'left', buttons: 1 });
            await app.waitFor(`${width} === ${expectedWidth}`);
            await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + delta, y, button: 'left', buttons: 0, clickCount: 1 });
        };

        await resizeViewport(1100);
        await openParameters(app, 'retouch');
        const retouchWidth = await app.evaluate(width);
        await openParameters(app, 'commerce');
        const initial = await app.evaluate(width);
        assert.equal(await app.evaluate(`${grip}.checkVisibility() && ${grip}.tabIndex === 0`), true,
            'the commerce dock has a visible, keyboard-focusable width grip');
        await drag(-100, initial + 100);
        await drag(30, initial + 70);
        await app.evaluate(`${grip}.focus()`);
        await key(app, 'ArrowRight');
        const savedWidth = initial + 60;
        await app.waitFor(`${width} === ${savedWidth}`);
        assert.equal(await app.evaluate(`Number(${grip}.getAttribute('aria-valuenow'))`), savedWidth);

        await resizeViewport(850);
        const toggleAgent = () => app.evaluate("document.getElementById('btn-prompt-agent').click()");
        const agent = "document.getElementById('prompt-agent-panel')";
        await toggleAgent();
        await app.waitFor(`${agent}.classList.contains('active') && ${width} < ${savedWidth}`);
        assert.ok(await app.evaluate(`(() => {
            const beside = ${agent}.getBoundingClientRect();
            return beside.width >= 320 && beside.right <= ${panel}.getBoundingClientRect().left;
        })()`), 'the dock leaves space for Agent beside it');
        await toggleAgent();
        await app.waitFor(`${width} === ${savedWidth}`);

        await resizeViewport(620);
        await app.waitFor(`innerWidth === 620 && ${width} < ${savedWidth}`);
        assert.ok(await app.evaluate(`(() => {
            const dock = ${panel}.getBoundingClientRect();
            const canvas = document.getElementById('canvas-container').getBoundingClientRect();
            const action = ${panel}.querySelector('[data-commerce-action=plan]').getBoundingClientRect();
            return canvas.width >= 72 && Math.abs(canvas.right - dock.left) < 1 && Math.abs(dock.right - innerWidth) < 1
                && action.left >= dock.left && action.right <= dock.right && action.bottom <= innerHeight;
        })()`), 'a narrower viewport keeps the canvas and dock actions reachable');
        await resizeViewport(1100);
        await app.waitFor(`${width} === ${savedWidth}`);
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(width), retouchWidth, 'commerce resizing does not change the retouch preference');

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(width), savedWidth, 'reloading restores the last manually selected commerce width');

        await app.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
        await toggleAgent();
        await app.waitFor(`${agent}.classList.contains('active')`);
        await app.evaluate(`${grip}.focus()`);
        await key(app, 'Home');
        await app.waitFor(`${width} === 300`);
        const measureNavigation = () => app.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
            const agent = ${agent}.getBoundingClientRect();
            const navigation = document.getElementById('canvas-navigation').getBoundingClientRect();
            const attachment = document.getElementById('prompt-agent-add-reference');
            const input = document.getElementById('prompt-agent-input');
            const reachable = element => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
            };
            resolve({ beside: navigation.right + 8 <= agent.left, composerAtBottom: agent.bottom === innerHeight,
                gap: navigation.top - agent.bottom, attachment: reachable(attachment), input: reachable(input) });
        })))`);
        const beside = await measureNavigation();
        assert.ok(beside.beside && beside.composerAtBottom, JSON.stringify(beside));
        await key(app, 'End');
        const raised = await measureNavigation();
        assert.ok(!raised.beside && raised.gap >= 8 && raised.gap < 9 && raised.attachment && raised.input, JSON.stringify(raised));
        await key(app, 'Home');
        assert.deepEqual(await measureNavigation(), beside, 'shrinking the dock restores the composer to the bottom');
    });
});

test('deselecting a planned commerce shot keeps the remaining drafts ready after reload', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['main', 'detail', 'scene'],
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
    ];
    const initScript = `window.commerceSelectionRequests=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (options.body instanceof FormData) {
                commerceSelectionRequests.push({kind:'image',prompt:options.body.get('prompt')});
                return Response.json({data:[{b64_json:${JSON.stringify(reference)}}]});
            }
            const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content[0].text);
            commerceSelectionRequests.push({kind:'plan'});
            return Response.json({choices:[{message:{content:JSON.stringify({sellingPoints:[],
                shots:input.shots.map(shot=>({id:shot.id,prompt:'保留'+shot.id+'的商品构图',headline:'原有标题',body:''}))})}}]});
        };`;
    const plan = "document.querySelector('#image-parameter-panel [data-commerce-action=plan]')";
    const generate = "document.querySelector('#image-parameter-panel [data-commerce-action=generate]')";
    const ready = `${generate}?.checkVisibility() && !${generate}.disabled`;
    const stored = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(snapshot=>snapshot.value.nodes.find(node=>node.id==='commerce').commerceImageSet)`;
    await withAppBrowser({ autoCheckUpdatesOnLoad: false, nodes,
        connections: [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    }, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        await app.evaluate(`${plan}.click()`);
        await app.waitFor(ready);
        await app.waitFor(`${stored}.then(settings=>settings.plan?.shots.length===3)`);
        const previous = await app.evaluate(`${stored}.then(settings=>settings.plan.shots.filter(shot=>shot.id!=='scene'))`);
        await app.evaluate(`(()=>{const box=document.querySelector('#image-parameter-panel [data-commerce-select-shot=scene]');
            box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        assert.ok(await app.evaluate(ready), 'reducing a planned set leaves the generate action available');
        await app.waitFor(`${stored}.then(settings=>settings.plan?.shots.length===2)`);
        assert.deepEqual(await app.evaluate(`${stored}.then(settings=>settings.plan.shots)`), previous);
        assert.equal(await app.evaluate("commerceSelectionRequests.filter(request=>request.kind==='plan').length"), 1);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        await app.waitFor(ready);
        assert.equal(await app.evaluate("document.querySelector('#image-parameter-panel [data-commerce-select-shot=scene]').checked"), false);
        await app.evaluate(`${generate}.click()`);
        await app.waitFor(`${stored}.then(settings=>settings.results.filter(result=>result.status==='completed').length===2)`);
        const requests = await app.evaluate('commerceSelectionRequests');
        assert.deepEqual(requests.map(request=>request.kind), ['image']);
        assert.match(requests[0].prompt, /保留detail的商品构图/);
        assert.doesNotMatch(requests[0].prompt, /保留scene的商品构图/);
    }, { initScript });
});

test('commerce copy language persists and reaches planning, generation and retry', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['detail'], productInfo: { name: '带盖随行杯' },
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
            commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', plannerModelId: 'vision', plannerProviderId: 'p',
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
        await captureCommerceInspector(app);
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
    const replacement = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const nodes = [
        { id: 'product', type: 'ImageImport', x: 40, y: 100 },
        { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
            commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['detail'],
                plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
    ];
    const connections = [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
        to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }];
    const failure = 'Fixture commerce generation failure';
    const initScript = `${commerceRequestGates}
        window.commerceImageFailure=true;
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (options.body instanceof FormData) {
                if (window.commerceImageFailure) return Response.json({error:{message:${JSON.stringify(failure)}}},{status:500});
                if (window.deferCommerceUpdate) await holdCommerceRequest('image:detail', options.signal);
                const image = window.useReplacement ? ${JSON.stringify(replacement)} : ${JSON.stringify(reference)};
                return Response.json({data:[{b64_json:image}]});
            }
            const plan={sellingPoints:[],shots:[{id:'detail',prompt:'近景展示杯盖，使用柔和侧光。',headline:'',body:''}]};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const rowSelector = '#image-parameter-panel [data-commerce-shot-id=detail]';
    const shotStatus = `${rowSelector} .commerce-image-set-shot-status`;
    const row = `document.querySelector('${rowSelector}')`;
    const showsPrevious = showsPreviousCommerceImage(rowSelector);
    const thumbnailSrc = `${row}.querySelector('img').src`;
    const newPrompt = '俯拍展示杯盖和倒角。';
    const saved = `fetch('/api/storage/documents/session').then(r=>r.json())
        .then(d=>d.value.nodes.find(node=>node.id==='commerce')?.commerceImageSet)`;
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
        await app.waitFor(`${row}.dataset.resultStatus==='completed' && !${retry}.disabled &&
            ${thumbnailSrc}.startsWith(location.origin+'/api/storage/assets/') && ${row}.querySelector('img').naturalWidth>0`);
        assert.equal(await app.evaluate(showsPrevious), false);
        await assertCommerceTextTone(app, shotStatus, '--text-success');
        const original = await app.evaluate(thumbnailSrc);
        await app.evaluate(`(() => {
            const card = ${row};
            const toggle = card.querySelector('.commerce-image-set-shot-toggle');
            toggle.click();
            const prompt = card.querySelector('[data-commerce-shot-field=prompt]');
            prompt.value = ${JSON.stringify(newPrompt)};
            prompt.dispatchEvent(new Event('input', {bubbles:true}));
            toggle.click();
        })()`);
        await captureCommerceInspector(app, { name: 'previous-version', shotId: 'detail' });
        await captureCommerceInspector(app, { name: 'previous-version-narrow', width: 390, shotId: 'detail' });
        assert.equal(await app.evaluate(showsPrevious), true, 'editing a prompt marks its existing image as the previous version');
        assert.equal(await app.evaluate(`document.querySelector('${shotStatus}').textContent`), '待更新 · 显示上一版');
        assert.equal(await app.evaluate(`${row}.querySelector('.commerce-image-set-version-note').hidden`), true);
        assert.equal(await app.evaluate(`${row}.querySelector('[data-commerce-action=preview]').getAttribute('aria-describedby')`),
            await app.evaluate(`document.querySelector('${shotStatus}').id`));
        await assertCommerceTextTone(app, shotStatus, '--text-warning');
        assert.equal(await app.evaluate(thumbnailSrc), original);
        await app.evaluate(`window.commerceImageFailure=true; ${retry}.click()`);
        await app.waitFor(`!${retry}.disabled && ${row}.innerText.includes(${JSON.stringify(failure)})`);
        assert.equal(await app.evaluate(`${modal}.classList.contains('active')`), false, 'a failed regeneration also keeps the error dialog closed');
        assert.equal(await app.evaluate(thumbnailSrc), original, 'a failed regeneration preserves the previous image');
        assert.equal(await app.evaluate(showsPrevious), true, 'failure preserves the version notice');

        await app.evaluate(`window.commerceImageFailure=false; window.deferCommerceUpdate=true; ${retry}.click()`);
        await app.waitFor("typeof pendingCommerceRequests['image:detail']==='function'");
        assert.equal(await app.evaluate(showsPrevious), true, 'the notice remains while the previous image is visible during generation');
        await app.evaluate(`${row}.querySelector('[data-commerce-action=cancel-shot]').click()`);
        await app.waitFor(`${row}.dataset.resultStatus==='canceled' && !${retry}.disabled`);
        assert.equal(await app.evaluate(showsPrevious), true, 'cancellation preserves the version notice');
        assert.equal(await app.evaluate(thumbnailSrc), original, 'cancellation preserves the previous image');
        await app.waitFor(`${saved}.then(state=>state?.plan?.shots[0].prompt===${JSON.stringify(newPrompt)})`);

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        await app.waitFor(`${row}?.querySelector('img')?.naturalWidth>0 && !${retry}.disabled`);
        assert.equal(await app.evaluate(showsPrevious), true, 'the version notice survives a reload');
        assert.equal(await app.evaluate(thumbnailSrc), original);
        await app.evaluate(`window.commerceImageFailure=false; window.useReplacement=true; ${retry}.click()`);
        await app.waitFor(`${row}.dataset.resultStatus==='completed' && !${retry}.disabled && ${thumbnailSrc}!==${JSON.stringify(original)}`);
        assert.equal(await app.evaluate(showsPrevious), false, 'replacing the image with the current plan clears the notice');
    }, { initScript });
});

test('commerce shots run independently and can be canceled individually or from the dock footer', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const fixtures = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        nodes: [
            { id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
                commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['detail', 'feature', 'detail-overview'],
                    plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
        ],
        connections: [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    };
    const initScript = `${commerceRequestGates}
        window.commerceImagePrompts = Object.create(null);
        const actualFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (url!=='/proxy'||!options?.body) return actualFetch(url, options);
            if (options.body instanceof FormData) {
                const prompt = options.body.get('prompt');
                const id = prompt.match(/原商品图位 ([\\w-]+)$/m)?.[1];
                commerceImagePrompts[id] = prompt;
                await holdCommerceRequest('image:'+id, options.signal);
                return Response.json({data:[{b64_json:${JSON.stringify(reference)}}]});
            }
            const body = JSON.parse(options.body);
            const ids = JSON.parse(body.messages.at(-1).content[0].text).shots.map(shot=>shot.id);
            const revision = ids.length===1;
            if (revision) await holdCommerceRequest('plan:'+ids[0], options.signal);
            const plan = {sellingPoints:[],shots:ids.map(id=>({id,prompt:'原商品图位 '+id+'\\n使用柔和侧光表现杯盖。',
                headline:revision?'更新的功能亮点':'产品卖点',body:''}))};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const panel = '#image-parameter-panel';
    const row = id => `${panel} [data-commerce-shot-id=${id}]`;
    const action = (name, id) => `${id ? row(id) : panel} [data-commerce-action=${name}]`;
    const button = (name, id) => `document.querySelector('${action(name, id)}')`;
    const available = (name, id) => `${button(name, id)}?.checkVisibility() && !${button(name, id)}.disabled
        && ${button(name, id)}.getAttribute('aria-disabled')!=='true'`;
    const status = id => `document.querySelector('${row(id)}').dataset.resultStatus`;
    const pending = id => `typeof pendingCommerceRequests['${id}']==='function'`;
    const click = async (app, name, id) => {
        assert.ok(await app.evaluate(available(name, id)), `${name} is available${id ? ` for ${id}` : ''}`);
        await app.evaluate(`${button(name, id)}.scrollIntoView({block:'nearest'})`);
        await nativeClick(app, action(name, id));
    };
    const featurePreview = `document.querySelector('${row('feature')} img')`;
    const saved = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(document=>document.value.nodes.find(node=>node.id==='commerce').commerceImageSet)`;

    await withAppBrowser(fixtures, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        await click(app, 'plan');
        await app.waitFor(available('retry', 'feature'));
        await click(app, 'retry', 'feature');
        await app.waitFor(pending('image:feature'));
        await app.evaluate("pendingCommerceRequests['image:feature']()");
        await app.waitFor(`${status('feature')}==='completed' && ${featurePreview}.naturalWidth>0`);
        const original = await app.evaluate(`${featurePreview}.src`);

        await click(app, 'retry', 'detail');
        await app.waitFor(`${pending('image:detail')} && ${status('detail')}==='running'`);
        await assertCommerceTextTone(app, `${row('detail')} .commerce-image-set-shot-status`, '--text-link');
        await click(app, 'replan-shot', 'feature');
        await app.waitFor(`${pending('plan:feature')} && ${status('feature')}==='planning'`);
        assert.equal(await app.evaluate(available('retry', 'feature')), false, 'one shot cannot start two tasks');
        const overviewHeadline = '随行杯与可拆杯盖';
        await app.evaluate(`(() => {
            const card=document.querySelector('${row('detail-overview')}');
            const toggle=card.querySelector('.commerce-image-set-shot-toggle');
            toggle.click();
            const field=card.querySelector('[data-commerce-shot-field=headline]');
            field.value=${JSON.stringify(overviewHeadline)};
            field.dispatchEvent(new Event('input', {bubbles:true}));
            toggle.click();
        })()`);
        await click(app, 'retry', 'detail-overview');
        await app.waitFor(`${pending('image:detail-overview')} && ${status('detail-overview')}==='running'`);
        assert.match(await app.evaluate("commerceImagePrompts['detail-overview']"), /随行杯与可拆杯盖/);
        assert.equal(await app.evaluate(`${featurePreview}.src`), original);
        await captureCommerceInspector(app, { name: 'running', shotId: 'detail' });
        await captureCommerceInspector(app, { name: 'running-narrow', width: 390, shotId: 'detail' });

        const cancelDetail = button('cancel-shot', 'detail');
        assert.ok(await app.evaluate(available('cancel-shot', 'detail')));
        assert.match(await app.evaluate(`${cancelDetail}.getAttribute('aria-label')`), /商品特写/);
        await app.evaluate(`${cancelDetail}.focus()`);
        await key(app, 'Enter');
        await app.waitFor(`${status('detail')}==='canceled' && ${available('retry', 'detail')}`);
        assert.equal(await app.evaluate(`document.activeElement.closest('[data-commerce-shot-id]')?.dataset.commerceShotId`), 'detail');
        assert.deepEqual(await app.evaluate('canceledCommerceRequests'), ['image:detail']);
        assert.ok(await app.evaluate(`${pending('plan:feature')} && ${pending('image:detail-overview')}`));
        await app.waitFor(`${saved}.then(settings=>settings.results.some(row=>row.shotId==='detail'&&row.status==='canceled'))`);
        await app.evaluate("pendingCommerceRequests['plan:feature']()");
        await app.waitFor(available('retry', 'feature'));
        assert.equal(await app.evaluate(status('detail-overview')), 'running');
        await click(app, 'retry', 'feature');
        await app.waitFor(`${pending('image:feature')} && ${available('cancel-all')}`);
        assert.ok(await app.evaluate(`!!${button('cancel-all')}.closest('${panel} .image-parameter-footer')`));
        await click(app, 'cancel-all');
        await app.waitFor(`!(${available('cancel-all')}) && ${available('retry', 'feature')} && ${available('retry', 'detail-overview')}`);
        assert.deepEqual((await app.evaluate('canceledCommerceRequests')).sort(), ['image:detail', 'image:detail-overview', 'image:feature']);
        assert.equal(await app.evaluate(`${featurePreview}.src`), original, 'canceling a regeneration preserves the previous image');
        assert.equal(await app.evaluate(`document.getElementById('modal-error').checkVisibility()`), false);

        await click(app, 'generate');
        await app.waitFor(`${pending('image:detail')} && ${status('detail')}==='running' && ${available('cancel-shot', 'detail')}`);
        await app.evaluate("pendingCommerceRequests['image:detail']()");
        await app.waitFor(`${pending('image:feature')} && ${status('detail')}==='completed'`);
        await click(app, 'cancel-all');
        await app.waitFor(`${saved}.then(settings=>settings.results.some(row=>row.shotId==='detail'&&row.status==='completed') &&
            settings.plan.shots.some(shot=>shot.id==='feature'&&shot.headline==='更新的功能亮点') &&
            settings.plan.shots.some(shot=>shot.id==='detail-overview'&&shot.headline===${JSON.stringify(overviewHeadline)}))`);
        assert.equal(await app.evaluate("canceledCommerceRequests.filter(key=>key==='image:feature').length"), 2);
        assert.equal(await app.evaluate(`${featurePreview}.src`), original);
    }, { initScript });
});

test('custom commerce scenes can be added, reviewed, generated, and deleted independently', { timeout: 30000 }, async () => {
    const reference = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const sceneImage = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const presetIds = ['detail', 'detail-overview'];
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        nodes: [
            { id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100,
                commerceImageSet: { platformId: 'amazon', mainImageMode: 'original', selectedShotIds: presetIds,
                    plannerModelId: 'vision', plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p' } }
        ],
        connections: [{ id: 'photo', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    };
    const summary = '在露营折叠桌旁展示随行杯';
    const initScript = `${commerceRequestGates}
        window.sceneCalls = [];
        const plannedDesigns = new Map();
        const actualFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (url!=='/proxy'||!options?.body) return actualFetch(url, options);
            if (options.body instanceof FormData) {
                const prompt = options.body.get('prompt');
                const id = [...plannedDesigns].find(([,design])=>prompt.includes('画面设计：'+design))?.[0];
                if (!id) throw new Error('Unexpected image request without a reviewed design.');
                sceneCalls.push({kind:'image',id,prompt});
                const isScene = id?.startsWith('scene-');
                if (isScene) await holdCommerceRequest('image:'+id, options.signal);
                return Response.json({data:[{b64_json:isScene?${JSON.stringify(sceneImage)}:${JSON.stringify(reference)}}]});
            }
            const message = JSON.parse(options.body).messages.at(-1);
            const input = JSON.parse(message.content[0].text);
            sceneCalls.push({kind:'plan',input});
            const slot = input.shots[0];
            if (slot.id.startsWith('scene-')) await holdCommerceRequest('plan:'+slot.id, options.signal);
            const shots = input.shots.map(({id,group}) => {
                const sceneSummary = id==='detail' ? '近景展示可拆卸杯盖'
                    : id==='detail-overview' ? '由杯身和杯盖组成的商品全貌'
                        : group==='detail' ? '在办公桌上展示通勤随行杯'
                            : input.sceneDescription ? ${JSON.stringify(summary)} : '窗边晨光下的木桌饮水场景';
                const prompt = sceneSummary+'。采用柔和自然侧光，突出杯身和可拆掉的杯盖。';
                plannedDesigns.set(id, prompt);
                return {id,prompt,headline:'方便取下杯盖',body:'',sceneSummary};
            });
            const plan = {sellingPoints:['杯盖可拆'],shots};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const panel = '#image-parameter-panel';
    const row = id => `${panel} [data-commerce-shot-id=${id}]`;
    const action = (name, id) => `${id ? row(id) : panel} [data-commerce-action=${name}]`;
    const field = (id, name) => `${row(id)} [data-commerce-shot-field=${name}]`;
    const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const visible = selector => `${query(selector)}?.checkVisibility()`;
    const ready = selector => `${visible(selector)} && !${query(selector)}.disabled && ${query(selector)}.getAttribute('aria-disabled')!=='true'`;
    const click = async (app, selector) => {
        assert.ok(await app.evaluate(ready(selector)), `${selector} is actionable`);
        await app.evaluate(`${query(selector)}.scrollIntoView({block:'nearest'})`);
        await nativeClick(app, selector);
    };
    const edit = (app, selector, value) => app.evaluate(`(()=>{
        const input=${query(selector)};
        input.value=${JSON.stringify(value)};
        input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    const add = group => `${action('add-scene')}[data-commerce-scene-group=${group}]`;
    const groupIds = group => `Array.from(${query(add(group))}.closest('.commerce-image-set-result-group')
        .querySelectorAll('[data-commerce-shot-id]'), row=>row.dataset.commerceShotId)`;
    const pending = key => `typeof pendingCommerceRequests[${JSON.stringify(key)}]==='function'`;
    const release = (app, key) => app.evaluate(`pendingCommerceRequests[${JSON.stringify(key)}]()`);
    const state = (id, status) => `${query(row(id))}?.dataset.resultStatus===${JSON.stringify(status)}`;
    const savedNode = `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(document=>document.value.nodes.find(node=>node.id==='commerce'))`;
    const saved = `${savedNode}.then(node=>node.commerceImageSet)`;
    const customImages = "sceneCalls.filter(call=>call.kind==='image'&&call.id?.startsWith('scene-'))";
    const openScene = async (app, id) => {
        if (!await app.evaluate(visible(field(id, 'description')))) await click(app, `${row(id)} .commerce-image-set-shot-toggle`);
    };
    const addScene = async (app, group, description) => {
        const before = await app.evaluate(groupIds(group));
        const requests = await app.evaluate('sceneCalls.length');
        await click(app, add(group));
        await app.waitFor(`${groupIds(group)}.length===${before.length+1}`);
        const ids = await app.evaluate(groupIds(group));
        const id = ids.at(-1);
        assert.deepEqual(ids.slice(0, -1), before);
        assert.ok(await app.evaluate(`${query(row(id))}.hasAttribute('data-commerce-scene-shot')`));
        await app.waitFor(`document.activeElement===${query(field(id, 'description'))}`);
        assert.equal(await app.evaluate(`${query(field(id, 'description'))}.value`), '');
        assert.equal(await app.evaluate('sceneCalls.length'), requests, 'adding a scene creates a draft without a provider request');
        if (description) await edit(app, field(id, 'description'), description);
        await click(app, `${row(id)} .commerce-image-set-shot-toggle`);
        assert.equal(await app.evaluate(visible(field(id, 'description'))), false);
        await click(app, action('replan-shot', id));
        await app.waitFor(`${state(id, 'planning')} && ${pending(`plan:${id}`)}`);
        assert.equal(await app.evaluate(visible(field(id, 'description'))), false, `${group} scene planning keeps the card collapsed`);
        const input = await app.evaluate(`sceneCalls.find(call=>call.kind==='plan'&&call.input.shots[0].id===${JSON.stringify(id)}).input`);
        assert.equal(input.shots.length, 1);
        assert.equal(input.shots[0].group, group);
        assert.equal(input.shots[0].aspect, group === 'gallery' ? '1:1' : '9:16');
        assert.equal(input.sceneDescription, description);
        return id;
    };
    const confirmRemoval = async (app, id, accept = true) => {
        await click(app, action('remove-scene', id));
        const confirm = '#app-action-dialog button[data-dialog-style-1-action=confirm]';
        await app.waitFor(visible(confirm));
        assert.equal(await app.evaluate(`${query(confirm)}.textContent`), '删除场景图');
        if (accept) await click(app, confirm);
        else await key(app, 'Escape');
        await app.waitFor(`!${visible('#app-action-dialog')}`);
        if (accept) await app.waitFor(`!${query(row(id))}`);
    };

    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${reference}`);
        await openParameters(app, 'commerce');
        await click(app, action('plan'));
        await app.waitFor(ready(action('generate')));
        await click(app, action('generate'));
        await app.waitFor(`${saved}.then(settings=>settings.results.filter(row=>row.status==='completed').length===2)`);
        const original = await app.evaluate(saved);
        assert.ok(await app.evaluate(ready(add('gallery'))), '主副图 offers an add-scene action');
        assert.ok(await app.evaluate(ready(add('detail'))), '详情图 offers an add-scene action');

        const galleryBrief = '户外露营时在折叠桌旁饮水';
        const first = await addScene(app, 'gallery', galleryBrief);
        const second = await addScene(app, 'gallery', '');
        const detail = await addScene(app, 'detail', '通勤上班时放在办公桌上');
        const galleryIds = ['detail', first, second];
        const detailIds = ['detail-overview', detail];
        assert.deepEqual(await app.evaluate(groupIds('gallery')), galleryIds);
        assert.deepEqual(await app.evaluate(groupIds('detail')), detailIds);
        assert.ok(await app.evaluate(`${pending(`plan:${first}`)} && ${pending(`plan:${second}`)}`));
        assert.equal(await app.evaluate(`${query(action('remove-scene', first))}?.disabled`), true);
        await click(app, action('cancel-shot', detail));
        await app.waitFor(`canceledCommerceRequests.includes(${JSON.stringify(`plan:${detail}`)})`);
        await app.waitFor(`document.activeElement===${query(action('replan-shot', detail))}`);
        assert.ok(await app.evaluate(`${pending(`plan:${first}`)} && ${pending(`plan:${second}`)}`));

        await release(app, `plan:${first}`);
        await release(app, `plan:${second}`);
        await app.waitFor(`${state(first, 'review')} && ${state(second, 'review')}`);
        await assertCommerceTextTone(app, `${row(first)} .commerce-image-set-shot-status`, '--text-warning');
        assert.deepEqual(await app.evaluate(customImages), [], 'AI planning and canceling a pending plan issue no image request');
        await app.waitFor(ready(action('generate')));
        assert.equal(await app.evaluate(`${query(action('generate'))}.textContent`), '重做已确认图位');
        assert.match(await app.evaluate("document.querySelector('[data-commerce-run-summary=generate]').textContent"),
            /预计调用生图模型 2 次.*暂不执行 3 个图位/);
        const imageCalls = "sceneCalls.filter(call=>call.kind==='image').length";
        const previousImageCalls = await app.evaluate(imageCalls);
        await click(app, action('generate'));
        await app.waitFor(`${imageCalls}===${previousImageCalls + 2} && document.getElementById('btn-stop').disabled`);
        assert.doesNotMatch(await app.evaluate("document.querySelector('#commerce > .node-card-run-status:not([hidden])')?.textContent || ''"),
            /部分完成/, 'unconfirmed scene plans do not count as missing images in the base run');
        assert.deepEqual(await app.evaluate(customImages), [], 'whole-set generation excludes unconfirmed supplemental plans');
        await captureCommerceInspector(app, { name: 'scene-groups', selector: `${panel} .commerce-image-set-plan-heading` });
        await openScene(app, first);
        assert.match(await app.evaluate(`${query(row(first))}.innerText`), new RegExp(summary));
        assert.match(await app.evaluate(`${query(action('retry', first))}.textContent`), /确认并生图/);
        await captureCommerceInspector(app, { name: 'scene-review', shotId: first });
        await captureCommerceInspector(app, { name: 'scene-review-narrow', width: 390, shotId: first });

        await click(app, `${row(first)} .commerce-image-set-shot-toggle`);
        assert.ok(await app.evaluate(ready(action('replan-shot', first))));
        assert.ok(await app.evaluate(ready(action('retry', first))));
        await captureCommerceInspector(app, { name: 'scene-collapsed', shotId: first });
        await captureCommerceInspector(app, { name: 'scene-collapsed-narrow', width: 390, shotId: first });
        await click(app, action('retry', first));
        await app.waitFor(`${state(first, 'running')} && ${pending(`image:${first}`)}`);
        assert.equal(await app.evaluate(visible(field(first, 'description'))), false, 'image generation keeps the card collapsed');
        await openScene(app, second);
        const prompt = await app.evaluate(`${query(field(second, 'prompt'))}.value`);
        await edit(app, field(second, 'prompt'), `${prompt}\n杯身靠近画面中央。`);
        await click(app, action('retry', second));
        await app.waitFor(`${state(second, 'running')} && ${pending(`image:${second}`)}`);
        assert.match(await app.evaluate(`${customImages}.at(-1).prompt`), /杯身靠近画面中央/);
        await openScene(app, first);
        await click(app, action('cancel-shot', first));
        await app.waitFor(`canceledCommerceRequests.includes(${JSON.stringify(`image:${first}`)})`);
        assert.ok(await app.evaluate(pending(`image:${second}`)));
        await app.waitFor(`${state(first, 'canceled')} && ${ready(field(first, 'prompt'))}`);
        const firstPrompt = await app.evaluate(`${query(field(first, 'prompt'))}.value`);
        await edit(app, field(first, 'prompt'), `${firstPrompt} `);
        await release(app, `image:${second}`);
        await app.waitFor(`${saved}.then(settings=>settings.results.some(row=>row.shotId===${JSON.stringify(second)}&&row.status==='completed'))`);

        const current = await app.evaluate(saved);
        assert.deepEqual(current.plan.shots.filter(shot=>presetIds.includes(shot.id)), original.plan.shots);
        assert.deepEqual(current.results.filter(result=>presetIds.includes(result.shotId)), original.results);
        assert.deepEqual(current.plan.shots.map(shot=>shot.id), [...galleryIds, ...detailIds]);
        assert.equal(current.plan.shots.find(shot=>shot.id===first).sceneConfirmed, false,
            'sibling completion preserves the confirmation reset from a normalized edit');
        assert.deepEqual(current.results.filter(result=>result.status==='completed').map(result=>result.shotId),
            ['detail', second, 'detail-overview']);
        assert.deepEqual(await app.evaluate(`${customImages}.map(call=>call.id)`), [first, second]);

        await app.waitFor(ready(action('remove-scene', detail)));
        for (const presetId of presetIds) assert.equal(await app.evaluate(`!!${query(action('remove-scene', presetId))}`), false);
        const callsBeforeRemoval = await app.evaluate('sceneCalls.length');
        await confirmRemoval(app, detail);
        assert.deepEqual(await app.evaluate(groupIds('detail')), ['detail-overview']);

        await click(app, action('toggle-final', second));
        assert.equal(await app.evaluate(`${query(action('remove-scene', second))}.disabled`), true);
        await click(app, action('toggle-final', second));
        await confirmRemoval(app, second, false);
        assert.deepEqual(await app.evaluate(groupIds('gallery')), galleryIds);
        await confirmRemoval(app, second);
        assert.deepEqual(await app.evaluate(groupIds('gallery')), ['detail', first]);

        const removedIds = JSON.stringify([second, detail]);
        const removedAsset = current.results.find(result => result.shotId === second).assetKey;
        await app.waitFor(`${savedNode}.then(node => !node.mediaAssetKeys.includes(${JSON.stringify(removedAsset)})
            && !node.commerceImageSet.selectedShotIds.some(id => ${removedIds}.includes(id)))`);
        const afterRemoval = await app.evaluate(savedNode);
        assert.deepEqual(afterRemoval.mediaAssetKeys, original.results.map(result => result.assetKey));
        assert.deepEqual(afterRemoval.commerceImageSet.customScenes.map(scene => scene.id), [first]);
        assert.deepEqual(afterRemoval.commerceImageSet.plan.shots, current.plan.shots.filter(shot => ![second, detail].includes(shot.id)));
        assert.deepEqual(afterRemoval.commerceImageSet.results, current.results.filter(result => ![second, detail].includes(result.shotId)));
        assert.equal(afterRemoval.commerceImageSet.plan.confirmed, current.plan.confirmed);
        assert.equal(await app.evaluate('sceneCalls.length'), callsBeforeRemoval);

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        assert.deepEqual(await app.evaluate(groupIds('gallery')), ['detail', first]);
        assert.deepEqual(await app.evaluate(groupIds('detail')), ['detail-overview']);
        await app.waitFor(`${query(`${row('detail')} img`)}?.naturalWidth>0 && ${state('detail', 'completed')}`);
        await openScene(app, first);
        assert.equal(await app.evaluate(`${query(field(first, 'description'))}.value`), galleryBrief);
        assert.deepEqual(await app.evaluate('sceneCalls'), []);
    }, { initScript });
});

test('supplemental scenes survive unrelated replanning and keep the previous reference set out of the current ZIP', { timeout: 45000 }, async () => {
    const [original, replacement, closeup, sceneImage] = await Promise.all(['red', 'green', 'blue', 'yellow'].map(async color =>
        (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        nodes: [
            { id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100, commerceImageSet: {
                platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['main', 'detail'], plannerModelId: 'vision',
                plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p'
            } }
        ],
        connections: [{ id: 'product-reference', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }],
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }]
    };
    const editPrompt = '办公室白色书桌上的随行杯';
    const initScript = `window.commerceRepairRequests=[];
        const actualFetch = fetch.bind(window);
        window.fetch = async (url, options) => {
            if (url !== '/proxy' || !options?.body) return actualFetch(url, options);
            if (options.body instanceof FormData) {
                const prompt = options.body.get('prompt');
                commerceRepairRequests.push(prompt);
                return Response.json({data:[{b64_json:prompt.includes(${JSON.stringify(editPrompt)})
                    ? ${JSON.stringify(sceneImage)} : ${JSON.stringify(closeup)}}]});
            }
            const message = JSON.parse(options.body).messages.at(-1);
            const input = JSON.parse(message.content[0].text);
            if (window.holdCommerceRepairDetail && input.shots.length === 1 && input.shots[0].id === 'detail') {
                await new Promise(resolve => { window.releaseCommerceRepairDetail = resolve; });
            }
            const plan = {sellingPoints:['杯盖可拆'], shots: input.shots.map(({id}) => ({
                id, prompt: id.startsWith('scene-') ? '在露营桌旁展示随行杯' : '展示随行杯和杯盖',
                headline: '方便取下杯盖', body: '', sceneSummary: '露营桌旁的随行杯'
            }))};
            return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
        };`;
    const panel = '#image-parameter-panel';
    const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const action = (name, scope = panel) => `${scope} [data-commerce-action=${name}]`;
    const row = `${panel} [data-commerce-scene-shot]`;
    const prompt = `${row} [data-commerce-shot-field=prompt]`;
    const add = `${action('add-scene')}[data-commerce-scene-group=detail]`;
    const edit = (app, selector, value) => app.evaluate(`(() => {
        const control = ${query(selector)};
        control.value = ${JSON.stringify(value)};
        control.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    const click = async (app, selector) => {
        await app.waitFor(`${query(selector)}?.checkVisibility() && !${query(selector)}.disabled`);
        await app.evaluate(`${query(selector)}.scrollIntoView({block:'nearest'})`);
        await nativeClick(app, selector);
    };
    const storedNode = `fetch('/api/storage/documents/session').then(response => response.json())
        .then(doc => doc.value.nodes.find(node => node.id === 'commerce'))`;
    const closeDialog = '#commerce-export-dialog [data-commerce-export-close]';
    const download = '#commerce-export-dialog [data-commerce-export-download]';
    const archiveToggle = '#commerce-export-dialog label:has([name=commerce-export-version][value=previous])';

    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${original}`);
        await openParameters(app, 'commerce');
        await click(app, action('plan'));
        await click(app, action('generate'));
        await app.waitFor(`${storedNode}.then(node => node.mediaAssetKeys?.length === 2)`);
        const base = await app.evaluate(storedNode);

        await click(app, add);
        await click(app, action('replan-shot', row));
        await app.waitFor(`${query(prompt)}?.checkVisibility()`);
        await edit(app, prompt, editPrompt);
        await app.waitFor(`${query(row + ' .commerce-image-set-scene-summary')}.textContent.includes(${JSON.stringify(editPrompt)})`);

        const setup = `${panel} .commerce-image-set-setup`;
        if (!await app.evaluate(`${query(setup)}.open`)) await click(app, `${setup} > summary`);
        await click(app, `${panel} label:has([data-commerce-select-shot=feature])`);
        await click(app, action('plan'));
        await app.waitFor(`${query(add)}.disabled === false`);
        await app.waitFor(`${storedNode}.then(node => node.commerceImageSet.plan.shots.some(shot =>
            shot.customScene && shot.prompt === ${JSON.stringify(editPrompt)} && !shot.sceneNeedsReview)
            && node.commerceImageSet.selectedShotIds.includes('feature'))`);
        await edit(app, commerceProductField('name'), '新品随行杯');
        await click(app, action('plan'));
        await app.waitFor(`${query(row)}?.dataset.resultStatus === 'review-update' && !${query(add)}.disabled`);
        if (!await app.evaluate(`${query(prompt)}?.checkVisibility()`)) await click(app, `${row} .commerce-image-set-shot-toggle`);
        assert.equal(await app.evaluate(`${query(prompt)}.value`), editPrompt);
        await app.evaluate('window.holdCommerceRepairDetail = true');
        await click(app, action('replan-shot', `${panel} [data-commerce-shot-id=detail]`));
        await app.waitFor("typeof window.releaseCommerceRepairDetail === 'function'");
        await click(app, action('retry', row));
        await app.waitFor(`${storedNode}.then(node => node.mediaAssetKeys?.length === 3)`);
        await app.evaluate('window.releaseCommerceRepairDetail()');
        await app.waitFor("document.getElementById('btn-stop').disabled");
        const withScene = await app.evaluate(storedNode);
        assert.deepEqual(withScene.mediaAssetKeys.slice(0, 2), base.mediaAssetKeys);
        assert.equal(await app.evaluate('commerceRepairRequests.length'), 2);

        await uploadImageOriginal(app, 'product', `data:image/png;base64,${replacement}`);
        await openParameters(app, 'commerce');
        await app.waitFor(`${query(panel + ' .commerce-image-set-status')}.textContent.includes('商品参考图已变更')`);
        assert.equal(await app.evaluate(`${query(add)}.disabled`), true);
        assert.ok(await app.evaluate(`${query(action('preview-previous'))}.checkVisibility()`));
        await click(app, action('export'));
        await app.waitFor(`${query('#commerce-export-dialog .commerce-export-summary')}.textContent.includes('可导出 0 张')`);
        assert.equal(await app.evaluate(`${query(download)}.disabled`), true);
        await click(app, archiveToggle);
        await app.waitFor(`${query(download)}.disabled === false`);
        await app.waitFor(`${query('#commerce-export-dialog .commerce-export-summary')}.textContent.includes('可导出 3 张')`);
        await captureCommerceInspector(app, { name: 'previous-reference-export', width: 390, surface: '#commerce-export-dialog' });
        await click(app, closeDialog);

        await click(app, action('plan'));
        await app.waitFor(`${storedNode}.then(node => !node.mediaAssetKeys?.length
            && node.commerceImageSet.previousExportResults?.length === 3)`);
        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        await click(app, action('export'));
        await click(app, archiveToggle);
        await app.waitFor(`${query('#commerce-export-dialog .commerce-export-summary')}.textContent.includes('可导出 3 张')`);
    }, { initScript });
});

test('commerce ZIP export lists missing and previous images and keeps shot numbering across scopes', { timeout: 30000 }, async () => {
    const galleryImage = await readFile(new URL('./fixtures/reference-red.png', import.meta.url));
    const detailImage = await readFile(new URL('./fixtures/reference-blue.png', import.meta.url));
    const shotIds = ['angle', 'feature', 'detail-overview'];
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }],
        nodes: [{ id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100, commerceImageSet: {
                platformId: 'amazon', mainImageMode: 'original', selectedShotIds: shotIds, plannerModelId: 'vision', plannerProviderId: 'p',
                imageModelId: 'image', imageProviderId: 'p'
            } }],
        connections: [{ id: 'product-reference', from: { nodeId: 'product', port: 'image' },
            to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 }]
    };
    const initScript = `window.commerceExportProviderRequests=[];
        Object.defineProperty(window, 'showSaveFilePicker', { configurable:true, value:undefined });
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            const missingAsset=options?.method==='HEAD' ? window.unavailableCommerceExportAsset : window.lateUnavailableCommerceExportAsset;
            if (missingAsset && new URL(url, location.origin).pathname===missingAsset) {
                return new Response(null, {status:404});
            }
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (!(options.body instanceof FormData)) {
                commerceExportProviderRequests.push('plan');
                const plan={sellingPoints:['可见杯盖'],shots:${JSON.stringify(shotIds)}.map(id=>({
                    id,prompt:'导出测试图位 '+id+'\\n商品靠右，近景构图与柔和光线。'
                }))};
                return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
            }
            const shot=options.body.get('prompt').match(/^画面设计：导出测试图位 ([a-z-]+)$/m)?.[1];
            commerceExportProviderRequests.push(shot);
            if (shot==='angle') return Response.json({error:{message:'Fixture missing angle'}},{status:400});
            const rgb=shot==='feature' ? ${JSON.stringify(galleryImage.toString('base64'))} : ${JSON.stringify(detailImage.toString('base64'))};
            return Response.json({data:[{b64_json:rgb}]});
        };`;
    const panel = '#image-parameter-panel';
    const dialog = '#commerce-export-dialog';
    const download = `${dialog} [data-commerce-export-download]`;
    const row = id => `${panel} [data-commerce-shot-id=${id}]`;
    const exportRow = id => `${dialog} [data-commerce-export-shot=${id}]`;
    const action = name => `${panel} [data-commerce-action=${name}]`;
    const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const ready = selector => `${query(selector)}?.checkVisibility() && !${query(selector)}.disabled`;
    const exportRows = `Array.from(document.querySelectorAll('${dialog} [data-commerce-export-shot]'),
        element => element.dataset.commerceExportShot)`;
    const chooseScope = async (app, scope, expectedIds) => {
        await app.evaluate(`${query(`${dialog} [data-commerce-export-scope=${scope}]`)}.click()`);
        await app.waitFor(`JSON.stringify(${exportRows})===${JSON.stringify(JSON.stringify(expectedIds))}`);
        assert.equal(await app.evaluate(`${query(`${dialog} [data-commerce-export-scope=${scope}]`)}.checked`), true);
    };

    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${galleryImage.toString('base64')}`);
        await openParameters(app, 'commerce');
        await app.evaluate(`${query(action('plan'))}.click()`);
        await app.waitFor(ready(action('generate')));
        await nativeClick(app, action('generate'));
        await app.waitFor(`${query(row('angle'))}.dataset.resultStatus==='failed' &&
            ${query(`${row('feature')} img`)}.naturalWidth>0 &&
            ${query(`${row('detail-overview')} img`)}.naturalWidth>0 && ${ready(action('fill'))}`);
        await app.evaluate(`(() => {
            const card = ${query(row('detail-overview'))};
            const toggle = card.querySelector('.commerce-image-set-shot-toggle');
            toggle.click();
            const field = card.querySelector('[data-commerce-shot-field=prompt]');
            field.value += '\\n新版画面采用斜侧光。';
            field.dispatchEvent(new Event('input', { bubbles:true }));
            toggle.click();
        })()`);
        await app.waitFor(showsPreviousCommerceImage(row('detail-overview')));

        const providerRequests = await app.evaluate('commerceExportProviderRequests');
        assert.ok(await app.evaluate(ready(action('export'))), 'a partially completed set can be exported');
        await nativeClick(app, action('export'));
        await app.waitFor(`${query(dialog)}?.checkVisibility() && ${ready(download)}`);
        assert.deepEqual(await app.evaluate(exportRows), shotIds);
        assert.match(await app.evaluate(`${query(exportRow('angle'))}.innerText`), /缺图/);
        assert.match(await app.evaluate(`${query(exportRow('detail-overview'))}.innerText`), /旧图|上一版/);
        await captureCommerceInspector(app, { name: 'export-review', surface: dialog });
        await captureCommerceInspector(app, { name: 'export-review-narrow', width: 390, surface: dialog });

        const downloadDirectory = join(app.server.dataDir, 'commerce-exports');
        await mkdir(downloadDirectory, { recursive: true });
        await app.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
        const readArchive = async (scope, label, ids) => {
            if (!await app.evaluate(`${query(dialog)}?.checkVisibility()`)) await nativeClick(app, action('export'));
            await chooseScope(app, scope, ids);
            await app.waitFor(ready(download));
            const before = await readdir(downloadDirectory);
            await nativeClick(app, download);
            let name;
            await app.waitFor(async () => {
                name = (await readdir(downloadDirectory)).find(file => file.endsWith('.zip') && !before.includes(file));
                return Boolean(name);
            });
            assert.equal(name, `电商套图_${label}.zip`);
            const { stdout } = await promisify(execFile)(process.env.CAINFLOW_PYTHON || 'python', ['-c',
                'import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps([(n,base64.b64encode(z.read(n)).decode()) for n in z.namelist()]))',
                join(downloadDirectory, name)
            ]);
            return JSON.parse(stdout).map(([path, bytes]) => [path, Buffer.from(bytes, 'base64')]);
        };
        assert.deepEqual(await readArchive('gallery', '主副图', ['angle', 'feature']), [['02_卖点图.png', galleryImage]]);
        assert.deepEqual(await readArchive('detail', '详情图', ['detail-overview']), [['03_详情首屏.png', detailImage]]);
        assert.deepEqual(await readArchive('all', '全套', shotIds), [
            ['02_卖点图.png', galleryImage], ['03_详情首屏.png', detailImage]
        ]);

        if (!await app.evaluate(`${query(dialog)}?.checkVisibility()`)) await nativeClick(app, action('export'));
        await chooseScope(app, 'all', shotIds);
        await app.waitFor(ready(download));
        assert.equal(await app.evaluate(`${query(exportRow('detail-overview'))}.dataset.exportStatus`), 'previous',
            'the detail image passed the pre-export check');
        const beforeFailedExport = (await readdir(downloadDirectory)).sort();
        await app.evaluate(`window.lateUnavailableCommerceExportAsset=new URL(${query(`${row('detail-overview')} img`)}.src).pathname`);
        await nativeClick(app, download);
        const alert = query(`${dialog} [role=alert]`);
        await app.waitFor(`${alert}.checkVisibility() && ${query(exportRow('detail-overview'))}.dataset.exportStatus==='missing' && ${ready(download)}`);
        assert.match(await app.evaluate(`${alert}.innerText`), /无法读取.+详情首屏/);
        assert.match(await app.evaluate(`${query(exportRow('detail-overview'))}.innerText`), /无法读取/);
        assert.deepEqual((await readdir(downloadDirectory)).sort(), beforeFailedExport,
            'a file disappearing after preflight aborts the archive instead of saving the remaining files');
        await app.evaluate("window.lateUnavailableCommerceExportAsset=''");

        if (await app.evaluate(`${query(dialog)}?.checkVisibility()`)) {
            await key(app, 'Escape');
            await app.waitFor(`!${query(dialog)}?.checkVisibility()`);
        }
        await app.evaluate(`window.unavailableCommerceExportAsset=new URL(${query(`${row('feature')} img`)}.src).pathname`);
        await nativeClick(app, action('export'));
        await app.waitFor(`${query(dialog)}?.checkVisibility()`);
        await chooseScope(app, 'gallery', ['angle', 'feature']);
        await app.waitFor(`/缺图|文件不可用/.test(${query(exportRow('feature'))}?.innerText)`);
        assert.equal(await app.evaluate(ready(download)), false, 'a scope with no readable images cannot be downloaded');
        await key(app, 'Escape');
        await app.waitFor(`!${query(dialog)}?.checkVisibility() && document.activeElement===${query(action('export'))}`);
        assert.deepEqual(await app.evaluate('commerceExportProviderRequests'), providerRequests,
            'reviewing and downloading saved images never reruns planning or generation');
    }, { initScript });
});

test('commerce finalized shots survive a whole-set redo and saved candidates restore their matching drafts', { timeout: 30000 }, async () => {
    const [initialImage, middleImage, newerImage, detailImage] = await Promise.all(['red', 'orange', 'blue', 'green'].map(async color =>
        (await readFile(new URL(`./fixtures/reference-${color}.png`, import.meta.url))).toString('base64')));
    const firstDraft = {
        prompt: '候选卖点初版，采用自然侧光与近景构图。',
        headline: '可拆杯盖',
        body: '拆下杯盖后清洗。'
    };
    const revisedDraft = {
        prompt: '候选卖点新版，采用暖光与俯拍构图。',
        headline: '便于清洗',
        body: '俯拍展示杯盖拆下后的状态。'
    };
    const middleDraft = {
        prompt: '候选卖点中间版，杯盖放在杯身旁。',
        headline: '拆卸便捷',
        body: '画面展示杯身与杯盖。'
    };
    const detailDraft = { prompt: '候选详情首屏，完整展示带盖随行杯。', headline: '带盖随行杯', body: '' };
    const fixture = {
        autoCheckUpdatesOnLoad: false,
        autoRetry: false,
        models: [{ id: 'vision', modelId: 'gpt-4o', taskType: 'chat', protocol: 'openai', providerIds: ['p'] },
            { id: 'image', modelId: 'gpt-image-2', taskType: 'image', protocol: 'openai', providerIds: ['p'] }],
        providers: [{ id: 'p', endpoint: 'https://fixture.test/v1', apikey: 'test' }],
        nodes: [
            { id: 'product', type: 'ImageImport', x: 40, y: 100 },
            { id: 'commerce', type: 'ECommerceImageSet', x: 440, y: 100, commerceImageSet: {
                platformId: 'amazon', mainImageMode: 'original', selectedShotIds: ['feature', 'detail-overview'], plannerModelId: 'vision',
                plannerProviderId: 'p', imageModelId: 'image', imageProviderId: 'p'
            } },
            { id: 'preview', type: 'ImagePreview', x: 40, y: 470 }
        ],
        connections: [
            { id: 'product-reference', from: { nodeId: 'product', port: 'image' },
                to: { nodeId: 'commerce', port: 'referenceImages' }, type: 'image', order: 0 },
            { id: 'set-preview', from: { nodeId: 'commerce', port: 'image' },
                to: { nodeId: 'preview', port: 'image' }, type: 'image' }
        ]
    };
    const initScript = `window.candidateTestRequests=[];
        const actualFetch=window.fetch.bind(window);
        window.fetch=async (url, options)=>{
            if(window.pauseCandidateStorage && url==='/api/storage/media-assets' &&
                JSON.parse(options?.body || '{}').action==='materialize-owner-list'){
                window.pauseCandidateStorage=false;
                await new Promise(resolve=>{ window.releaseCandidateStorage=resolve; });
            }
            if (url!=='/proxy'||!options?.body) return actualFetch(url,options);
            if (!(options.body instanceof FormData)) {
                candidateTestRequests.push('plan');
                const plan={sellingPoints:[],shots:${JSON.stringify([
                    { id: 'feature', ...firstDraft }, { id: 'detail-overview', ...detailDraft }
                ])}};
                return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});
            }
            const prompt=options.body.get('prompt');
            const shot=prompt.includes('候选详情首屏')?'detail-overview':'feature';
            candidateTestRequests.push(shot);
            if (window.holdCandidateGeneration) {
                window.holdCandidateGeneration=false;
                await new Promise(resolve=>{ window.releaseCandidateGeneration=resolve; });
            }
            const image=window.candidateBatchImages?.shift() ?? (shot==='detail-overview'?${JSON.stringify(detailImage)}:
                prompt.includes('候选卖点新版')?${JSON.stringify(newerImage)}:
                prompt.includes('候选卖点中间版')?${JSON.stringify(middleImage)}:${JSON.stringify(initialImage)});
            return Response.json({data:[{b64_json:image}]});
        };`;
    const panel = '#image-parameter-panel';
    const feature = `${panel} [data-commerce-shot-id=feature]`;
    const dialog = '#commerce-candidates-dialog';
    const action = (name, root = panel) => `${root} [data-commerce-action=${name}]`;
    const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const ready = selector => `${query(selector)}?.checkVisibility() && !${query(selector)}.disabled
        && ${query(selector)}.getAttribute('aria-disabled')!=='true'`;
    const click = async (app, selector) => {
        await app.waitFor(ready(selector));
        await app.evaluate(`${query(selector)}.scrollIntoView({block:'nearest'})`);
        await nativeClick(app, selector);
    };
    const lock = action('toggle-final', feature);
    const compare = action('compare-shot', feature);
    const retry = action('retry', feature);
    const toggle = `${feature} .commerce-image-set-shot-toggle`;
    const field = name => `${feature} [data-commerce-shot-field=${name}]`;
    const resultPreview = `${action('preview', feature)} img`;
    const candidateCount = `${panel} [data-commerce-field=candidateCount]`;
    const lockState = locked => `${query(lock)}?.getAttribute('aria-pressed')===${JSON.stringify(String(locked))}`;
    const node = id => `fetch('/api/storage/documents/session').then(response=>response.json())
        .then(document=>document.value.nodes.find(node=>node.id===${JSON.stringify(id)}))`;
    const saved = node('commerce');
    const detailSlot = 'detail-overview';
    const asset = (settings, id) => settings.results.find(result => result.shotId === id)?.assetKey;
    const planDraft = settings => {
        const { prompt, headline, body } = settings.plan.shots.find(shot => shot.id === 'feature');
        return { prompt, headline, body };
    };
    const isUsing = (selector, key) => `${query(selector)}?.naturalWidth>0 &&
        decodeURIComponent(new URL(${query(selector)}.src).pathname.split('/').at(-1))===${JSON.stringify(key)}`;

    await withAppBrowser(fixture, async app => {
        await uploadImageOriginal(app, 'product', `data:image/png;base64,${detailImage}`);
        await openParameters(app, 'commerce');
        assert.equal(await app.evaluate(`${query(candidateCount)}.value`), '1');
        await click(app, action('plan'));
        await click(app, action('generate'));
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.results.filter(row=>row.status==='completed').length===2)`);
        const original = (await app.evaluate(saved)).commerceImageSet;
        const initial = asset(original, 'feature');
        assert.deepEqual(planDraft(original), firstDraft);
        assert.equal(await app.evaluate(`${query(compare)}.textContent.trim()`), '生成候选…');

        await click(app, toggle);
        const regenerate = async (draft, previous) => {
            for (const [name, value] of Object.entries(draft)) {
                await app.evaluate(`(()=>{
                    const input=${query(field(name))};
                    input.value=${JSON.stringify(value)};
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                })()`);
            }
            await click(app, retry);
            await app.waitFor(`${saved}.then(node=>node.commerceImageSet.results.some(row=>row.shotId==='feature' &&
                row.status==='completed' && row.assetKey!==${JSON.stringify(previous)}))`);
            const settings = (await app.evaluate(saved)).commerceImageSet;
            assert.deepEqual(planDraft(settings), draft);
            return asset(settings, 'feature');
        };
        const middle = await regenerate(middleDraft, initial);
        const newer = await regenerate(revisedDraft, middle);
        assert.equal(new Set([initial, middle, newer]).size, 3);

        await click(app, lock);
        await app.waitFor(lockState(true));
        assert.equal(Boolean(await app.evaluate(ready(retry))), false, 'a finalized shot cannot be replaced until unlocked');
        assert.match(await app.evaluate("document.querySelector('[data-commerce-run-summary=generate]').textContent"),
            /预计调用生图模型 1 次.*保留定稿 1 张/);
        await click(app, action('generate'));
        await app.waitFor("candidateTestRequests.length>=6 && document.getElementById('btn-stop').disabled");
        assert.deepEqual(await app.evaluate('candidateTestRequests'),
            ['plan', 'feature', detailSlot, 'feature', 'feature', detailSlot], 'batch redo requests only the unlocked shot');
        const afterRedo = (await app.evaluate(saved)).commerceImageSet;
        assert.equal(asset(afterRedo, 'feature'), newer);

        await reloadAppBrowser(app);
        await openParameters(app, 'commerce');
        await app.waitFor(`${lockState(true)} && ${isUsing(resultPreview, newer)}`);
        assert.equal(Boolean(await app.evaluate(ready(retry))), false);
        assert.equal(await app.evaluate(`${query(compare)}.textContent.trim()`), '对比 2 张候选');
        await captureCommerceInspector(app, { name: 'finalized-shot', shotId: 'feature' });
        const currentImage = `${dialog} .commerce-candidate-comparison [data-commerce-current-preview] img`;
        const candidateImage = `${dialog} .commerce-candidate-comparison [data-commerce-candidate-preview] img`;
        const apply = `${dialog} [data-commerce-candidate-apply]`;
        await click(app, compare);
        await app.waitFor(`${query(dialog)}?.checkVisibility() && ${isUsing(candidateImage, middle)}`);
        assert.equal(await app.evaluate(`${query(apply)}.disabled`), true, 'candidate comparison cannot replace the finalized shot');
        await key(app, 'Escape');
        await app.waitFor(`!${query(dialog)}?.checkVisibility() && document.activeElement===${query(compare)}`);

        await click(app, lock);
        await app.waitFor(`${lockState(false)} && ${ready(retry)}`);
        await app.evaluate(`${query(`${panel} .commerce-image-set-setup`)}.open=true`);
        await click(app, `${panel} label:has([data-commerce-select-shot=main])`);
        assert.equal(await app.evaluate(isUsing(resultPreview, newer)), true, 'adding a compatible slot keeps the current image');
        await click(app, action('plan'));
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.plan?.shots.some(shot=>shot.id==='main') &&
            !node.commerceImageSet.plan.stale && node.commerceImageSet.results.filter(row=>row.status==='completed').length===2)`);
        await app.evaluate('candidateTestRequests=[]');

        await app.evaluate(`${query(compare)}.focus()`);
        await key(app, 'Enter');
        await app.waitFor(`${query(dialog)}?.checkVisibility() && ${isUsing(currentImage, newer)} && ${isUsing(candidateImage, middle)}`);
        const earlierCandidate = `${dialog} [data-commerce-candidate^="${initial}:"]`;
        await click(app, earlierCandidate);
        await app.waitFor(isUsing(candidateImage, initial));
        assert.equal(await app.evaluate(`${query(earlierCandidate)}.getAttribute('aria-pressed')`), 'true');
        await click(app, `${dialog} [data-commerce-candidate-preview] button`);
        await app.waitFor("document.querySelector('.fullscreen-overlay')?.checkVisibility()");
        await key(app, 'ArrowRight');
        await key(app, 'Escape');
        await app.waitFor(`${query(dialog)}?.open && !document.querySelector('.fullscreen-overlay')`);
        assert.equal(await app.evaluate(`${query(earlierCandidate)}.getAttribute('aria-pressed')`), 'true', 'preview preserves selection');
        const comparison = await app.evaluate(`(()=>{
            const current=${query(currentImage)}.getBoundingClientRect();
            const candidate=${query(candidateImage)}.getBoundingClientRect();
            return {currentX:current.x,candidateX:candidate.x,currentY:current.y,candidateY:candidate.y};
        })()`);
        assert.notEqual(comparison.currentX, comparison.candidateX, 'both alternative images are displayed side by side');
        assert.ok(Math.abs(comparison.currentY - comparison.candidateY) < 4);
        await captureCommerceInspector(app, { name: 'candidate-comparison', surface: dialog });
        await captureCommerceInspector(app, { name: 'candidate-comparison-narrow', width: 390, surface: dialog });
        await click(app, apply);
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.results.some(row=>row.shotId==='feature' &&
            row.assetKey===${JSON.stringify(initial)}))`);
        const restored = await app.evaluate(saved);
        assert.deepEqual(planDraft(restored.commerceImageSet), firstDraft);
        const ordered = [initial, asset(afterRedo, detailSlot)];
        assert.deepEqual(restored.mediaAssetKeys, ordered);
        await app.waitFor(`${node('preview')}.then(node=>JSON.stringify(node.mediaAssetKeys)===${JSON.stringify(JSON.stringify(ordered))})`);
        await app.waitFor(isUsing(resultPreview, initial));
        assert.deepEqual(await app.evaluate('candidateTestRequests'), [], 'comparing and restoring a saved candidate never call a provider');

        await app.evaluate(`(() => {
            ${query(`${panel} .commerce-image-set-setup`)}.open = true;
            const count = ${query(candidateCount)};
            count.value = '3';
            count.dispatchEvent(new Event('change', { bubbles: true }));
            window.candidateBatchImages = ${JSON.stringify([newerImage, middleImage, initialImage])};
        })()`);
        await captureCommerceInspector(app, { name: 'candidate-generation-settings', selector: candidateCount });
        await click(app, retry);
        await app.waitFor(`${saved}.then(node=>{
            const settings=node.commerceImageSet;
            const feature=settings.results.find(row=>row.shotId==='feature');
            return settings.candidateCount===3 && feature?.assetKey===${JSON.stringify(newer)} &&
                settings.candidates.filter(version=>version.shotId==='feature'&&version.planKey===feature.planKey).length===3;
        })`);
        assert.deepEqual(await app.evaluate('candidateTestRequests'), ['feature', 'feature', 'feature']);
        assert.deepEqual((await app.evaluate(saved)).mediaAssetKeys, [newer, ordered[1]], 'candidate images do not add output positions');

        await click(app, compare);
        await app.waitFor(`${query(dialog)}?.open`);
        const generateMore = `${dialog} [data-commerce-candidate-generate]`;
        const stopCandidate = `${dialog} [data-commerce-candidate-cancel]`;
        const candidateViewport = await app.evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})');
        await app.send('Emulation.setDeviceMetricsOverride', { ...candidateViewport, width: 390, height: 540 });
        await app.evaluate(`(() => {
            ${query(`${dialog} [data-commerce-candidate-quantity]`)}.value = '8';
            window.candidateTestRequests = [];
            window.holdCandidateGeneration = true;
            window.candidateBatchImages = Array.from({length:8}, (_, index) => {
                const canvas = document.createElement('canvas'); canvas.width=96; canvas.height=96;
                const context = canvas.getContext('2d'); context.fillStyle='hsl('+index*40+',70%,55%)';
                context.fillRect(0,0,96,96); return canvas.toDataURL('image/png').split(',')[1];
            });
        })()`);
        await app.evaluate(`${query(generateMore)}.focus()`);
        await key(app, 'Enter');
        await app.waitFor(`typeof window.releaseCandidateGeneration==='function' && document.activeElement===${query(stopCandidate)}`);
        const pending = await app.evaluate(`(() => {
            const row = ${query(`${dialog} .commerce-candidate-progress-row`)};
            const rect = row.getBoundingClientRect();
            const stop = ${query(stopCandidate)}.getBoundingClientRect();
            return { text: row.innerText, visible: rect.top >= 0 && rect.bottom <= innerHeight,
                reachable: ${query(stopCandidate)}.contains(document.elementFromPoint(stop.x + stop.width / 2, stop.y + stop.height / 2)) };
        })()`);
        assert.match(pending.text, /正在生成 8 张候选/);
        assert.ok(pending.visible && pending.reachable, JSON.stringify(pending));
        await app.evaluate('window.releaseCandidateGeneration()');
        await app.waitFor(`${query(generateMore)} && !${query(generateMore)}.disabled && window.candidateTestRequests.length===8`);
        assert.equal(await app.evaluate(`document.activeElement===${query(generateMore)}`), true);
        await app.send('Emulation.setDeviceMetricsOverride', candidateViewport);
        assert.equal(await app.evaluate(`${query(dialog)}.open`), true);
        assert.equal(await app.evaluate(`${query(`${dialog} [data-commerce-candidate-cancel]`)}.checkVisibility()`), false);
        assert.ok(await app.evaluate(`document.querySelectorAll('${dialog} [data-commerce-candidate]').length >= 8`));
        await captureCommerceInspector(app, { name: 'candidate-gallery-many', surface: dialog });
        await captureCommerceInspector(app, { name: 'candidate-gallery-many-narrow', width: 390, surface: dialog });
        assert.deepEqual((await app.evaluate(saved)).mediaAssetKeys, [newer, ordered[1]], 'append does not adopt a new image');
        await click(app, `${dialog} [data-commerce-candidate-close]`);
        assert.equal(await app.evaluate(`${query(candidateCount)}.value`), '3');
        assert.equal((await app.evaluate(saved)).commerceImageSet.candidateCount, 3);
        assert.match(await app.evaluate(`${query(`${panel} [data-commerce-run-summary=generate]`)}.textContent`), /预计调用生图模型 6 次/);
        await app.evaluate('window.pauseCandidateStorage=true');
        await click(app, action('generate'));
        await app.waitFor("typeof window.releaseCandidateStorage==='function'");
        const footerCancel = action('cancel-all');
        await app.waitFor(`${query(footerCancel)}?.getAttribute('aria-disabled')==='true' &&
            ${query(`${panel} .commerce-image-set-status`)}?.textContent.includes('正在保存成图')`);
        await app.evaluate(`${query(footerCancel)}.click(); window.releaseCandidateStorage()`);
        await app.waitFor(`${saved}.then(node=>node.commerceImageSet.results.find(row=>row.shotId==='feature')?.assetKey===${JSON.stringify(initial)})`);
    }, { initScript });
});
