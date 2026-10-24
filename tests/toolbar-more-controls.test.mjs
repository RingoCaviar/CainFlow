import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolbarControllerApi } from '../js/features/ui/toolbar-controller.js';

function makeToolbarMenu() {
    const listeners = new Map();
    const documentListeners = new Map();
    const documentRef = {
        activeElement: null,
        getElementById: id => id === 'toolbar-workflow-more' ? menu : null,
        addEventListener: (type, listener) => documentListeners.set(type, listener)
    };
    const focusable = () => {
        const element = { focus: () => { documentRef.activeElement = element; } };
        return element;
    };
    const summary = focusable();
    const buttons = [focusable(), focusable(), focusable()];
    const menu = {
        open: false,
        addEventListener: (type, listener) => listeners.set(type, listener),
        querySelector: () => summary,
        querySelectorAll: () => buttons,
        contains: element => element === summary || buttons.includes(element)
    };
    createToolbarControllerApi({ state: {}, documentRef, confirmRef: () => true }).initToolbarControls();
    const key = value => listeners.get('keydown')({ key: value, preventDefault() {}, stopPropagation() {} });
    return { menu, summary, buttons, documentRef, listeners, documentListeners, key };
}

test('More actions are reachable by keyboard and Escape returns to the trigger', () => {
    const view = makeToolbarMenu();
    view.summary.focus();
    view.key('ArrowDown');
    assert.equal(view.menu.open, true);
    assert.equal(view.documentRef.activeElement, view.buttons[0]);
    view.key('ArrowUp');
    assert.equal(view.documentRef.activeElement, view.buttons[2]);
    view.key('Home');
    assert.equal(view.documentRef.activeElement, view.buttons[0]);
    view.key('End');
    assert.equal(view.documentRef.activeElement, view.buttons[2]);
    view.key('Escape');
    assert.equal(view.menu.open, false);
    assert.equal(view.documentRef.activeElement, view.summary);
});

test('any More action closes the menu while preserving focus transferred by its action', () => {
    const view = makeToolbarMenu();
    view.menu.open = true;
    view.buttons[1].focus();
    view.listeners.get('click')({ target: { closest: () => view.buttons[1] } });
    assert.equal(view.menu.open, false);
    assert.equal(view.documentRef.activeElement, view.summary);
    const drawerInput = {};
    view.menu.open = true;
    view.documentRef.activeElement = drawerInput;
    view.listeners.get('click')({ target: { closest: () => view.buttons[1] } });
    assert.equal(view.menu.open, false);
    assert.equal(view.documentRef.activeElement, drawerInput);
});

test('More closes when focus or a click leaves its controls', () => {
    const view = makeToolbarMenu();
    view.menu.open = true;
    view.listeners.get('focusout')({ relatedTarget: view.buttons[0] });
    assert.equal(view.menu.open, true);
    view.listeners.get('focusout')({ relatedTarget: {} });
    assert.equal(view.menu.open, false);
    view.menu.open = true;
    view.documentListeners.get('click')({ target: {} });
    assert.equal(view.menu.open, false);
});
