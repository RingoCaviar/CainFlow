import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopExit } from '../js/features/persistence/desktop-exit.js';

function fixture({ busy = false, save = async () => {}, restart = async () => {} } = {}) {
    const calls = [];
    const exit = createDesktopExit({
        hasRunningTasks: () => typeof busy === 'function' ? busy() : busy,
        setBlocked: value => calls.push(['blocked', value]),
        settle: async () => calls.push(['settle']),
        save: async () => { calls.push(['save']); await save(); },
        release: async () => calls.push(['release']),
        finish: async () => calls.push(['close']),
        finishRestart: async id => { await restart(); calls.push(['restart', id]); },
        report: error => calls.push(['error', error.message]),
        confirmDiscard: async () => { calls.push(['discard']); return true; }
    });
    return { exit, calls };
}

test('update restart refuses active tasks without cancelling or saving them', async () => {
    const { exit, calls } = fixture({ busy: true });
    assert.equal(await exit({ restartJobId: 'update-1' }), false);
    assert.equal(calls.some(([name]) => ['settle', 'save', 'restart', 'close', 'discard'].includes(name)), false);
});

test('a blocked restart can be retried after the active tasks finish', async () => {
    let busy = true;
    const { exit, calls } = fixture({ busy: () => busy });
    assert.equal(await exit({ restartJobId: 'update-1' }), false);
    busy = false;
    assert.equal(await exit({ restartJobId: 'update-1' }), true);
    assert.equal(calls.filter(([name]) => name === 'restart').length, 1);
});

test('update restart stays open after save failure without offering to discard changes', async () => {
    const { exit, calls } = fixture({ save: async () => { throw new Error('disk full'); } });
    assert.equal(await exit({ restartJobId: 'update-1' }), false);
    assert.equal(calls.some(([name]) => ['restart', 'close', 'discard', 'release'].includes(name)), false);
    assert.deepEqual(calls.at(-1), ['blocked', false]);
});

test('update restart saves before closing and coalesces repeated requests', async () => {
    let complete;
    const { exit, calls } = fixture({ save: () => new Promise(resolve => { complete = resolve; }) });
    const first = exit({ restartJobId: 'update-1' });
    const second = exit({ restartJobId: 'update-1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(([name]) => name === 'restart'), false);
    complete();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(calls.filter(([name]) => ['save', 'release', 'restart', 'close'].includes(name)), [['save'], ['restart', 'update-1']]);
});

test('failed restart preparation preserves the undo session and allows another attempt', async () => {
    let fail = true;
    const { exit, calls } = fixture({ restart: async () => { if (fail) throw new Error('helper unavailable'); } });
    assert.equal(await exit({ restartJobId: 'update-1' }), false);
    assert.equal(calls.some(([name]) => name === 'release'), false);
    fail = false;
    assert.equal(await exit({ restartJobId: 'update-1' }), true);
});
