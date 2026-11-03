import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const validationScript = await readFile(
    new URL('../scripts/validate-release-readiness.ps1', import.meta.url),
    'utf8'
);
const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release readiness delegates to the complete regression entry without duplicate Python runs', async () => {
    const runner = await readFile(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8');
    const fullEntry = await readFile(new URL('../scripts/check-full.ps1', import.meta.url), 'utf8');
    assert.match(validationScript, /check-full\.ps1/);
    assert.match(fullEntry, /"--mode", "full"/);
    assert.match(runner, /'unittest'/);
    assert.doesNotMatch(validationScript, /-m unittest|-m pytest|Invoke-StorageInitializationCheck/);
});

test('release readiness emits and enforces the Media asset safety report', () => {
    assert.match(validationScript, /media_safety_gate/);
    assert.match(validationScript, /media-asset-safety-report\.json/);
    assert.match(validationScript, /Media asset safety gate failed/);
});

test('release workflow requires committed update notes and publishes their contents', () => {
    assert.match(validationScript, /validate-release-notes\.ps1/);
    assert.match(releaseWorkflow, /Validate release notes[\s\S]*?validate-release-notes\.ps1/);
    assert.match(releaseWorkflow, /gh release create[\s\S]*?--notes-file|"release", "create"[\s\S]*?"--notes-file", \$notesPath/);
    assert.match(releaseWorkflow, /gh release edit[^\n]+--notes-file \$notesPath/);
    assert.doesNotMatch(releaseWorkflow, /Automated CainFlow build for/);
});
