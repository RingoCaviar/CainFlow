import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withAppBrowser, reloadAppBrowser, waitForAutosave } from './helpers/app-browser.mjs';
import { uploadImageOriginal } from './helpers/image-upload.mjs';
import { key, nativeClick, openParameters, saved } from './helpers/image-first-integrated-fixture.mjs';

const panel = '#image-parameter-panel';
const runButton = `document.querySelector('${panel} [data-retouch-action=run]')`;
const field = selector => `document.querySelector('${panel} [data-retouch-field=${selector}]')`;
const background = value => `document.querySelector('${panel} [data-retouch-field=background][value=${value}]')`;
const inspect = `${panel} [data-retouch-inspect]`;
const dockWidthHandle = `${panel} [data-parameter-resize=width]`;
const closeDock = `${panel} [data-parameter-action=close]`;
const analysisDetails = `${panel} [data-retouch-analysis]`;
const analysisPrompt = `${analysisDetails} [data-retouch-analysis-prompt]`;
const copyAnalysis = `${panel} [data-retouch-action=copy-analysis]`;
const compareStage = '#retouch .product-retouch-compare-stage';
const compareSlider = '#retouch [data-retouch-compare-slider]';
const compareHandle = `${compareStage} .product-retouch-compare-divider > span`;
const cardPreview = `${compareStage} .product-retouch-card-preview`;
const compareDialog = '.product-retouch-compare-dialog[role="dialog"]';
const dialogFrame = `${compareDialog} [data-retouch-dialog-frame]`;
const dialogSlider = `${compareDialog} [data-retouch-dialog-slider]`;
const dialogImage = `${compareDialog} img[data-retouch-dialog-image]`;
const dialogOriginal = `${compareDialog} img[data-retouch-dialog-original]`;
const red = [255, 0, 0];
const blue = [0, 0, 255];

async function selectOption(app, name, value) {
    await app.evaluate(`(() => {
        const control = ${field(name)};
        control.value = ${JSON.stringify(value)};
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
}

async function selectWorkflow(app, name) {
    const row = `.workflow-item[data-name=${JSON.stringify(name)}]`;
    await app.evaluate("document.getElementById('btn-toggle-workflow').click()");
    await app.waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`);
    await app.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
    await app.waitFor(`document.querySelector(${JSON.stringify(row)})?.classList.contains('is-active')`);
    await app.evaluate("document.getElementById('btn-close-workflow').click()");
    await app.waitFor("!document.getElementById('workflow-sidebar').classList.contains('active')");
}

async function assertAnalysisPrompt(app, expected, { selectAndCopy = false } = {}) {
    const details = `document.querySelector('${analysisDetails}')`;
    const prompt = `document.querySelector('${analysisPrompt}')`;
    const summary = `${analysisDetails} > summary`;
    await app.waitFor(`${details}?.checkVisibility()`);
    assert.equal(await app.evaluate(`${details}.open`), false, 'the generated prompt starts folded');
    await app.evaluate(`document.querySelector('${summary}').scrollIntoView({ block: 'nearest' })`);
    await nativeClick(app, summary);
    await app.waitFor(`${prompt}.checkVisibility()`);
    assert.equal(await app.evaluate(`${prompt}.textContent`), expected);
    if (selectAndCopy) {
        const { start, end } = await app.evaluate(`(() => {
            const text = ${prompt};
            text.scrollIntoView({ block: 'nearest' });
            const range = document.createRange();
            range.selectNodeContents(text);
            const { left, right, top, height } = range.getBoundingClientRect();
            const y = top + height / 2;
            return { start: { x: left + 1, y }, end: { x: right - 1, y } };
        })()`);
        await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
        await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
        assert.equal(await app.evaluate('window.getSelection().toString()'), expected, 'the displayed prompt supports pointer text selection');
        await app.evaluate(`document.querySelector('${copyAnalysis}').scrollIntoView({ block: 'nearest' })`);
        await nativeClick(app, copyAnalysis);
        await app.waitFor('copiedAnalysis.length === 1');
        assert.deepEqual(await app.evaluate('copiedAnalysis'), [expected]);
        await app.waitFor(`document.querySelector('${panel} [data-retouch-analysis-copy-status]').textContent === '已复制'`);
    }
    await app.evaluate(`document.querySelector('${summary}').scrollIntoView({ block: 'nearest' })`);
    await nativeClick(app, summary);
    await app.waitFor(`!${details}.open`);
}

const outputIsBlue = selector => `(() => {
    const image = document.querySelector(${JSON.stringify(selector)});
    if (!image?.checkVisibility() || !image.complete || !image.naturalWidth) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return red === 0 && green === 0 && blue === 255;
})()`;

async function sampleRenderedImageColors(app, selector) {
    const points = await app.evaluate(`(() => {
        const image = document.querySelector(${JSON.stringify(selector)});
        const { x, y, width, height } = image.getBoundingClientRect();
        return [0.25, 0.75].map(position => [Math.round(x + width * position), Math.round(y + height * 0.45)]);
    })()`);
    await app.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const { data } = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return app.evaluate(`(async () => {
        const snapshot = await (await fetch('data:image/png;base64,${data}')).blob();
        const image = await createImageBitmap(snapshot);
        const canvas = new OffscreenCanvas(2, 1);
        const context = canvas.getContext('2d');
        return ${JSON.stringify(points)}.map(([x, y], index) => {
            context.drawImage(image, x, y, 1, 1, index, 0, 1, 1);
            return [...context.getImageData(index, 0, 1, 1).data].slice(0, 3);
        });
    })()`);
}

