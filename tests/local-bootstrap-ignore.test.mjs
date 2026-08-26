import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('local bootstrap copies are ignored by git', () => {
    const result = spawnSync('git', [
        'check-ignore',
        '--quiet',
        'Cainflow_local-bootstrap-fixed/CainFlow.exe'
    ], { cwd: new URL('..', import.meta.url), shell: false });

    assert.equal(result.status, 0);
});
