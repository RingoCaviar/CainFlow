import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    createWorkspaceModeController,
    normalizeWorkspaceMode
} from '../js/features/ui/workspace-mode-controller.js';

function classList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        contains: (name) => values.has(name)
    };
}

function element() {
    return {
        hidden: false,
        inert: false,
        attributes: new Map(),
        classList: classList(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        addEventListener() {}
    };
}

test('switching Workspace mode preserves the mounted canvas and its editor state', () => {
    const canvasWorkspace = element();
    const conversationWorkspace = element();
    conversationWorkspace.hidden = true;
    conversationWorkspace.inert = true;
    const sideBar = element();
    const canvasButton = element();
    const conversationButton = element();
    const canvasChild = { id: 'node-a' };
    canvasWorkspace.child = canvasChild;
    const canvasState = { x: 120, y: 80, zoom: 1.25 };
    const state = { workspaceMode: 'canvas', canvas: canvasState };
    const elements = new Map([
        ['canvas-container', canvasWorkspace],
        ['conversation-workspace', conversationWorkspace],
        ['side-bar', sideBar],
        ['btn-workspace-canvas', canvasButton],
        ['btn-workspace-conversation', conversationButton]
    ]);
    const documentRef = {
        body: { dataset: {}, classList: classList() },
        getElementById: (id) => elements.get(id) || null,
        addEventListener() {}
    };
    const saved = [];
    const controller = createWorkspaceModeController({
        state, documentRef, saveState: () => saved.push(state.workspaceMode)
    });

    assert.equal(controller.activate('conversation'), true);

    assert.equal(state.workspaceMode, 'conversation');
    assert.equal(state.canvas, canvasState);
    assert.equal(canvasWorkspace.child, canvasChild);
    assert.equal(canvasWorkspace.hidden, true);
    assert.equal(canvasWorkspace.inert, true);
    assert.equal(sideBar.hidden, true);
    assert.equal(conversationWorkspace.hidden, false);
    assert.equal(conversationWorkspace.inert, false);
    assert.equal(canvasButton.attributes.get('aria-pressed'), 'false');
    assert.equal(conversationButton.attributes.get('aria-pressed'), 'true');
    assert.deepEqual(saved, ['conversation']);
});

test('Workspace mode controls and shortcuts activate the requested surface', () => {
    const listeners = new Map();
    const makeInteractive = () => ({
        ...element(),
        addEventListener(type, callback) { listeners.set(`${this.id}:${type}`, callback); }
    });
    const canvasWorkspace = makeInteractive(); canvasWorkspace.id = 'canvas-container';
    const conversationWorkspace = makeInteractive(); conversationWorkspace.id = 'conversation-workspace';
    const sideBar = makeInteractive(); sideBar.id = 'side-bar';
    const canvasButton = makeInteractive(); canvasButton.id = 'btn-workspace-canvas';
    const conversationButton = makeInteractive(); conversationButton.id = 'btn-workspace-conversation';
    const elements = new Map([canvasWorkspace, conversationWorkspace, sideBar, canvasButton, conversationButton]
        .map((item) => [item.id, item]));
    const documentRef = {
        body: { dataset: {}, classList: classList() },
        getElementById: (id) => elements.get(id) || null,
        addEventListener(type, callback) { listeners.set(`document:${type}`, callback); }
    };
    const state = { workspaceMode: 'canvas' };
    const controller = createWorkspaceModeController({ state, documentRef });
    controller.init();

    listeners.get('btn-workspace-conversation:click')();
    assert.equal(state.workspaceMode, 'conversation');
    listeners.get('document:keydown')({
        key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
        preventDefault() {}
    });
    assert.equal(state.workspaceMode, 'canvas');
});

test('unknown persisted Workspace mode falls back to the canvas', () => {
    assert.equal(normalizeWorkspaceMode('conversation'), 'conversation');
    assert.equal(normalizeWorkspaceMode('future-mode'), 'canvas');
    assert.equal(normalizeWorkspaceMode(null), 'canvas');
});

test('Workspace mode switch inherits every application theme and has a narrow-window rule', async () => {
    const [workspaceCss, themeIndex] = await Promise.all([
        readFile(new URL('../css/features/conversation-workspace.css', import.meta.url), 'utf8'),
        readFile(new URL('../css/themes.css', import.meta.url), 'utf8')
    ]);
    const themeImports = [...themeIndex.matchAll(/@import '\.\/themes\/(?!shared)([^']+)\.css'/g)]
        .map((match) => match[1]);

    assert.deepEqual(themeImports, [
        'dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'
    ]);
    assert.match(workspaceCss, /var\(--surface-control\)/);
    assert.match(workspaceCss, /var\(--panel-active-border\)/);
    assert.doesNotMatch(workspaceCss, /#[0-9a-f]{3,8}\b/i);
    assert.match(workspaceCss, /@media \(max-width: 760px\)/);
    assert.match(workspaceCss, /workspace-mode-conversation \.toolbar-canvas-only/);
    assert.match(workspaceCss, /workspace-mode-conversation \.toolbar-conversation-only/);
});

test('Conversation mode keeps its toolbar in layout flow so it cannot cover the first workspace controls', async () => {
    const workspaceCss = await readFile(new URL('../css/features/conversation-workspace.css', import.meta.url), 'utf8');

    assert.match(workspaceCss, /body\.workspace-mode-conversation #toolbar\s*\{[^}]*position:\s*relative[^}]*transform:\s*translateY\(0\)/s);
});
