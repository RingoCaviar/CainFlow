import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageNodeResults } from '../js/nodes/image-node-results.js';

const original = 'data:image/png;base64,b3JpZ2luYWw=';
const nextOriginal = 'data:image/png;base64,bmV4dA==';
const thumbnail = 'data:image/webp;base64,dGh1bWI=';
const nextThumbnail = 'data:image/webp;base64,bmV4dC10aHVtYg==';
const flush = () => new Promise(resolve => setImmediate(resolve));

function element(tag) {
    return {
        tag, children: [], dataset: {}, textContent: '',
        get isConnected() { return this.attached || this.parent?.isConnected || false; },
        get parentNode() { return this.parent || null; },
        get lastElementChild() { return this.children.at(-1); },
        append(...children) { for (const child of children) this.insertBefore(child, null); },
        insertBefore(child, before) {
            const index = this.children.indexOf(before);
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            child.parent = this;
        },
        replaceChildren(...children) {
            for (const child of this.children) child.parent = null;
            this.children = [];
            this.textContent = '';
            this.append(...children);
        },
        setAttribute() {}, addEventListener() {}
    };
}

function find(element, matches) {
    if (matches(element)) return element;
    for (const child of element.children) {
        const match = find(child, matches);
        if (match) return match;
    }
}

function fixture(data, { withObserver = true } = {}) {
    const host = Object.assign(element('div'), { attached: true });
    const node = { id: 'generated', type: 'ImageGenerate', data, el: { dataset: { renderProjection: 'shell' } } };
    const state = { nodes: new Map([[node.id, node]]), runningNodeIds: new Set() };
    const documentRef = { createElement: element, getElementById: id => id === 'generated-image-results' ? host : null,
        defaultView: {} };
    const observed = new Set(), assetReads = [], jobs = [], remembered = [];
    let notify, latestActions;
    if (withObserver) documentRef.defaultView.IntersectionObserver = class {
        constructor(callback) { notify = callback; }
        observe(target) { observed.add(target); }
        unobserve(target) { observed.delete(target); }
    };
    const results = createImageNodeResults({ state, documentRef,
        readAsset: async key => { assetReads.push(key); return key === 'media:missing' ? '' : original; },
        createThumbnail: (source, options) => new Promise(resolve => jobs.push({ source, options, resolve })),
        rememberThumbnail: (...args) => remembered.push(args),
        createActions: options => { latestActions = options; return null; }
    });
    return { node, assetReads, jobs, remembered, observed, host,
        detach() { host.attached = false; host.parent = { isConnected: false }; state.nodes.clear(); },
        attach() { host.attached = true; state.nodes.set(node.id, node); },
        render: () => results.render(node.id),
        visibility: isIntersecting => notify([{ target: host, isIntersecting }]),
        readOriginal: () => latestActions.readOriginal(),
        image: () => find(host, item => item.tag === 'img'),
        preview: () => find(host, item => item.className === 'image-node-result-preview')
    };
}

test('offscreen generated previews defer the selected asset while original actions can still read it', async () => {
    const view = fixture({ imageCount: 2, mediaAssetKeys: ['media:first', 'media:second'] });
    view.node.imagePreviewIndex = 1;
    view.render();
    assert.deepEqual(view.assetReads, []);
    assert.equal(view.preview().textContent, '载入图片预览…');
    assert.equal(await view.readOriginal(), original);
    assert.deepEqual(view.assetReads, ['media:second']);

    view.visibility(true);
    view.visibility(true);
    await flush();
    assert.deepEqual(view.assetReads, ['media:second', 'media:second']);
    assert.equal(view.jobs.length, 1);
    assert.equal(view.jobs[0].options.priority.value, 1);
    view.jobs[0].resolve(thumbnail);
    await flush();

    assert.equal(view.image().src, thumbnail);
    assert.equal(view.observed.size, 0);
    assert.deepEqual(view.node.data.mediaAssetKeys, ['media:first', 'media:second']);
});

test('a visible generated card promotes its queued thumbnail and ignores a superseded result', async () => {
    const view = fixture({ images: [original] });
    view.render();
    assert.equal(view.jobs[0].options.priority.value, 0);
    view.visibility(true);
    assert.equal(view.jobs[0].options.priority.value, 1);
    view.render();
    assert.equal(view.jobs.length, 1);

    view.node.data.images = [nextOriginal];
    view.render();
    view.jobs[0].resolve(thumbnail);
    await flush();
    assert.equal(view.image().src, undefined);
    assert.deepEqual(view.remembered, []);
    view.jobs[1].resolve(nextThumbnail);
    await flush();

    assert.equal(view.image().src, nextThumbnail);
    assert.deepEqual(view.remembered, [[view.node.id, nextOriginal, nextThumbnail]]);
});

test('a cached workflow view receives its finished thumbnail while detached without saving the active graph', async () => {
    const view = fixture({ imageCount: 1, mediaAssetKeys: ['media:original'] });
    view.render();
    view.visibility(true);
    await flush();
    view.detach();
    view.visibility(false);
    assert.equal(view.jobs[0].options.priority.value, 0);
    assert.equal(view.jobs[0].options.isCurrent(), true);
    view.jobs[0].resolve(thumbnail);
    await flush();

    assert.deepEqual(view.remembered, []);
    view.attach();
    view.render();
    assert.equal(view.image().src, thumbnail);
    assert.equal(view.jobs.length, 1);
});

test('a restored generated thumbnail displays without reading or decoding the asset again', async () => {
    const view = fixture({ imageCount: 1, mediaAssetKeys: ['media:original'], imagePreviewThumbnail: thumbnail });
    view.render();
    assert.equal(view.image().src, thumbnail);
    assert.deepEqual(view.assetReads, []);
    assert.deepEqual(view.jobs, []);
    assert.equal(await view.readOriginal(), original);
});

test('generated cards still report a missing original when visibility observation is unavailable', async () => {
    const view = fixture({ imageCount: 1, mediaAssetKeys: ['media:missing'] }, { withObserver: false });
    view.render();
    await flush();
    assert.deepEqual(view.assetReads, ['media:missing']);
    assert.equal(view.preview().textContent, '原图缺失，请从媒体管理恢复');
});
