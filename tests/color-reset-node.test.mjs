import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    analyzeAutoWhiteBalance,
    applyColorResetToPixels,
    mapPreviewPointToImage,
    normalizeColorResetConfig,
    sampleWhiteBalanceRegion
} from '../js/features/media/media-utils.js';
import { getNodeDefinition, hasNodeCapability, NODE_CAPABILITIES } from '../js/nodes/registry.js';
import { createNodeMarkup } from '../js/nodes/node-view-factory.js';
import { readColorResetConfig, resolveWhiteBalanceSampleSelection } from '../js/features/media/color-reset-config.js';
import { createExecutionCoreApi } from '../js/features/execution/execution-core.js';
import { createDisplayImageRenderer } from '../js/features/media/display-image-renderer.js';
import { createMediaControllerApi } from '../js/features/media/media-controller.js';
import { createClipboardControllerApi } from '../js/features/ui/clipboard-controller.js';
import {
    clearDerivedImagePreview,
    getDerivedImagePreview,
    isDerivedImagePreviewNode,
    setDerivedImagePreview
} from '../js/nodes/derived-image-preview.js';
import { serializeRuntimeNode } from '../js/features/workflow/workflow-runtime-manager.js';

function createPreviewElement(tagName = 'div') {
    const element = {
        tagName: tagName.toUpperCase(),
        children: [],
        dataset: {},
        style: { removeProperty() {} },
        attributes: new Map(),
        className: '',
        isConnected: true,
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        querySelector(selector) {
            if (selector === 'img') return this.children.find((child) => child.tagName === 'IMG') || null;
            if (selector === '.color-reset-picker-overlay') return this.children.find((child) => child.className === 'color-reset-picker-overlay') || null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.preview-placeholder') return this.children.filter((child) => child.className === 'preview-placeholder');
            return [];
        },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) || null; },
        remove() { this.parentNode.children = this.parentNode.children.filter((child) => child !== this); }
    };
    Object.defineProperty(element, 'src', {
        get() { return this.getAttribute('src'); },
        set(value) { this.setAttribute('src', value); }
    });
    return element;
}

test('ColorReset is registered with one image input and output', () => {
    const node = getNodeDefinition('ColorReset');
    assert.equal(node.title, '复位颜色');
    assert.deepEqual(node.inputs.map(({ name, type }) => ({ name, type })), [{ name: 'image', type: 'image' }]);
    assert.deepEqual(node.outputs.map(({ name, type }) => ({ name, type })), [{ name: 'image', type: 'image' }]);
});

test('node registry exposes shared media capabilities without caller-owned type lists', () => {
    assert.equal(hasNodeCapability('ColorReset', NODE_CAPABILITIES.IMAGE_RESULT), true);
    assert.equal(hasNodeCapability('ColorReset', NODE_CAPABILITIES.RECOVERABLE_IMAGE_ASSET), true);
    assert.equal(hasNodeCapability('ColorReset', NODE_CAPABILITIES.CANONICAL_IMAGES), false);
    assert.equal(hasNodeCapability('ImageMerge', NODE_CAPABILITIES.CANONICAL_IMAGES), true);
    assert.equal(hasNodeCapability('Text', NODE_CAPABILITIES.IMAGE_RESULT), false);
});

test('derived image preview protocol hides resize and color-reset storage fields', () => {
    const resize = { type: 'ImageResize', resizePreviewData: 'resize-old' };
    const colorReset = { type: 'ColorReset', colorResetPreviewData: 'color-old' };

    assert.equal(isDerivedImagePreviewNode(resize), true);
    assert.equal(isDerivedImagePreviewNode(colorReset), true);
    assert.equal(getDerivedImagePreview(resize), 'resize-old');
    assert.equal(getDerivedImagePreview(colorReset), 'color-old');

    setDerivedImagePreview(resize, 'resize-new');
    setDerivedImagePreview(colorReset, 'color-new');
    assert.equal(resize.resizePreviewData, 'resize-new');
    assert.equal(colorReset.colorResetPreviewData, 'color-new');

    clearDerivedImagePreview(resize);
    clearDerivedImagePreview(colorReset);
    assert.equal(resize.resizePreviewData, null);
    assert.equal(colorReset.colorResetPreviewData, null);
    assert.equal(isDerivedImagePreviewNode({ type: 'ImageCompare' }), false);
});

