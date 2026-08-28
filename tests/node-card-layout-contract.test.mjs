import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const core = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
const media = await readFile(new URL('../css/modules/05-node-media.css', import.meta.url), 'utf8');
const interactions = await readFile(new URL('../js/canvas/canvas-interactions.js', import.meta.url), 'utf8');
const bindings = await readFile(new URL('../js/nodes/node-dom-bindings.js', import.meta.url), 'utf8');
const controls = await readFile(new URL('../css/modules/07-node-controls.css', import.meta.url), 'utf8');
const textStyles = await readFile(new URL('../css/modules/06-node-text.css', import.meta.url), 'utf8');
const lifecycle = await readFile(new URL('../js/nodes/node-lifecycle.js', import.meta.url), 'utf8');
const canvasInteractions = await readFile(new URL('../js/canvas/canvas-interactions.js', import.meta.url), 'utf8');
const imageGenerate = await readFile(new URL('../js/nodes/types/image-generate.js', import.meta.url), 'utf8');
const videoGenerate = await readFile(new URL('../js/nodes/types/video-generate.js', import.meta.url), 'utf8');
const textChat = await readFile(new URL('../js/nodes/types/text-chat.js', import.meta.url), 'utf8');
const protocolRenderer = await readFile(new URL('../js/nodes/protocol-ui-renderer.js', import.meta.url), 'utf8');
const viewFactory = await readFile(new URL('../js/nodes/node-view-factory.js', import.meta.url), 'utf8');

test('node cards grow around their content instead of scrolling their body', () => {
    assert.match(core, /\.node-body\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*auto;/);
    assert.doesNotMatch(core, /\.node-body\s*\{[\s\S]*?overflow-y:\s*auto;/);
    assert.match(media, /\.node-preview \.node-body\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;/);
    assert.match(media, /\.node-preview \.preview-container\s*\{[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(media, /\.node-save \.node-body\s*\{[\s\S]*?overflow:\s*visible;/);
});

test('image previews fill the available card area', () => {
    assert.match(media, /\.node-preview \.preview-container img\s*\{[^}]*object-fit:\s*cover;/);
});

test('node cards use compact headers and edge-aligned ports with stable hit areas', () => {
    assert.match(core, /\.node-header\s*\{[\s\S]*?padding:\s*8px 12px;/);
    assert.match(core, /\.node-ports-row\s*\{[\s\S]*?padding:\s*6px 12px 5px;/);
    assert.match(core, /\.node-ports-row\.has-inputs-only \.node-inputs-section\s*\{[\s\S]*?justify-self:\s*start;[\s\S]*?width:\s*max-content;/);
    assert.match(core, /\.node-ports-row\.has-outputs-only \.node-outputs-section\s*\{[\s\S]*?justify-self:\s*end;[\s\S]*?width:\s*max-content;/);
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

test('safe scalar parameters use two columns at the minimum card width', () => {
    assert.match(core, /\.node\s*\{[\s\S]*?container-type:\s*inline-size;/);
    assert.match(controls, /\.node-protocol-params\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.doesNotMatch(controls, /@container \(max-width:\s*320px\)/);
    assert.match(controls, /\.node-protocol-params > \.node-field--half/);
    assert.match(controls, /\.node-parameter-grid > \.node-field\s*\{[\s\S]*?grid-column:\s*auto;/);
    assert.match(protocolRenderer, /param\.layout !== 'full' && supportsHalfWidth/);
});

test('generation cards use a roomy default width and a smaller resize minimum', () => {
    for (const source of [imageGenerate, videoGenerate, textChat]) {
        assert.match(source, /defaultWidth:\s*410/);
        assert.match(source, /minWidth:\s*360/);
        assert.match(source, /maxWidth:\s*720/);
        assert.match(source, /defaultHeight:\s*60/);
        assert.match(source, /minHeight:\s*60/);
        assert.match(source, /contentSized:\s*true/);
        assert.doesNotMatch(source, /maxHeight:/);
    }
    assert.match(lifecycle, /if \(!userResized\) return defaultWidth;/);
    assert.match(lifecycle, /Math\.min\(maxWidth, Math\.max\(numericWidth, minWidth\)\)/);
    assert.match(lifecycle, /usesContentSizedDefault[\s\S]*?minimum\.minHeight/);
    assert.match(lifecycle, /const bodyMinimumWidth = config\?\.contentSized === true \? 0 : bodySize\.width/);
    assert.match(lifecycle, /Math\.max\(configuredMinWidth, headerWidth, portsRowSize\.width, bodyMinimumWidth\)/);
    assert.match(canvasInteractions, /Math\.min\(configuredMaxWidth, Math\.max\(targetW, r\.minWidth\)\)/);
    assert.match(canvasInteractions, /configuredMaxHeight >= dynamicMinHeight \? configuredMaxHeight : Infinity/);
});

test('compact text and result areas define the normal minimum content height', () => {
    assert.match(media, /\.node-generate textarea\.image-generate-prompt\s*\{[\s\S]*?min-height:\s*72px;/);
    assert.match(controls, /\.node-video-generate \.node-video-prompt-field textarea\s*\{[\s\S]*?min-height:\s*72px;/);
    assert.match(controls, /\.node-video-generate \.node-video-result-field \.chat-response-area\s*\{[\s\S]*?height:\s*120px;/);
    assert.match(textStyles, /\.node-chat \.node-chat-prompt-field textarea\s*\{[\s\S]*?min-height:\s*72px;/);
    assert.match(textStyles, /\.node-chat \.node-chat-system-field textarea\s*\{[\s\S]*?min-height:\s*72px;/);
    assert.match(textStyles, /\.node-chat \.chat-response-area\s*\{[\s\S]*?height:\s*120px;/);
});

test('generation progress stays inside the node body padding', () => {
    assert.match(media, /\.image-generation-progress\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?box-sizing:\s*border-box;/);
    assert.match(media, /\.node-generation-progress-field\s*\{[^}]*position:\s*static;[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*align-self:\s*stretch;/);
    assert.doesNotMatch(media, /\.node-generation-progress-field\s*\{[^}]*position:\s*absolute;/);
    assert.match(viewFactory, /<div class="node-field node-generation-progress-field">\s*<label>生成进度<\/label>\s*<div class="image-generation-progress api-generation-progress"/);
});

test('the resize handle can restore the dynamic default size', () => {
    assert.match(bindings, /resizeHandle\.title = '拖动调整大小，双击适应内容'/);
    assert.match(bindings, /resizeHandle\.addEventListener\('dblclick'[\s\S]*?node\.userResized = false;[\s\S]*?fitNodeToContent/);
    assert.match(viewFactory, /node-parameter-grid node-chat-toggle-grid/);
});

test('node selects truncate long values without expanding the node minimum', () => {
    assert.match(core, /\.node-select-trigger-label\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
    assert.match(lifecycle, /optionWidth \+ horizontalPadding \+ horizontalBorder \+ 18,[\s\S]*?236/);
});
