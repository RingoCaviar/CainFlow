import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const launcher = await readFile(new URL('../start_cainflow.bat', import.meta.url), 'utf8');

test('launcher diagnostics remain cmd-safe across Windows code pages', () => {
    assert.match(launcher, /if exist "%APP_DIR%\.venv\\Scripts\\python\.exe" \([\s\S]*?else if exist "%APP_DIR%python_runtime\\python\.exe"/);
    assert.match(launcher, /:dependencies_missing[\s\S]*?Error: CainFlow desktop dependencies are missing\./);
    assert.match(launcher, /echo\s+%PYTHON_CMD% -m pip install -r requirements\.txt/);
    assert.doesNotMatch(launcher, /[^\x00-\x7F]/);
});