function assertRenderedColor(pixels, color) {
    for (const pixel of pixels) {
        assert.ok(pixel.every((channel, index) => Math.abs(channel - color[index]) <= 8),
            `expected ${pixel} to show fixture color ${color}`);
    }
}

async function openComparison(app) {
    await app.waitFor(`document.querySelector('${inspect}')?.textContent.trim() === '查看对照'
        && document.querySelector('${inspect}').getAttribute('aria-disabled') === 'false'`);
    await nativeClick(app, inspect);
    await waitForComparison(app);
}

async function waitForComparison(app) {
    await app.waitFor(`document.querySelector('${dialogFrame}')?.checkVisibility()
        && getComputedStyle(document.querySelector('${compareDialog}')).opacity === '1'`);
}

async function closeComparison(app, trigger = inspect) {
    await key(app, 'Escape');
    await app.waitFor(`!document.querySelector('${compareDialog}') && document.activeElement.matches('${trigger}')`);
}

async function comparisonImageColors(app, view) {
    const image = view === 'original' ? dialogOriginal : dialogImage;
    await nativeClick(app, `${compareDialog} [data-retouch-view=${view}]`);
    await app.waitFor(`(() => {
        const image = document.querySelector('${image}');
        return image?.checkVisibility() && image.complete && image.naturalWidth;
    })()`);
    return sampleRenderedImageColors(app, image);
}

async function dragComparisonDivider(app, slider, { marker = slider, frame = slider, gripOffset = 0, target = 0.72 } = {}) {
    const { x, y, endX } = await app.evaluate(`(() => {
        const handle = document.querySelector('${marker}').getBoundingClientRect();
        const { left, width } = document.querySelector('${frame}').getBoundingClientRect();
        return { x: handle.x + handle.width / 2 + ${gripOffset}, y: handle.y + handle.height / 2, endX: left + width * ${target} };
    })()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y, button: 'left', clickCount: 1 });
    return Number(await app.evaluate(`document.querySelector('${slider}').value`));
}

function pointOnCardPreview(app) {
    return app.evaluate(`(() => {
        const { x, y, width, height } = document.querySelector('${cardPreview}').getBoundingClientRect();
        return { x: x + width * 0.4, y: y + height * 0.25 };
    })()`);
}

async function clickCardPreview(app, count = 1, point = null) {
    point ??= await pointOnCardPreview(app);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await app.waitFor(`document.querySelector('${cardPreview}').contains(document.elementFromPoint(${point.x}, ${point.y}))`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: count });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: count });
}

async function openCardPreview(app) {
    await clickCardPreview(app);
    await clickCardPreview(app, 2);
    await waitForComparison(app);
}

async function clickNearCompareHandle(app, horizontalOffset) {
    const point = await app.evaluate(`(() => {
        const { x, y, width, height } = document.querySelector('${compareHandle}').getBoundingClientRect();
        return { x: x + width / 2 + ${horizontalOffset}, y: y + height / 2 };
    })()`);
    const before = await app.evaluate(`document.querySelector('${compareSlider}').value`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), before,
        `a click ${horizontalOffset}px from the handle center does not reposition the divider`);
}

async function verifyCardPreviewInteraction(app) {
    await nativeClick(app, closeDock);
    await app.waitFor(`document.querySelector('${panel}').hidden`);
    await clickNearCompareHandle(app, 45);
    await app.waitFor(`document.querySelector('#retouch.selected') && document.querySelector('${panel}:not([hidden])[data-node-id=retouch]')`);
    assert.equal(await app.evaluate(`Boolean(document.querySelector('${compareDialog}, .fullscreen-overlay'))`), false,
        'a single click selects the retouch node without opening a preview');

    await openCardPreview(app);
    assert.equal(await app.evaluate(`document.querySelector('${compareDialog} h2').textContent.trim()`), '产品精修预览');
    await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'split'`);
    assert.equal(await app.evaluate(`document.querySelector('${dialogSlider}').value`), '50');
    assert.deepEqual(await sampleRenderedImageColors(app, dialogFrame), [red, blue]);
    assert.ok(await dragComparisonDivider(app, dialogSlider) < 40, 'the preview divider follows the pointer to the right');
    await app.evaluate(`document.querySelector('${dialogSlider}').focus()`);
    await key(app, 'Home');
    assert.deepEqual(await sampleRenderedImageColors(app, dialogFrame), [red, red]);
    await key(app, 'End');
    assert.deepEqual(await sampleRenderedImageColors(app, dialogFrame), [blue, blue]);
    await resizeViewport(app, 500, 560);
    await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'switch' &&
        document.activeElement.matches('${compareDialog} [data-retouch-view=result]')`);
    await resizeViewport(app, 1100, 820);
    await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'split'`);
    assert.equal(await app.evaluate(`document.querySelector('${dialogSlider}').value`), '100');
    await closeComparison(app, cardPreview);
    await key(app, 'Enter');
    await waitForComparison(app);
    await closeComparison(app, cardPreview);
    await app.evaluate(`document.querySelector('${cardPreview}').click()`);
    await waitForComparison(app);
    await closeComparison(app, cardPreview);
}

const widthOfDock = `Math.round(document.querySelector('${panel}').getBoundingClientRect().width)`;
const comparisonMode = `document.querySelector('${compareStage}').dataset.comparison`;
const resizeViewport = (app, width, height) => app.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

function retouchPosition(app) {
    return app.evaluate(`(() => {
        const { left, top } = document.getElementById('retouch').getBoundingClientRect();
        return { left, top };
    })()`);
}

