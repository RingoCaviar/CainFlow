import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('node shell border remains above opaque header and body surfaces', async () => {
    const stylesheet = await readFile(new URL('../css/modules/04-node-core.css', import.meta.url), 'utf8');
    assert.match(stylesheet, /\.node-glass-bg\s*\{[\s\S]*?z-index:\s*0/, 'the node shell must paint its border above opaque node surfaces');
    assert.match(stylesheet, /\.node-header,\s*\.node-body,\s*\.node-ports-row\s*\{[\s\S]*?z-index:\s*1/, 'node content must remain above the non-interactive shell');
});
