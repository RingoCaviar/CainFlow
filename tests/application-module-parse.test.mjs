import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function listJavaScriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return listJavaScriptFiles(path);
        return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
    });
}

test('every application ES module can be instantiated', () => {
    const files = [
        resolve('index.js'),
        ...listJavaScriptFiles(resolve('js'))
    ];
    const script = [
        "const { readFileSync } = require('node:fs');",
        "const vm = require('node:vm');",
        "for (const file of process.argv.slice(1)) {",
        "  new vm.SourceTextModule(readFileSync(file, 'utf8'), { identifier: file });",
        "}"
    ].join('\n');
    const result = spawnSync(process.execPath, [
        '--experimental-vm-modules',
        '-e',
        script,
        ...files
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
});
