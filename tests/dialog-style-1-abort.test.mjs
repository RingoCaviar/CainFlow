import test from 'node:test';
import assert from 'node:assert/strict';
import { openDialogStyle1 } from '../js/features/ui/dialog-style-1.js';

function createDocument() {
    const elements = new Map();
    return {
        getElementById: (id) => elements.get(id) || null,
        createElement: () => {
            const classes = new Set();
            const element = {
                id: '',
                className: '',
                innerHTML: '',
                classList: {
                    add: (...names) => names.forEach((name) => classes.add(name)),
                    remove: (...names) => names.forEach((name) => classes.delete(name)),
                    contains: (name) => classes.has(name)
                },
                querySelector: () => null
            };
            return element;
        },
        body: {
            appendChild(element) {
                elements.set(element.id, element);
            }
        }
    };
}

test('aborting an activation-owned dialog resolves it as cancelled', async () => {
    const documentRef = createDocument();
    const controller = new AbortController();
    const decision = openDialogStyle1({
        id: 'activation-confirm',
        title: 'Confirm activation',
        actions: [{ id: 'confirm', label: 'Confirm' }],
        cancelActionId: 'cancel',
        documentRef,
        signal: controller.signal
    });

    controller.abort();

    assert.equal(await decision, 'cancel');
    assert.equal(documentRef.getElementById('activation-confirm').classList.contains('hidden'), true);
});
