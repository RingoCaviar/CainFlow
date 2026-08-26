import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

test('版本库文件不再包含已移除的合作方标识或域名', async () => {
    const root = new URL('..', import.meta.url);
    const removedDomainToken = ['67', '89', 'api'].join('');
    const removedPartnerToken = ['G', 'X', 'P'].join('');
    const removedContentPattern = new RegExp(`${removedDomainToken}|\\b${removedPartnerToken}\\b`, 'i');
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((file) => file !== 'tests/removed-partnership-content.test.mjs');
    const violations = [];

    for (const file of files) {
        let content;
        try {
            content = await readFile(new URL(file, root));
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        const text = content.toString('utf8');
        if (removedContentPattern.test(text)) violations.push(file);
    }

    assert.deepEqual(violations, []);
});