test('color reset config clamps controls and preserves zero defaults', () => {
    assert.deepEqual(normalizeColorResetConfig({ temperature: 200, tint: -300 }), {
        whiteBalanceMode: 'original', whiteBalanceGains: { r: 1, g: 1, b: 1 },
        temperature: 100, tint: -100, vibrance: 0, saturation: 0
    });
});

test('color reset config uses persisted values when controls are absent and lets rendered controls override them', () => {
    const node = {
        id: 'color-1',
        data: {
            whiteBalanceMode: 'custom',
            customWhiteBalanceGains: { r: 0.8, g: 1, b: 1.2 },
            whiteBalanceSamplePoint: { xRatio: 0.25, yRatio: 0.75 },
            whiteBalanceMessage: 'saved sample',
            temperature: 27,
            tint: -12,
            vibrance: 18,
            saturation: -9
        }
    };
    const controls = new Map([
        ['color-1-temperature', { value: '140' }],
        ['color-1-saturation', { value: '6' }]
    ]);
    const config = readColorResetConfig(node, { getElementById: (id) => controls.get(id) || null });

    assert.deepEqual(config, {
        whiteBalanceMode: 'custom',
        whiteBalanceGains: { r: 0.8, g: 1, b: 1.2 },
        samplePoint: { xRatio: 0.25, yRatio: 0.75 },
        whiteBalanceMessage: 'saved sample',
        temperature: 100,
        tint: -12,
        vibrance: 18,
        saturation: 6
    });
});

test('background ColorReset execution sends persisted adjustments through the processing pipeline', async () => {
    const received = [];
    const node = {
        id: 'background-color-reset',
        type: 'ColorReset',
        data: {
            whiteBalanceMode: 'auto',
            temperature: 31,
            tint: -14,
            vibrance: 22,
            saturation: -8
        }
    };
    const api = createExecutionCoreApi({
        state: { nodes: new Map([[node.id, node]]), connections: [], models: [], providers: [] },
        nodeConfigs: {},
        documentRef: { getElementById: () => null },
        windowRef: { requestAnimationFrame: (callback) => callback() },
        processColorResetImage: async (_source, config) => {
            received.push(config);
            return {
                dataUrl: 'data:image/png;base64,result',
                whiteBalanceGains: { r: 1, g: 1, b: 1 },
                whiteBalanceAnalysis: { status: 'applied' }
            };
        },
        restoreColorResetPreview: () => {},
        showResolutionBadge: () => {},
        saveImageAsset: async () => true,
        releaseNodeImageData: async () => false,
        refreshDependentImageResizePreviews: async () => {}
    });

    await api.executeNode(node, { image: 'data:image/png;base64,source' });

    assert.deepEqual(received, [{
        whiteBalanceMode: 'auto',
        whiteBalanceGains: { r: 1, g: 1, b: 1 },
        temperature: 31,
        tint: -14,
        vibrance: 22,
        saturation: -8,
        samplePoint: null,
        whiteBalanceMessage: ''
    }]);
});

test('background runtime snapshots preserve the complete ColorReset configuration', () => {
    const node = {
        id: 'runtime-color-reset', type: 'ColorReset', x: 0, y: 0, enabled: true,
        data: {
            whiteBalanceMode: 'custom',
            whiteBalanceGains: { r: 0.9, g: 1, b: 1.1 },
            customWhiteBalanceGains: { r: 0.8, g: 1, b: 1.2 },
            autoWhiteBalanceGains: { r: 1.1, g: 1, b: 0.9 },
            whiteBalanceSamplePoint: { xRatio: 0.2, yRatio: 0.7 },
            whiteBalanceStatus: 'applied',
            whiteBalanceMessage: 'saved sample',
            temperature: 32, tint: -11, vibrance: 17, saturation: -6
        }
    };
    const snapshot = serializeRuntimeNode(node, { getElementById: () => null, querySelectorAll: () => [] });

    assert.equal(snapshot.whiteBalanceMode, 'custom');
    assert.deepEqual(snapshot.whiteBalanceGains, { r: 0.9, g: 1, b: 1.1 });
    assert.deepEqual(snapshot.customWhiteBalanceGains, { r: 0.8, g: 1, b: 1.2 });
    assert.deepEqual(snapshot.autoWhiteBalanceGains, { r: 1.1, g: 1, b: 0.9 });
    assert.deepEqual(snapshot.whiteBalanceSamplePoint, { xRatio: 0.2, yRatio: 0.7 });
    assert.equal(snapshot.whiteBalanceStatus, 'applied');
    assert.equal(snapshot.whiteBalanceMessage, 'saved sample');
    assert.deepEqual([snapshot.temperature, snapshot.tint, snapshot.vibrance, snapshot.saturation], [32, -11, 17, -6]);
});

