import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('image-save markup leaves fixed visual styling to the node skin', async () => {
    const markup = await readFile(new URL('../js/nodes/node-view-factory.js', import.meta.url), 'utf8');
    const media = await readFile(new URL('../css/modules/05-node-media.css', import.meta.url), 'utf8');
    assert.match(markup, /save-no-path-warning \$\{showWarning \? '' : 'hidden'\}/);
    assert.match(markup, /class="save-preview-video"/);
    assert.doesNotMatch(markup, /save-no-path-warning"[^>]*style=/);
    assert.doesNotMatch(markup, /<video[^>]*style="width:100%;height:100%;object-fit:contain/);
    assert.match(media, /[.]save-no-path-warning\s*\{[\s\S]*?color:\s*var\(--accent-red\)/);
    assert.match(media, /[.]save-preview-video\s*\{[\s\S]*?background:\s*color-mix/);
});