async function moveRetouchNode(app, position) {
    const original = await retouchPosition(app);
    const from = await app.evaluate(`(() => {
        const title = document.querySelector('#retouch .node-title');
        const { x, y, width, height } = title.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
    })()`);
    const to = { x: from.x + position.left - original.left, y: from.y + position.top - original.top };
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await app.waitFor(`document.elementFromPoint(${from.x}, ${from.y})?.closest('#retouch .node-title')`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
    await app.waitFor(`(() => {
        const { left, top } = document.getElementById('retouch').getBoundingClientRect();
        return Math.abs(left - ${position.left}) <= 1 && Math.abs(top - ${position.top}) <= 1;
    })()`);
}

async function verifyDoubleClickNearDock(app) {
    const original = await retouchPosition(app);
    const dockEdge = await app.evaluate(`document.querySelector('${panel}').getBoundingClientRect().left`);
    await nativeClick(app, closeDock);
    await moveRetouchNode(app, { left: 750, top: 455 });

    const point = await pointOnCardPreview(app);
    assert.ok(point.x > dockEdge, 'opening the dock would cover the click position');
    await clickCardPreview(app, 1, point);
    await app.waitFor(`document.querySelector('${panel}:not([hidden])[data-node-id=retouch]')?.getBoundingClientRect().left < ${point.x}`);
    assert.equal(await app.evaluate(`Boolean(document.querySelector('${compareDialog}'))`), false,
        'one click alone eventually opens only the dock');
    await nativeClick(app, closeDock);

    await clickCardPreview(app, 1, point);
    assert.deepEqual(await app.evaluate(`({
        selected: document.getElementById('retouch').classList.contains('selected'),
        dockClosed: document.querySelector('${panel}').hidden,
        previewClosed: !document.querySelector('${compareDialog}')
    })`), { selected: true, dockClosed: true, previewClosed: true });
    await clickCardPreview(app, 2, point);
    await waitForComparison(app);
    await app.waitFor(`document.querySelector('${panel}:not([hidden])[data-node-id=retouch]')?.getBoundingClientRect().left < ${point.x}`);
    await closeComparison(app, inspect);

    await nativeClick(app, closeDock);
    await moveRetouchNode(app, original);
    await openParameters(app, 'retouch');
}

async function assertDockLayout(app) {
    const layout = await app.evaluate(`(() => {
        const dock = document.querySelector('${panel}');
        const { left, right } = dock.getBoundingClientRect();
        const canvas = document.getElementById('canvas-container').getBoundingClientRect();
        const scroll = dock.querySelector('.image-parameter-scroll');
        const actions = [document.querySelector('${inspect}'), ${runButton}];
        return { mode: dock.dataset.mode, touchesCanvas: Math.abs(canvas.right - left) < 1,
            touchesWindow: Math.abs(right - innerWidth) < 1,
            footerFits: actions.every(action => {
                const bounds = action.getBoundingClientRect();
                return action.checkVisibility() && !scroll.contains(action) && bounds.left >= left && bounds.right <= right && bounds.bottom <= innerHeight;
            }) };
    })()`);
    assert.deepEqual(layout, { mode: 'docked', touchesCanvas: true, touchesWindow: true, footerFits: true });
}

async function dragDockToCoverPartOfCard(app, beforeRelease) {
    const { start, end } = await app.evaluate(`(() => {
        const handle = document.querySelector('${dockWidthHandle}').getBoundingClientRect();
        const card = document.querySelector('${compareStage}').getBoundingClientRect();
        return { start: { x: handle.left + handle.width / 2, y: handle.top + handle.height / 2 },
            end: { x: card.left + card.width * 0.55, y: handle.top + handle.height / 2 } };
    })()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await app.waitFor(`document.querySelector('${dockWidthHandle}').contains(document.elementFromPoint(${start.x}, ${start.y}))`);
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
    assert.ok(await app.evaluate(`(() => {
        const card = document.querySelector('${compareStage}').getBoundingClientRect();
        const dockLeft = document.querySelector('${panel}').getBoundingClientRect().left;
        return dockLeft > card.left + 40 && dockLeft < card.right - 40;
    })()`), 'dragging the dock creates real partial occlusion at desktop width');
    await beforeRelease?.();
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
}

async function zoomCanvas(app, zoom) {
    await nativeClick(app, '#canvas-navigation .canvas-zoom-menu summary');
    await nativeClick(app, `#canvas-navigation [data-zoom="${zoom}"]`);
    await app.waitFor(`document.querySelector('#zoom-level').textContent.trim() === '${zoom * 100}%'`);
}

async function exerciseDockWidth(app) {
    const initialWidth = await app.evaluate(widthOfDock);
    const sliderValue = await app.evaluate(`document.querySelector('${compareSlider}').value`);
    await dragDockToCoverPartOfCard(app, () => key(app, 'Escape'));
    await app.waitFor(`${widthOfDock} === ${initialWidth} && ${comparisonMode} === 'split'`);
    await dragDockToCoverPartOfCard(app, async () => {
        await resizeViewport(app, 500, 360);
        await app.waitFor(`innerWidth === 500 && !document.querySelector('${panel}').classList.contains('is-resizing')`);
    });
    await resizeViewport(app, 1100, 820);
    await app.waitFor(`${widthOfDock} === ${initialWidth} && ${comparisonMode} === 'split'`);
    await assertDockLayout(app);
    await dragDockToCoverPartOfCard(app);
    const draggedWidth = await app.evaluate(widthOfDock);
    assert.ok(draggedWidth > initialWidth + 80, 'dragging the left edge outward widens the dock');
    await app.waitFor(`${comparisonMode} === 'switch'`);
    assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').checkVisibility()`), false);
    await assertDockLayout(app);
    await openComparison(app);
    assert.equal(await app.evaluate(`document.querySelector('${dialogSlider}').value`), sliderValue);
    await closeComparison(app);

    await nativeClick(app, closeDock);
    await app.waitFor(`${comparisonMode} === 'split'`);
    await openParameters(app, 'retouch');
    await app.waitFor(`${widthOfDock} === ${draggedWidth} && ${comparisonMode} === 'switch'`);
    await app.evaluate(`document.querySelector('${dockWidthHandle}').focus()`);
    await key(app, 'ArrowRight');
    const keyboardWidth = draggedWidth - 10;
    await app.waitFor(`${widthOfDock} === ${keyboardWidth}`);
    assert.equal(await app.evaluate(`Number(document.querySelector('${dockWidthHandle}').getAttribute('aria-valuenow'))`), keyboardWidth);

    await resizeViewport(app, 620, 560);
    await app.waitFor(`innerWidth === 620 && ${widthOfDock} < ${keyboardWidth}`);
    await assertDockLayout(app);
    await resizeViewport(app, 1100, 820);
    await app.waitFor(`innerWidth === 1100 && ${widthOfDock} === ${keyboardWidth}`);

    await app.evaluate(`document.querySelector('${dockWidthHandle}').focus()`);
    await key(app, 'Home');
    await app.waitFor(`${widthOfDock} < ${initialWidth} && ${comparisonMode} === 'split'`);
    await app.evaluate(`document.querySelector('${compareSlider}').focus()`);
    await resizeViewport(app, 500, 360);
    await app.waitFor(`innerWidth === 500 && ${comparisonMode} === 'switch'
        && document.querySelector('${dockWidthHandle}').getAttribute('aria-disabled') === 'true'`);
    assert.equal(await app.evaluate(`document.activeElement.matches('${inspect}')`), true,
        'when the focused slider is clipped, focus moves to the comparison entry in the dock');
    await assertDockLayout(app);
    await resizeViewport(app, 1100, 820);
    await app.waitFor(`${comparisonMode} === 'split'`);
    await zoomCanvas(app, 0.25);
    await app.waitFor(`${comparisonMode} === 'switch'`);
    assert.ok(await app.evaluate(`document.querySelector('${compareStage}').getBoundingClientRect().width < 180`), 'zoom out actually shrinks the comparison card');
    await zoomCanvas(app, 1);
    await app.waitFor(`${comparisonMode} === 'split'`);
    assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), sliderValue);

    const toggleAgent = () => app.evaluate("document.getElementById('btn-prompt-agent').click()");
    const agent = "document.getElementById('prompt-agent-panel')";
    await toggleAgent();
    await app.waitFor(`${agent}.classList.contains('active') && ${comparisonMode} === 'switch'`);
    assert.ok(await app.evaluate(`(() => {
        const stage = document.querySelector('${compareStage}').getBoundingClientRect();
        const canvas = document.getElementById('canvas-container').getBoundingClientRect();
        const panel = ${agent}.getBoundingClientRect();
        return stage.right <= canvas.right && stage.right > panel.left && stage.left < panel.right;
    })()`), 'Agent hides the comparison even though it still fits inside the canvas');
    await assertDockLayout(app);
    await toggleAgent();
    await app.waitFor(`${comparisonMode} === 'split'`);
    await resizeViewport(app, 850, 820);
    await app.waitFor('innerWidth === 850');
    await app.evaluate(`document.querySelector('${dockWidthHandle}').focus()`);
    await key(app, 'End');
    const widest = await app.evaluate(widthOfDock);
    await toggleAgent();
    await app.waitFor(`${widthOfDock} < ${widest} && ${agent}.getBoundingClientRect().width >= 320`);
    await toggleAgent();
    await app.waitFor(`${widthOfDock} === ${widest}`);
    await resizeViewport(app, 1100, 820);
    await app.waitFor('innerWidth === 1100');
    await app.evaluate(`document.querySelector('${dockWidthHandle}').focus()`);
    await key(app, 'Home');
    await app.waitFor(`${comparisonMode} === 'split'`);
    return app.evaluate(widthOfDock);
}

