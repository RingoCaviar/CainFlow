import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const validationScript = await readFile(
    new URL('../scripts/validate-release-readiness.ps1', import.meta.url),
    'utf8'
);
const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release readiness runs Python tests without an undeclared pytest dependency', () => {
    assert.match(
        validationScript,
        /& \$PythonCommand -m unittest discover -s tests -p ['"]test_\*\.py['"] -q/
    );
    assert.doesNotMatch(validationScript, /& \$PythonCommand -m pytest\b/);
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