test('copying an unmounted ColorReset node preserves its persisted adjustments', () => {
    const node = {
        id: 'copied-color-reset',
        type: 'ColorReset',
        x: 10,
        y: 20,
        data: {
            whiteBalanceMode: 'custom',
            whiteBalanceGains: { r: 0.9, g: 1, b: 1.1 },
            customWhiteBalanceGains: { r: 0.8, g: 1, b: 1.2 },
            autoWhiteBalanceGains: { r: 1.1, g: 1, b: 0.9 },
            whiteBalanceSamplePoint: { xRatio: 0.3, yRatio: 0.6 },
            whiteBalanceStatus: 'applied',
            whiteBalanceMessage: 'saved sample',
            temperature: 28,
            tint: -13,
            vibrance: 19,
            saturation: -7
        }
    };
    const api = createClipboardControllerApi({
        state: { nodes: new Map([[node.id, node]]) },
        documentRef: { getElementById: () => null, querySelectorAll: () => [] }
    });

    const snapshot = api.serializeOneNode(node.id);

    assert.equal(snapshot.whiteBalanceMode, 'custom');
    assert.deepEqual(snapshot.customWhiteBalanceGains, { r: 0.8, g: 1, b: 1.2 });
    assert.deepEqual(snapshot.whiteBalanceSamplePoint, { xRatio: 0.3, yRatio: 0.6 });
    assert.deepEqual(
        [snapshot.temperature, snapshot.tint, snapshot.vibrance, snapshot.saturation],
        [28, -13, 19, -7]
    );
});

test('copying a mounted ColorReset node prefers its current controls', () => {
    const node = { id: 'mounted-color-reset', type: 'ColorReset', x: 0, y: 0, data: { whiteBalanceMode: 'original', temperature: 4 } };
    const controls = new Map([
        ['mounted-color-reset-white-balance', { value: 'auto' }],
        ['mounted-color-reset-temperature', { value: '36' }],
        ['mounted-color-reset-tint', { value: '-8' }],
        ['mounted-color-reset-vibrance', { value: '12' }],
        ['mounted-color-reset-saturation', { value: '5' }]
    ]);
    const api = createClipboardControllerApi({
        state: { nodes: new Map([[node.id, node]]) },
        documentRef: { getElementById: (id) => controls.get(id) || null, querySelectorAll: () => [] }
    });

    const snapshot = api.serializeOneNode(node.id);

    assert.equal(snapshot.whiteBalanceMode, 'auto');
    assert.deepEqual([snapshot.temperature, snapshot.tint, snapshot.vibrance, snapshot.saturation], [36, -8, 12, 5]);
});

test('successive ColorReset frames keep one visible image and update its source immediately', () => {
    const documentRef = { createElement: (tagName) => createPreviewElement(tagName) };
    const renderer = createDisplayImageRenderer({
        documentRef,
        previewCache: {
            getCachedPreviewThumbnail: () => '',
            createPreviewThumbnail: () => Promise.resolve('data:image/png;base64,thumbnail')
        },
        isInlineImageData: () => true
    });
    const preview = createPreviewElement();

    renderer.renderColorResetPreview(preview, 'data:image/png;base64,first', { overlayId: 'picker-overlay' });
    const firstImage = preview.querySelector('img');
    renderer.renderColorResetPreview(preview, 'data:image/png;base64,second', { overlayId: 'picker-overlay' });

    assert.equal(preview.querySelector('img'), firstImage);
    assert.equal(firstImage.src, 'data:image/png;base64,second');
    assert.equal(preview.children.filter((child) => child.tagName === 'IMG').length, 1);
    assert.equal(preview.children.filter((child) => child.className === 'color-reset-picker-overlay').length, 1);
});

