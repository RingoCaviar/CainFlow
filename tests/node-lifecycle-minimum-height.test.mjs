import assert from 'node:assert/strict';
import test from 'node:test';

import { createNodeLifecycleApi } from '../js/nodes/node-lifecycle.js';
import { createNodeSerializer } from '../js/nodes/node-serializer.js';

function createClassList(...names) {
    const values = new Set(names);
    return { contains: (name) => values.has(name) };
}

function createStyle(values = {}) {
    return {
        display: 'block',
        visibility: 'visible',
        flexDirection: 'column',
        font: '11px sans-serif',
        fontSize: '11px',
        fontFamily: 'sans-serif',
        ...values,
        getPropertyValue(property) {
            return this[property] ?? this[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? '0';
        }
    };
}

function createLayoutFixture() {
    const textarea = {
        tagName: 'TEXTAREA',
        style: { height: '120px' },
        classList: createClassList(),
        children: [],
        offsetParent: {},
        matches: () => false,
        computedStyle: createStyle({ minHeight: '72px', height: '120px' })
    };
    const progress = {
        tagName: 'DIV',
        style: {},
        classList: createClassList('node-generation-progress-field'),
        children: [],
        offsetHeight: 48,
        scrollHeight: 48,
        offsetParent: {},
        matches: () => false,
        computedStyle: createStyle()
    };
    const body = {
        tagName: 'DIV',
        style: {},
        classList: createClassList('node-body'),
        children: [textarea, progress],
        offsetParent: {},
        matches: () => false,
        querySelector: () => null,
        querySelectorAll: (selector) => selector === 'textarea, .chat-response-area' ? [textarea] : [],
        get offsetHeight() {
            return Number.parseFloat(textarea.style.height) + 48 + 8 + 18;
        },
        get scrollHeight() {
            return this.offsetHeight;
        },
        computedStyle: createStyle({
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            paddingTop: '8px',
            paddingBottom: '10px'
        })
    };
    const element = {
        style: { width: '410px', height: '146px' },
        classList: createClassList('node', 'node-generate'),
        querySelector(selector) {
            if (selector === '.node-body') return body;
            return null;
        }
    };
    return { element, textarea };
}

test('saved textarea height contributes to the generation node minimum height', () => {
    const originalGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (element) => element.computedStyle;
    try {
        const { element, textarea } = createLayoutFixture();
        const node = { id: 'image-1', type: 'ImageGenerate', el: element, minHeight: 0 };
        const state = { nodes: new Map([[node.id, node]]) };
        const documentRef = {
            defaultView: { setTimeout, clearTimeout, requestAnimationFrame: (callback) => callback() },
            createElement: () => ({ getContext: () => null })
        };
        const lifecycle = createNodeLifecycleApi({
            state,
            nodeConfigs: {
                ImageGenerate: { defaultWidth: 410, minWidth: 360, minHeight: 60, contentSized: true }
            },
            documentRef
        });

        assert.equal(lifecycle.getNodeMinimumSize(node).minHeight, 194);
        assert.equal(textarea.style.height, '120px');
    } finally {
        globalThis.getComputedStyle = originalGetComputedStyle;
    }
});

test('creating an image generation node completes its initial serialization', () => {
    const children = [];
    const nodesLayer = {
        children,
        appendChild(element) {
            element.parentElement = this;
            children.push(element);
        }
    };
    const documentRef = {
        defaultView: { setTimeout: () => 0, clearTimeout: () => {} },
        createElement: () => ({
            style: {},
            dataset: {},
            classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            remove() {
                const index = children.indexOf(this);
                if (index >= 0) children.splice(index, 1);
            }
        }),
        getElementById: (id) => id === 'nodes-layer' ? nodesLayer : null,
        querySelectorAll: () => []
    };
    const state = {
        nodes: new Map(), connections: [], selectedNodes: new Set(),
        nodeDefaults: {}, canvas: { zoom: 1, x: 0, y: 0 }
    };
    const serializer = createNodeSerializer({ state, documentRef });
    const lifecycle = createNodeLifecycleApi({
        state,
        nodeConfigs: {
            ImageGenerate: { title: '图片生成', cssClass: 'node-generate', defaultWidth: 410, defaultHeight: 320 }
        },
        createNodeMarkup: () => '<div></div>',
        nodesLayer,
        generateId: () => 'image-created',
        getImageAsset: async () => null,
        saveImageAsset: async () => false,
        bindNodeInteractions: () => serializer.serializeNodes(),
        pushHistory: () => {}, scheduleSave: () => {}, showToast: () => {},
        updateAllConnections: () => {}, updatePortStyles: () => {},
        getCacheSidebarActive: () => false, updateCacheUsage: () => {},
        documentRef
    });

    assert.equal(lifecycle.addNode('ImageGenerate', 10, 20), 'image-created');
    assert.equal(state.nodes.has('image-created'), true);
});
