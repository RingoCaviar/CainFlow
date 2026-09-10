import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const controllerSource = await readFile(
    new URL('../js/features/media/media-controller.js', import.meta.url),
    'utf8'
);

test('preview and save renderers refresh the current image resolution badge', () => {
    const previewRenderer = controllerSource.match(/function renderImagePreviewImage\([\s\S]*?function renderImageSavePreview/)?.[0] || '';
    const saveRenderer = controllerSource.match(/function renderImageSavePreview\([\s\S]*?function renderVideoSavePreview/)?.[0] || '';

    assert.match(previewRenderer, /const rendered = renderDisplayImagePreview\([\s\S]*?void showResolutionBadge\(nodeId, rendered\.image\)/);
    assert.match(saveRenderer, /const rendered = renderDisplayImagePreview\([\s\S]*?void showResolutionBadge\(nodeId, rendered\.image\)/);
});