test('ColorReset preview commits the newest frame before asset persistence finishes', async () => {
    const node = { id: 'color-live', type: 'ColorReset', enabled: true, data: {} };
    const preview = createPreviewElement();
    const pendingSaves = new Map();
    const saveCalls = [];
    const documentRef = {
        __cainflowSelectedNodePreviewKeyboardBound: false,
        activeElement: null,
        addEventListener() {},
        createElement: (tagName) => createPreviewElement(tagName),
        getElementById(id) {
            if (id === 'color-live-color-preview') return preview;
            if (id === 'color-live-white-balance') return { value: 'original' };
            return null;
        },
        querySelector() { return null; }
    };
    const windowRef = {
        requestAnimationFrame(callback) { callback(); return 1; },
        cancelAnimationFrame() {},
        setTimeout,
        clearTimeout,
        Image: class {}
    };
    const api = createMediaControllerApi({
        state: { nodes: new Map([[node.id, node]]), connections: [], selectedNodeIds: new Set(), resizing: null },
        getNodeById: (id) => id === node.id ? node : null,
        saveImageAsset: (_id, dataUrl) => {
            saveCalls.push(dataUrl);
            return new Promise((resolve) => pendingSaves.set(dataUrl, resolve));
        },
        processColorResetImage: async (source) => ({ dataUrl: source, whiteBalanceAnalysis: null }),
        getImageResolution: async () => '',
        estimateDataUrlSize: () => 1,
        scheduleSave() {},
        showToast() {},
        addLog() {},
        documentRef,
        windowRef
    });

    const firstRefresh = api.refreshColorResetPreview(node.id, { sourceImage: 'data:image/png;base64,first' });
    await Promise.resolve();
    assert.equal(preview.querySelector('img')?.src, 'data:image/png;base64,first');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingSaves.has('data:image/png;base64,first'), true);

    const secondRefresh = api.refreshColorResetPreview(node.id, { sourceImage: 'data:image/png;base64,second' });
    await Promise.resolve();
    assert.equal(preview.querySelector('img')?.src, 'data:image/png;base64,second');

    pendingSaves.get('data:image/png;base64,first')?.(true);
    await Promise.all([firstRefresh, secondRefresh]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingSaves.has('data:image/png;base64,second'), true);
    pendingSaves.get('data:image/png;base64,second')?.(true);
    await node.colorResetAssetWrite;
    assert.equal(preview.querySelector('img')?.src, 'data:image/png;base64,second');
    assert.deepEqual(saveCalls, [
        'data:image/png;base64,first',
        'data:image/png;base64,second'
    ]);
    assert.equal(node.data.imageAssetReady, true);
});

test('zero adjustments preserve RGB and alpha exactly', () => {
    const source = new Uint8ClampedArray([12, 34, 56, 78, 200, 150, 100, 255]);
    const result = applyColorResetToPixels(source);
    assert.deepEqual([...result.pixels], [...source]);
});

test('auto white balance does not turn a neutral reference magenta in a green scene', () => {
    const pixels = [];
    for (let index = 0; index < 90; index += 1) pixels.push(40, 180, 60, 255);
    for (let index = 0; index < 10; index += 1) pixels.push(128, 128, 128, 255);
    const source = new Uint8ClampedArray(pixels);
    const analysis = analyzeAutoWhiteBalance(source);
    const result = applyColorResetToPixels(source, { whiteBalanceMode: 'auto', whiteBalanceAnalysis: analysis });
    const gray = [...result.pixels.slice(360, 363)];
    assert.equal(analysis.status, 'applied');
    assert.ok(Math.max(...gray) - Math.min(...gray) <= 2, `neutral reference changed to ${gray.join('/')}`);
});

test('auto white balance declines saturated scenes without a neutral reference', () => {
    const pixels = new Uint8ClampedArray(Array.from({ length: 100 }, () => [30, 180, 50, 255]).flat());
    const analysis = analyzeAutoWhiteBalance(pixels);
    assert.equal(analysis.status, 'needs-sample');
    assert.deepEqual(analysis.gains, { r: 1, g: 1, b: 1 });
});

test('auto white balance moves warm and cold neutral patches toward gray', () => {
    for (const color of [[180, 145, 110], [100, 145, 190], [165, 120, 155], [110, 165, 125]]) {
        const source = new Uint8ClampedArray(Array.from({ length: 25 }, () => [...color, 255]).flat());
        const analysis = analyzeAutoWhiteBalance(source);
        assert.equal(analysis.status, 'applied', `expected ${color.join('/')} to be analyzable`);
        const output = applyColorResetToPixels(source, { whiteBalanceMode: 'auto', whiteBalanceAnalysis: analysis }).pixels;
        assert.ok(Math.max(...output.slice(0, 3)) - Math.min(...output.slice(0, 3)) <= 12);
    }
});

