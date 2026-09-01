import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const foundation = await readFile(new URL('../css/modules/00-foundation.css', import.meta.url), 'utf8');
const notices = await readFile(new URL('../css/modules/14-sidebar-notices-errors.css', import.meta.url), 'utf8');
const workbench = await readFile(new URL('../css/layout/workbench.css', import.meta.url), 'utf8');
const canvas = await readFile(new URL('../css/modules/03-canvas.css', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../js/features/ui/runtime-controller.js', import.meta.url), 'utf8');

test('shared overlay layer tokens remain defined', () => {
    for (const token of ['--layer-drawer', '--layer-toolbar', '--layer-notice', '--layer-menu', '--layer-toast', '--layer-immersive', '--layer-modal']) {
        assert.match(foundation, new RegExp(`${token}:\\s*\\d+`));
    }
});

test('floating notices use the single workbench positioning contract', () => {
    assert.match(notices, /top:\s*var\(--floating-notices-top-offset/);
    assert.match(notices, /z-index:\s*var\(--layer-notice\)/);
    assert.doesNotMatch(notices, /#toolbar:hover \+ #main-layout #floating-notices-container/);
    assert.match(workbench, /--floating-notices-top-offset:\s*calc\(var\(--toolbar-height/);
});

test('toolbar height is synchronized before ResizeObserver registration', () => {
    const immediateSync = runtime.indexOf('syncToolbarHeight();');
    const observerRegistration = runtime.indexOf('new ResizeObserverCtor(syncToolbarHeight)');
    assert.ok(immediateSync >= 0);
    assert.ok(observerRegistration > immediateSync);
    assert.match(runtime, /function initWindowBindings\(\) \{\s*\/\/[\s\S]*?initToolbarObserver\(\);/);
    assert.doesNotMatch(runtime, /addEventListener\(['"]load['"][\s\S]{0,160}initToolbarObserver/);
});

test('Canvas interaction keeps the background grid visible while zooming and panning', () => {
    assert.match(canvas, /#canvas-container::before\s*\{[\s\S]*?background-image:\s*radial-gradient\(/);
    assert.doesNotMatch(
        canvas,
        /#canvas-container\.is-(?:zooming|panning)::before[\s\S]{0,160}?background-image:\s*none/
    );
});

test('the workbench exposes a non-layout-shifting canvas frame role', () => {
    assert.match(workbench, /--workbench-frame-border:\s*var\(--panel-border/);
    assert.match(workbench, /--workbench-canvas-border:\s*color-mix/);
    assert.match(workbench, /#canvas-container\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--workbench-canvas-border\)/);
});

test('Canvas zoom does not promote the whole node layer to a composited transform layer', () => {
    assert.doesNotMatch(
        canvas,
        /#canvas-container\.is-zooming #nodes-layer[\s\S]{0,160}?will-change:\s*transform/
    );
});
