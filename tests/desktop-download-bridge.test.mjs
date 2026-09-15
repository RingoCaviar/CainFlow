import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('programmatic download links join the document before they are clicked', async () => {
    const sources = await Promise.all([
        '../js/features/persistence/project-io.js',
        '../js/features/workflow/workflow-manager.js',
        '../js/features/settings/protocol-developer-panel.js',
        '../js/features/ui/ui-controller.js'
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

    for (const source of sources) {
        assert.match(source, /body\?\.appendChild\((?:a|link|anchor)\)[\s\S]{0,180}(?:a|link|anchor)\.click\(\)/);
    }
});
