import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/validate-release-version.ps1', import.meta.url));
test('release versions enforce decimal rollover while preserving published legacy tags', () => {
    for (const tag of ['v3.7.0', 'v3.7.9', 'v3.8.0', 'v4.0.0', 'v10.0.0', 'v3.5.10', 'v3.5.11', 'v3.5.12', 'v3.6.10']) {
        const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-TagName', tag], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${tag}: ${result.error || result.stderr}`);
    }
    for (const tag of ['v3.6.11', 'v3.7.10', 'v3.10.0', 'v03.7.0', 'v3.07.0', 'v3.7.00', 'V3.7.0', 'v3.7', 'v3.7.0-beta', 'nightly']) {
        const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-TagName', tag], { encoding: 'utf8' });
        assert.equal(result.status, 1, `${tag}: ${result.error || result.stderr}`);
        assert.match(result.stderr, /Invalid release version/);
    }
});
