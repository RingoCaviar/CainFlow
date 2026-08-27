import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
const media = await readFile(new URL('../css/modules/05-node-media.css', import.meta.url), 'utf8');
const interactions = await readFile(new URL('../js/canvas/canvas-interactions.js', import.meta.url), 'utf8');
const bindings = await readFile(new URL('../js/nodes/node-dom-bindings.js', import.meta.url), 'utf8');

test('node cards grow around their content instead of scrolling their body', () => {
    assert.match(core, /\.node-body\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*auto;/);
    assert.doesNotMatch(core, /\.node-body\s*\{[\s\S]*?overflow-y:\s*auto;/);
    assert.match(media, /\.node-preview \.node-body\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/);
    assert.match(media, /\.node-preview \.preview-container\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(media, /\.node-save \.node-body\s*\{[\s\S]*?overflow:\s*visible;/);
});

test('node cards use compact headers and edge-aligned ports with stable hit areas', () => {
    assert.match(core, /\.node-header\s*\{[\s\S]*?padding:\s*8px 12px;/);
    assert.match(core, /\.node-ports-row\s*\{[\s\S]*?padding:\s*6px 12px 5px;/);
    assert.match(core, /\.node-port\s*\{[\s\S]*?min-height:\s*24px;/);
    assert.match(core, /\.node-port\.input \.port-dot\s*\{[\s\S]*?margin-left:\s*-12px;/);
    assert.match(core, /\.node-port\.output \.port-dot\s*\{[\s\S]*?margin-right:\s*-12px;/);
});

test('resizing honors the measured content height at the final width', () => {
    assert.match(bindings, /minHeight:\s*Math\.max\(60, Math\.min\(defaultMinimum\.minHeight, resizeTargetMinHeight\)\)/);
    assert.match(interactions, /let dynamicMinHeight = typeof getNodeMinimumSize === 'function' \? 0 : r\.minHeight;/);
    assert.match(interactions, /dynamicMinHeight = Math\.max\(dynamicMinHeight, Number\(finalMinimum\.minHeight\) \|\| 0\)/);
    assert.match(interactions, /finalHeight = Math\.max\(finalHeight, Number\(minimum\?\.minHeight\) \|\| 0\)/);
});
