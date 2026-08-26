import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const validationScript = await readFile(
    new URL('../scripts/validate-release-readiness.ps1', import.meta.url),
    'utf8'
);

test('release readiness runs Python tests without an undeclared pytest dependency', () => {
    assert.match(
        validationScript,
        /& \$PythonCommand -m unittest discover -s tests -p ['"]test_\*\.py['"] -q/
    );
    assert.doesNotMatch(validationScript, /& \$PythonCommand -m pytest\b/);
});