test('5x5 picker sampling rejects an outlier and keeps gains bounded', () => {
    const pixels = new Uint8ClampedArray(Array.from({ length: 25 }, (_, index) => index === 0 ? [255, 0, 255, 255] : [180, 140, 100, 255]).flat());
    const sample = sampleWhiteBalanceRegion(pixels, 5, 5, 2, 2);
    assert.equal(sample.status, 'applied');
    assert.ok(sample.gains.r < sample.gains.g && sample.gains.g < sample.gains.b);
    for (const gain of Object.values(sample.gains)) assert.ok(gain >= 0.67 && gain <= 1.5);
});

test('picker sampling rejects transparent, dark, and overexposed regions', () => {
    for (const pixel of [[120, 120, 120, 0], [2, 2, 2, 255], [255, 255, 255, 255]]) {
        const source = new Uint8ClampedArray(Array.from({ length: 25 }, () => pixel).flat());
        assert.equal(sampleWhiteBalanceRegion(source, 5, 5, 2, 2).status, 'invalid-sample');
    }
});

test('invalid picker analysis preserves the previous white-balance selection and keeps picking active', () => {
    const previous = { mode: 'custom', samplePoint: { xRatio: 0.2, yRatio: 0.4 } };
    const invalid = resolveWhiteBalanceSampleSelection(previous, { xRatio: 0.8, yRatio: 0.9 }, {
        status: 'invalid-sample', message: '取样区域无有效像素，请重新选择'
    });
    assert.deepEqual(invalid, {
        accepted: false,
        mode: 'custom',
        samplePoint: { xRatio: 0.2, yRatio: 0.4 },
        keepPicking: true,
        message: '取样区域无有效像素，请重新选择'
    });

    const valid = resolveWhiteBalanceSampleSelection(previous, { xRatio: 0.8, yRatio: 0.9 }, {
        status: 'applied', message: '已从 5×5 区域取样'
    });
    assert.equal(valid.accepted, true);
    assert.equal(valid.mode, 'custom');
    assert.deepEqual(valid.samplePoint, { xRatio: 0.8, yRatio: 0.9 });
    assert.equal(valid.keepPicking, false);
});

test('preview point mapping rejects letterbox space and maps contained image coordinates', () => {
    assert.deepEqual(mapPreviewPointToImage({ x: 100, y: 50, boxWidth: 200, boxHeight: 100, imageWidth: 100, imageHeight: 100 }), { x: 50, y: 50, xRatio: 0.5, yRatio: 0.5 });
    assert.equal(mapPreviewPointToImage({ x: 25, y: 50, boxWidth: 200, boxHeight: 100, imageWidth: 100, imageHeight: 100 }), null);
});

test('context menu exposes the top-level color group and node card controls', async () => {
    const [html, factory] = await Promise.all([
        readFile(new URL('../index.html', import.meta.url), 'utf8'),
        readFile(new URL('../js/nodes/node-view-factory.js', import.meta.url), 'utf8')
    ]);
    assert.match(html, /data-submenu-target="context-menu-color-nodes"/);
    assert.match(html, /data-type="ColorReset"/);
    assert.match(factory, /\$\{id\}-white-balance/);
    for (const label of ['色温', '色调', '自然饱和度', '饱和度']) assert.match(factory, new RegExp(label));
});

test('color reset card presents preview before white balance and color groups', () => {
    const config = getNodeDefinition('ColorReset');
    const markup = createNodeMarkup({ type: 'ColorReset', id: 'color-1', config, restoreData: {}, state: {} });
    const toolbar = markup.indexOf('color-reset-toolbar');
    const preview = markup.indexOf('color-reset-preview');
    const whiteBalance = markup.indexOf('color-reset-white-balance');
    const color = markup.indexOf('color-reset-color-controls');
    assert.ok(toolbar < preview && preview < whiteBalance && whiteBalance < color);
    for (const id of ['reset-all', 'reset-white-balance', 'reset-color', 'picker-overlay']) assert.match(markup, new RegExp(`color-1-${id}`));
});

test('color reset interactions expose scoped resets, derived dirty state, double-click reset, and Escape cancellation', async () => {
    const controller = await readFile(new URL('../js/features/media/media-controller.js', import.meta.url), 'utf8');
    assert.match(controller, /const resetWhiteBalanceState/);
    assert.match(controller, /const resetColorState/);
    assert.match(controller, /const updateDirtyState/);
    assert.match(controller, /addEventListener\('dblclick', resetScalar\)/);
    assert.match(controller, /event[.]key !== 'Escape'/);
    assert.match(controller, /resetWhiteBalanceState\(\); resetColorState\(\)/);
});
