import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createWorkflowLayoutElements,
    createWorkflowLayoutHost
} from '../js/features/workflow/workflow-layout-host.js';

test('detached workflow layout host is attached to the visible document before preparation', () => {
    const events = [];
    const layoutDocument = { body: {} };
    const frame = {
        style: {},
        contentDocument: layoutDocument,
        setAttribute() {},
        remove: () => events.push('remove')
    };
    const documentRef = {
        createElement: () => frame,
        body: { appendChild: () => events.push('attach') }
    };

    const host = createWorkflowLayoutHost(documentRef);

    assert.equal(host.document, layoutDocument);
    assert.deepEqual(events, ['attach']);
    host.dispose();
    assert.deepEqual(events, ['attach', 'remove']);
});

test('workflow layout elements mirror visible editor ids and viewport dimensions', () => {
    const createElement = (tagName) => ({
        tagName,
        style: {},
        children: [],
        attributes: {},
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this.attributes[name] = value; }
    });
    const documentRef = {
        body: { appendChild() {} },
        createElement,
        createElementNS: (_namespace, tagName) => {
            const element = createElement(tagName);
            Object.defineProperty(element, 'className', {
                value: { baseVal: '' },
                writable: false
            });
            return element;
        }
    };

    const elements = createWorkflowLayoutElements(documentRef, { width: 1440, height: 900 });

    assert.equal(elements.canvasContainer.id, 'canvas-container');
    assert.equal(elements.nodesLayer.id, 'nodes-layer');
    assert.equal(elements.connectionsSvg.id, 'connections-svg');
    assert.equal(elements.tempConnection.attributes.class, 'temp-connection');
    assert.equal(elements.wrapper.style.width, '1440px');
    assert.equal(elements.wrapper.style.height, '900px');
});
