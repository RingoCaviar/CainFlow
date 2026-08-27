import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bootstrap = await readFile(new URL('../js/app/bootstrap-impl.js', import.meta.url), 'utf8');

test('the frequent-update refresh notice is not registered at startup', () => {
    assert.doesNotMatch(bootstrap, /id:\s*'refresh-tip'/);
    assert.doesNotMatch(bootstrap, /本APP更新频繁/);
    assert.doesNotMatch(bootstrap, /cainflow_refresh_notice_dismissed/);
});
