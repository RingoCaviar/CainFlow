import test from 'node:test';
import assert from 'node:assert/strict';
import { createUndoMediaProtection } from '../js/features/persistence/undo-media-protection.js';
import { createDesktopExit } from '../js/features/persistence/desktop-exit.js';

test('history protection is acknowledged synchronously, stores keys only and fails closed', async () => {
    const calls = [];
    const protection = createUndoMediaProtection({ pageId: 'page', requestSync: body => calls.push(body), request: async body => calls.push(body) });
    const snapshot = { historyId: 'r', nodes: [{ mediaAssetKeys: ['media:a'], imageData: 'data:secret' }] };
    protection.protect(snapshot, 'wf');
    assert.deepEqual(calls[0].assetKeys, ['media:a']);
    assert.ok(!JSON.stringify(calls).includes('secret'));
    await protection.release(snapshot); await protection.end();
    assert.deepEqual(calls.map(call => call.action), ['protect', 'release', 'end']);
    assert.throws(() => protection.protect(snapshot, 'wf'), /退出/);
    const failed = createUndoMediaProtection({ pageId: 'page', requestSync: () => { throw Error('offline'); } });
    assert.throws(() => failed.protect(snapshot, 'wf'), /未执行/);
});

test('runtime snapshots protect every video position in generated and saved node results', () => {
    const requests=[];
    const protection=createUndoMediaProtection({pageId:'video-page',requestSync:body=>requests.push(body)});
    protection.protect({historyId:'clipboard:video',nodes:[
        {type:'VideoGenerate',videoAssetKey:'media:current',videos:[{assetKey:'media:first'},{assetKey:'media:second'}]},
        {type:'ImageSave',video:{assetKey:'media:saved'},data:{videos:[{assetKey:'media:forwarded'},{assetKey:'media:first'}]}}
    ]},'workflow');
    assert.deepEqual(requests[0]?.assetKeys.sort(),['media:current','media:first','media:forwarded','media:saved','media:second'],'temporary retention covers video batches and forwarded save-node results');
});

test('exit waits for save before releasing, coalesces close clicks and supports retry after save failure', async () => {
    const order = []; let fail = true;
    const exit = createDesktopExit({ settle: async () => order.push('settle'), save: async () => { order.push('save'); if (fail) throw Error('disk'); },
        release: async () => order.push('release'), finish: async () => order.push('close'),
        confirmDiscard: async () => false, setBlocked: value => order.push(value), report() {} });
    const first = exit(); assert.equal(exit(), first); await first;
    assert.deepEqual(order, [true, 'settle', 'save', false]);
    fail = false; order.length = 0; await exit();
    assert.deepEqual(order, [true, 'settle', 'save', 'release', 'close', false]);
});

test('cleanup failure after successful save defers to backend instead of losing a close request', async () => {
    const order = [];
    const exit = createDesktopExit({ settle: async () => {}, save: async () => order.push('saved'),
        release: async () => { throw Error('network'); }, report: () => order.push('deferred'),
        finish: async () => order.push('closed'), confirmDiscard: () => assert.fail('save succeeded'), setBlocked() {} });
    await exit(); assert.deepEqual(order, ['saved', 'deferred', 'closed']);
});

test('exit unblocks the page while asking whether to discard unsaved changes', async () => {
    const order = [];
    const exit = createDesktopExit({ settle: async () => {}, save: async () => { throw Error('disk'); },
        release: async () => assert.fail('release must wait for save'), finish: async () => order.push('closed'),
        report() {}, setBlocked: value => order.push(value),
        confirmDiscard: async () => { assert.deepEqual(order, [true, false]); return false; } });
    await exit();
    assert.deepEqual(order, [true, false]);
});
