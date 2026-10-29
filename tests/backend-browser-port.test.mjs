import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

test('browser launcher publishes the actual kernel-assigned HTTP port', { timeout: 15000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cainflow-port-browser-'));
    const child = spawn(process.env.CAINFLOW_PYTHON || 'python', ['server.py', '--browser', '--port', '0'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, PYTHONUNBUFFERED: '1', CAINFLOW_SKIP_BROWSER_AUTO_OPEN: '1',
            CAINFLOW_DATA_DIR: join(directory, 'data'), CAINFLOW_WORKFLOWS_DIR: join(directory, 'workflows') },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '', launchError;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => { launchError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
    try {
        let announced;
        for (let attempt = 0; attempt < 100; attempt++) {
            if (launchError) throw launchError;
            announced = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (announced) break;
            assert.equal(child.exitCode, null, output);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(announced, `the real browser launcher announces its address: ${output}`);
        assert.ok(Number(announced[1]) > 0, 'port zero requests a kernel allocation and must not be advertised as the listening address');
        const response = await fetch(announced[0]);
        assert.equal(response.status, 200);
        assert.match(await response.text(), /CainFlow/);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await closed;
        assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
        await rm(directory, { recursive: true, force: true });
    }
});
