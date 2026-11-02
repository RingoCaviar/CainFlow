import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowAutosave } from '../js/features/workflow/workflow-autosave.js';

function clock() {
    let now = 0, next = 0;
    const timers = new Map();
    return {
        setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
        clearTimer(id) { timers.delete(id); },
        async advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
            for (let i = 0; i < 10; i++) await Promise.resolve();
        }
    };
}

test('edits save once after one second of inactivity, independently for each workflow', async () => {
    const time = clock(), saved = [];
    const autosave = createWorkflowAutosave({ ...time, save: async id => { saved.push(id); return true; } });
    autosave.change('a');
    await time.advance(600);
    autosave.change('a');
    autosave.change('b');
    await time.advance(999);
    assert.deepEqual(saved, []);
    await time.advance(1);
    assert.deepEqual(saved, ['a', 'b']);
    assert.equal(autosave.hasPending(), false);
});

test('close waits for edits arriving during an in-flight write without parallel writes', async () => {
    let complete, calls = 0;
    const autosave = createWorkflowAutosave({ ...clock(), save: async () => {
        calls++;
        if (calls === 1) await new Promise(resolve => { complete = resolve; });
        return true;
    } });
    autosave.change('a');
    const closing = autosave.flush(['a']);
    await Promise.resolve();
    autosave.change('a');
    assert.equal(calls, 1);
    complete();
    assert.deepEqual((await closing).results, [{ workflowId: 'a', status: 'committed' }]);
    assert.equal(calls, 2);
    assert.equal(autosave.hasPending(), false);
});

test('failed save retains work and an explicit retry saves the latest edit', async () => {
    let succeeds = false, failures = 0;
    const autosave = createWorkflowAutosave({ ...clock(), save: async () => succeeds, onFailure() { failures++; } });
    autosave.change('a');
    assert.equal((await autosave.flush()).results[0].status, 'failed');
    assert.equal(autosave.hasPending(), true);
    assert.equal(failures, 1);
    succeeds = true;
    assert.equal((await autosave.flush()).results[0].status, 'committed');
    assert.equal(autosave.hasPending(), false);
});

test('timer defers atomic canvas transactions while their own commit may persist', async () => {
    const time = clock();
    let calls = 0;
    const autosave = createWorkflowAutosave({ ...time, canSave: () => false,
        save: async () => { calls++; return true; } });
    autosave.change('a');
    await time.advance(1000);
    assert.equal(calls, 0);
    await autosave.flush(['a'], { force: true });
    assert.equal(calls, 1);
    assert.equal(autosave.hasPending(), false);
});