test('product retouch analyzes and edits the same original in one run and preserves its downstream result', { timeout: 60000 }, async () => {
    const source = (await readFile(new URL('./fixtures/reference-red.png', import.meta.url))).toString('base64');
    const replacement = (await readFile(new URL('./fixtures/reference-orange.png', import.meta.url))).toString('base64');
    const result = (await readFile(new URL('./fixtures/reference-blue.png', import.meta.url))).toString('base64');
    const advice = { adjustments: [{ area: '杯身正面', edit: '清理右侧污点' }] };
    const advicePrompt = '杯身正面：清理右侧污点';
    const replacementAdvice = { adjustments: [{ area: '杯身底部', edit: '轻擦一处指纹' }] };
    const replacementPrompt = '杯身底部：轻擦一处指纹';
    const workflowId = 'retouch-fixture';
    const workflowName = '商品精修';
    const otherWorkflow = { workflowId: 'retouch-other', nodes: [{ id: 'retouch', type: 'ProductRetouch', x: 350, y: 110 }], connections: [] };
    const nodes = [
        { id: 'retouch', type: 'ProductRetouch', x: 350, y: 110 },
        { id: 'result', type: 'ImagePreview', x: 740, y: 110 },
        { id: 'retouch-clone', type: 'ProductRetouch', x: 350, y: 500, isClone: true, cloneSourceId: 'retouch' }
    ];
    const connections = [
        { id: 'output', from: { nodeId: 'retouch', port: 'image' }, to: { nodeId: 'result', port: 'image' }, type: 'image' }
    ];
    const initScript = `window.retouchRequests = [];
        window.analysisRequests = [];
        window.copiedAnalysis = [];
        Object.defineProperty(navigator.clipboard, 'writeText', { value: async text => {
            if (window.rejectClipboard) throw new Error('Fixture clipboard permission denied');
            window.copiedAnalysis.push(text);
        } });
        const nativeExecCommand = document.execCommand.bind(document);
        document.execCommand = (command, ...args) => {
            if (command !== 'copy' || !window.rejectClipboard) return nativeExecCommand(command, ...args);
            const field = document.activeElement;
            if (field?.tagName !== 'TEXTAREA' || field.selectionStart === field.selectionEnd) return false;
            window.copiedAnalysis.push(field.value.slice(field.selectionStart, field.selectionEnd));
            return true;
        };
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (url, options) => {
            if (url === '/api/storage/media-assets' && options?.method === 'PUT' && window.rejectUpload) {
                return Response.json({ error: 'Fixture upload failure' }, { status: 500 });
            }
            if (url !== '/proxy') return originalFetch(url, options);
            const body = options?.body;
            const urlHeader = new Headers(options.headers).get('x-target-url-b64');
            if (!(body instanceof FormData)) {
                const { messages, model } = JSON.parse(body || '{}');
                const content = messages?.findLast(message => message.role === 'user')?.content;
                if (!Array.isArray(content)) {
                    return Response.json({ error: { message: 'Expected a multimodal vision analysis request' } }, { status: 400 });
                }
                const references = content.filter(part => part.type === 'image_url').map(part => part.image_url.url);
                window.analysisRequests.push({ model, references, urlHeader });
                if (window.holdAnalysis) await new Promise(resolve => { window.releaseAnalysis = resolve; });
                const advice = window.emptyAnalysis ? { adjustments: [] }
                    : references[0] === ${JSON.stringify(`data:image/png;base64,${replacement}`)} ? ${JSON.stringify(replacementAdvice)} : ${JSON.stringify(advice)};
                return Response.json({ choices: [{ message: { content: JSON.stringify(advice) } }] });
            }
            const images = [...body].filter(([key]) => key === 'image' || key === 'image[]');
            const references = await Promise.all(images.map(async ([, file]) =>
                btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))));
            window.retouchRequests.push({ references, prompt: body.get('prompt'), model: body.get('model'), urlHeader });
            if (window.holdEdit) await new Promise(resolve => { window.releaseEdit = resolve; });
            if (window.rejectRetouch) {
                await new Promise(resolve => { window.releaseFailedRetouch = resolve; });
                return Response.json({ data: [{ b64_json: 'YnJva2Vu' }] });
            }
            if (window.wideRetouch) {
                const canvas = document.createElement('canvas');
                canvas.width = 48;
                canvas.height = 24;
                const context = canvas.getContext('2d');
                context.fillStyle = '#0000ff';
                context.fillRect(0, 0, 48, 24);
                return Response.json({ data: [{ b64_json: canvas.toDataURL('image/png').split(',')[1] }] });
            }
            return Response.json({ data: [{ b64_json: ${JSON.stringify(result)} }] });
        };`;

    await withAppBrowser({
        autoCheckUpdatesOnLoad: false, autoRetry: false, nodes, connections,
        activeWorkflowId: workflowId, activeWorkflowName: workflowName,
        workflowTabs: [{ workflowId, name: workflowName, data: { workflowId, nodes, connections } }],
        models: [
            { id: 'vision', modelId: 'gpt-4.1-mini', name: '受控视觉分析模型', taskType: 'chat', protocol: 'openai', providerIds: ['fallback', 'vision-p'] },
            { id: 'text-only', modelId: 'gpt-3.5-turbo', name: '纯文字模型', taskType: 'chat', protocol: 'openai', providerIds: ['text-only-p'] },
            { id: 'image', modelId: 'gpt-image-1', name: '受控精修模型', taskType: 'image', protocol: 'openai', providerIds: ['fallback', 'p'] },
            { id: 'generate-only', modelId: 'dall-e-3', name: '仅生图模型', taskType: 'image', protocol: 'openai', providerIds: ['p'] }
        ],
        providers: [
            { id: 'fallback', name: '备用供应商', endpoint: 'https://fallback.fixture.test/v1', apikey: 'test' },
            { id: 'vision-p', name: '视觉分析供应商', endpoint: 'https://vision.fixture.test/v1', apikey: 'test' },
            { id: 'text-only-p', name: '纯文字供应商', endpoint: 'https://api.openai.com/v1', apikey: 'test' },
            { id: 'p', name: '图像编辑供应商', endpoint: 'https://fixture.test/v1', apikey: 'test' }
        ]
    }, async app => {
        assert.equal(await app.evaluate(`fetch('/api/workflows/' + encodeURIComponent('另一工作流'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(otherWorkflow)})
        }).then(response => response.ok)`), true);
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(`document.querySelector('${panel}').dataset.mode`), 'docked');
        assert.equal(await app.evaluate(`${background('white')}.checked`), true);
        assert.equal(await app.evaluate(`${runButton}.disabled`), true);
        assert.equal(await app.evaluate(`${field('modelId')}.querySelector('option[value=generate-only]') === null`), true);
        assert.equal(await app.evaluate(`${field('analysisModelId')}.querySelector('option[value=text-only]') === null`), true);

        await app.evaluate(`${background('black')}.click()`);
        await selectOption(app, 'finish', 'polished');
        const uploadReference = () => app.evaluate(`(async () => {
                const image = await (await fetch('data:image/png;base64,${source}')).blob();
                const files = new DataTransfer();
                files.items.add(new File([image], 'product.png', { type: 'image/png' }));
                const upload = document.querySelector('${panel} input[data-retouch-upload]');
                upload.files = files.files;
                upload.dispatchEvent(new Event('change', { bubbles: true }));
            })()`);
        const status = `document.querySelector('${panel} .product-retouch-footer [role=status]')`;
        await app.evaluate('window.rejectUpload = true');
        await uploadReference();
        await app.waitFor(`${status}.textContent.includes('参考图保存失败')`);
        assert.equal(await app.evaluate(`document.querySelector('${panel} [data-retouch-action=upload]').checkVisibility()`), true);
        assert.equal(await app.evaluate(`${runButton}.disabled`), true);
        await app.evaluate('window.rejectUpload = false');
        await app.step('从产品精修节点重新上传商品参考图', async () => {
            await uploadReference();
            await app.waitFor(`fetch('/api/storage/documents/session').then(r => r.json()).then(({ value }) => {
                const reference = value.connections.find(edge => edge.to.nodeId === 'retouch' && edge.to.port === 'image');
                const source = value.nodes.find(node => node.id === reference?.from.nodeId && node.type === 'ImageImport');
                return reference?.from.port === 'image' && source?.mediaAssetKeys?.length === 1;
            })`, 7500, { interval: 200 });
        }, { failOnRequests: ['/api/storage/media-assets', '/api/storage/documents/session'] });
        await openParameters(app, 'retouch');
        assert.equal(await app.evaluate(`${runButton}.disabled`), true, 'an original alone cannot run without model configurations');
        await selectOption(app, 'modelId', 'image');
        await selectOption(app, 'providerId', 'p');
        assert.equal(await app.evaluate(`${runButton}.disabled`), true, 'retouch requires the vision configuration too');
        assert.deepEqual(await app.evaluate('[analysisRequests.length, retouchRequests.length]'), [0, 0]);
        await selectOption(app, 'analysisModelId', 'vision');
        await selectOption(app, 'analysisProviderId', 'vision-p');
        await app.waitFor(`${runButton}.checkVisibility() && !${runButton}.disabled`);
        await waitForAutosave(app);
        await app.evaluate('window.holdAnalysis = true; window.holdEdit = true');
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor(`typeof window.releaseAnalysis === 'function' && ${status}.textContent.includes('正在分析商品参考图')`);
        assert.match(await app.evaluate(`${runButton}.textContent`), /分析中/);
        assert.deepEqual(await app.evaluate('[analysisRequests.length, retouchRequests.length]'), [1, 0],
            'a single run waits for vision analysis before sending the image edit');
        const [analysis] = await app.evaluate('analysisRequests');
        assert.equal(analysis.model, 'gpt-4.1-mini');
        assert.deepEqual(analysis.references, [`data:image/png;base64,${source}`]);
        assert.equal(Buffer.from(analysis.urlHeader, 'base64url').toString(), 'https://vision.fixture.test/v1/chat/completions');
        await selectWorkflow(app, '另一工作流');
        await openParameters(app, 'retouch');
        await app.evaluate('window.holdAnalysis = false; window.releaseAnalysis()');
        await app.waitFor("typeof window.releaseEdit === 'function'");
        assert.equal(await app.evaluate(`document.querySelector('${analysisDetails}').checkVisibility()`), false,
            'background analysis is isolated from a same-ID node in the visible workflow');
        await selectWorkflow(app, workflowName);
        await openParameters(app, 'retouch');
        await app.waitFor(`${status}.textContent.includes('正在精修商品图')`);
        assert.match(await app.evaluate(`${runButton}.textContent`), /精修中/);
        const [request] = await app.evaluate('retouchRequests');
        assert.deepEqual(request.references, [source]);
        assert.equal(request.model, 'gpt-image-1');
        assert.equal(Buffer.from(request.urlHeader, 'base64url').toString(), 'https://fixture.test/v1/images/edits');
        assert.match(request.prompt, /背景[^。]*纯黑|黑(?:色背景|底)/);
        assert.match(request.prompt, /抛光/);
        assert.ok(request.prompt.includes(advicePrompt), 'the image edit uses the advice produced by analysis');
        await assertAnalysisPrompt(app, advicePrompt, { selectAndCopy: true });
        await app.evaluate('window.holdEdit = false; window.releaseEdit()');

        const cardResult = '#retouch .product-retouch-card img';
        const downstreamResult = '#result-preview img';
        await app.waitFor(outputIsBlue(cardResult));
        await app.waitFor(outputIsBlue(downstreamResult));
        assert.equal(await app.evaluate('analysisRequests.length'), 1);
        assert.equal(await app.evaluate('retouchRequests.length'), 1);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'split'
            && Array.from(document.querySelectorAll('${compareStage} img')).filter(image => image.complete && image.naturalWidth).length === 2`);
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '50');
        assert.equal(await app.evaluate(`document.querySelector('${compareStage} .product-retouch-compare-labels span:last-child').textContent.trim()`), '精修');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, blue]);
        await verifyCardPreviewInteraction(app);
        await verifyDoubleClickNearDock(app);
        await app.waitFor(`${comparisonMode} === 'split'`);
        await clickNearCompareHandle(app, 6);
        await zoomCanvas(app, 0.75);
        await app.waitFor(`${comparisonMode} === 'split'`);
        assert.ok(await app.evaluate(`(() => {
            const { x, y, width, height } = document.querySelector('${compareHandle}').getBoundingClientRect();
            const hitCenter = document.elementFromPoint(x + width / 2, y + height / 2);
            const hitCorner = document.elementFromPoint(x + 1, y + 1);
            return width >= 23 && width <= 25 && hitCenter.matches('${compareSlider}') && hitCorner.closest('${cardPreview}');
        })()`), 'at 75% zoom, only the circle intercepts the pointer at its center and bounding-box corner');
        const canvasDivider = { marker: compareHandle, frame: compareStage };
        assert.ok(await dragComparisonDivider(app, compareSlider, canvasDivider) < 40, 'the canvas divider follows the visible handle');
        await zoomCanvas(app, 1);
        await app.waitFor(`${comparisonMode} === 'split'`);
        await app.evaluate(`document.querySelector('${compareSlider}').focus()`);
        await key(app, 'Home');
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '0');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, red]);
        const fromOriginal = await dragComparisonDivider(app, compareSlider, { ...canvasDivider, gripOffset: -6, target: 0.5 });
        assert.ok(fromOriginal >= 40 && fromOriginal <= 60, 'the in-frame portion of the original endpoint handle remains draggable');
        await key(app, 'End');
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').value`), '100');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [blue, blue]);
        const fromRetouch = await dragComparisonDivider(app, compareSlider, { ...canvasDivider, gripOffset: 6, target: 0.5 });
        assert.ok(fromRetouch >= 40 && fromRetouch <= 60, 'the in-frame portion of the retouch endpoint handle remains draggable');
        await key(app, 'End');
        const savedDockWidth = await exerciseDockWidth(app);

        const sourceId = (await saved(app)).connections.find(edge => edge.to.nodeId === 'retouch' && edge.to.port === 'image').from.nodeId;
        await uploadImageOriginal(app, sourceId, `data:image/png;base64,${replacement}`);
        await openParameters(app, 'retouch');

        await app.evaluate('window.rejectRetouch = true');
        await app.waitFor(`!${runButton}.disabled`);
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor('typeof window.releaseFailedRetouch === "function"');
        await openComparison(app);
        await app.evaluate('window.releaseFailedRetouch()');
        await app.waitFor(`${status}.textContent.includes('已保留上次结果')`);
        assert.equal(await app.evaluate('analysisRequests.length'), 2);
        assert.deepEqual(await app.evaluate('analysisRequests[1].references'), [`data:image/png;base64,${replacement}`]);
        assert.equal(await app.evaluate('retouchRequests.length'), 2);
        assert.deepEqual(await app.evaluate('retouchRequests[1].references'), [replacement]);
        assert.equal(await app.evaluate(outputIsBlue(cardResult)), true);
        assert.equal(await app.evaluate(outputIsBlue(downstreamResult)), true);
        await app.waitFor("document.getElementById('modal-error').checkVisibility()");
        await key(app, 'Escape');
        await app.waitFor("!document.getElementById('modal-error').checkVisibility()");
        assert.equal(await app.evaluate(`document.querySelector('${compareDialog}').inert`), false, 'closing the provider error restores the underlying comparison');
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red], 'a failed rerun must keep the last successfully paired original');
        await closeComparison(app);

        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        await app.waitFor(`${widthOfDock} === ${savedDockWidth}`);
        assert.equal(await app.evaluate(`${background('black')}.checked`), true);
        assert.equal(await app.evaluate(`${field('finish')}.value`), 'polished');
        assert.equal(await app.evaluate(`${field('modelId')}.value`), 'image');
        assert.equal(await app.evaluate(`${field('providerId')}.value`), 'p');
        assert.equal(await app.evaluate(`${field('analysisModelId')}.value`), 'vision');
        assert.equal(await app.evaluate(`${field('analysisProviderId')}.value`), 'vision-p');
        await app.waitFor(outputIsBlue(cardResult));
        await app.waitFor(outputIsBlue(downstreamResult));
        assert.deepEqual(await app.evaluate('[analysisRequests.length, retouchRequests.length]'), [0, 0]);
        await assertAnalysisPrompt(app, replacementPrompt);
        const workflow = await saved(app);
        const resultKeys = id => workflow.nodes.find(node => node.id === id)?.mediaAssetKeys;
        assert.equal(resultKeys('retouch')?.length, 1, 'the original is a comparison asset outside the node output');
        assert.deepEqual(resultKeys('result'), resultKeys('retouch'), 'the downstream preview receives only the processed result');

        await resizeViewport(app, 500, 560);
        await app.waitFor(`innerWidth === 500 && ${widthOfDock} <= 260`);
        await app.evaluate(`document.querySelector('${analysisDetails} > summary').scrollIntoView({ block: 'center' })`);
        await app.evaluate('window.rejectClipboard = true');
        await nativeClick(app, copyAnalysis);
        await app.waitFor('copiedAnalysis.length === 1');
        assert.deepEqual(await app.evaluate('copiedAnalysis'), [replacementPrompt]);
        assert.equal(await app.evaluate(`document.querySelector('${analysisDetails}').open`), false, 'fallback copy works in a narrow folded pane');
        await openComparison(app);
        await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'switch'
            && !document.querySelector('${dialogSlider}').checkVisibility()`);
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red]);
        assert.deepEqual(await comparisonImageColors(app, 'result'), [blue, blue]);
        await closeComparison(app);
        await resizeViewport(app, 620, 560);
        await nativeClick(app, `${panel} [data-parameter-action=close]`);
        const originalToggle = '#retouch [data-retouch-card-view=original]';
        const resultToggle = '#retouch [data-retouch-card-view=result]';
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').checkVisibility()`), false);
        await nativeClick(app, originalToggle);
        assertRenderedColor(await sampleRenderedImageColors(app, compareStage), red);
        await nativeClick(app, resultToggle);
        assertRenderedColor(await sampleRenderedImageColors(app, compareStage), blue);
        await resizeViewport(app, 1100, 820);

        const originalAssetKey = workflow.nodes.find(node => node.id === 'retouch').productRetouchComparison.originalAssetKey;
        const blockedOriginal = [`*/api/storage/assets/${encodeURIComponent(originalAssetKey)}*`];
        await app.send('Network.setCacheDisabled', { cacheDisabled: true });
        await openParameters(app, 'retouch');
        await app.send('Network.setBlockedURLs', { urls: blockedOriginal });
        await openComparison(app);
        const originalTab = `${compareDialog} [data-retouch-view=original]`;
        const dialogError = `document.querySelector('${compareDialog} [role=status]')`;
        const openBigImage = `document.querySelector('${compareDialog} [data-retouch-open-image]')`;
        const failedImageState = `${dialogError}.checkVisibility() && ${dialogError}.textContent.includes('无法读取') && ${openBigImage}.disabled`;
        await nativeClick(app, originalTab);
        await app.waitFor(failedImageState);
        await nativeClick(app, originalTab);
        assert.equal(await app.evaluate(failedImageState), true,
            'reselecting a failed image must keep the error and prevent a broken fullscreen view');
        await closeComparison(app);
        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        const comparisonHint = `${panel} [data-retouch-comparison-status]`;
        await app.waitFor(`document.querySelector('${comparisonHint}').checkVisibility()`);
        assert.equal(await app.evaluate(`document.querySelector('${inspect}').textContent.trim()`), '查看精修结果');
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [blue, blue]);
        await openCardPreview(app);
        await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'switch'`);
        assert.deepEqual(await sampleRenderedImageColors(app, dialogImage), [blue, blue]);
        await closeComparison(app, cardPreview);
        await app.send('Network.setBlockedURLs', { urls: [] });
        await nativeClick(app, `${panel} [data-retouch-retry-original]`);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'split'`);
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, blue]);
        await openComparison(app);
        assert.deepEqual(await comparisonImageColors(app, 'original'), [red, red]);
        await closeComparison(app);

        const blockedResult = [`*/api/storage/assets/${encodeURIComponent(resultKeys('retouch')[0])}*`];
        const retryResult = `${panel} [data-retouch-retry-result]`;
        await app.send('Network.setBlockedURLs', { urls: blockedResult });
        await reloadAppBrowser(app);
        await openParameters(app, 'retouch');
        await app.waitFor(`document.querySelector('#retouch [data-retouch-result-unavailable]').checkVisibility()
            && document.querySelector('${retryResult}').checkVisibility()`);
        assert.equal(await app.evaluate(`document.querySelector('${inspect}').checkVisibility()`), false);
        await app.send('Network.setBlockedURLs', { urls: [] });
        await nativeClick(app, retryResult);
        await app.waitFor(`${comparisonMode} === 'split'`);
        assert.deepEqual(await sampleRenderedImageColors(app, compareStage), [red, blue]);

        await app.evaluate('window.wideRetouch = true; window.emptyAnalysis = true');
        await nativeClick(app, `${panel} [data-retouch-action=run]`);
        await app.waitFor(`document.querySelector('${compareStage}').dataset.comparison === 'switch'`);
        assert.equal(await app.evaluate(`document.querySelector('${compareSlider}').checkVisibility()`), false);
        await nativeClick(app, originalToggle);
        assert.deepEqual(await app.evaluate(`(() => {
            const original = document.querySelector('${compareStage} [data-retouch-original]');
            const result = document.querySelector('${compareStage} [data-retouch-result]');
            return [original.naturalWidth / original.naturalHeight, result.naturalWidth / result.naturalHeight,
                getComputedStyle(original).objectFit, getComputedStyle(result).clipPath];
        })()`), [4 / 3, 2, 'contain', 'inset(0px 0px 0px 100%)']);
        await openComparison(app);
        await app.waitFor(`document.querySelector('${dialogFrame}').dataset.comparison === 'switch'
            && !document.querySelector('${dialogSlider}').checkVisibility()`);
        await closeComparison(app);

        const emptyAnalysis = `${analysisDetails} [data-retouch-analysis-empty]`;
        await app.evaluate(`document.querySelector('${analysisDetails}').scrollIntoView({ block: 'nearest' })`);
        await nativeClick(app, `${analysisDetails} summary`);
        await app.waitFor(`document.querySelector('${emptyAnalysis}').checkVisibility()`);
        assert.equal(await app.evaluate(`document.querySelector('${copyAnalysis}').checkVisibility()`), false,
            'a valid analysis without localized advice remains visible and offers no empty copy');

        await openParameters(app, 'retouch-clone');
        assert.equal(await app.evaluate(`${background('black')}.checked && ${background('black')}.disabled`), true);
        assert.equal(await app.evaluate(`${field('finish')}.value`), 'polished');
        assert.equal(await app.evaluate(`${field('modelId')}.value`), 'image');
        assert.equal(await app.evaluate(`${field('analysisModelId')}.value`), 'vision');

        await app.evaluate(`document.getElementById('canvas-container').dispatchEvent(new MouseEvent('contextmenu',
            { bubbles: true, cancelable: true, clientX: 75, clientY: 380 }));`);
        const menuEntry = '#context-menu-image-nodes [data-type=ProductRetouch]';
        assert.match(await app.evaluate(`document.querySelector('${menuEntry}').textContent`), /产品精修/);
        await app.evaluate(`document.querySelector('${menuEntry}').click()`);
        await app.waitFor("document.querySelectorAll('#nodes-layer .node-product-retouch').length === 3");
    }, { initScript });
});
