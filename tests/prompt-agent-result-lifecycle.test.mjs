import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptAgentResultPersistence } from '../js/features/prompt-agent/prompt-agent-result-persistence.js';
import { createPromptAgentResultMediaAdapter } from '../js/features/prompt-agent/prompt-agent-result-media.js';

const clone = value => JSON.parse(JSON.stringify(value));
const images = ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='];
const batch = { images, mediaAssetKeys: ['media:a', 'media:b'] };
const runs = document => [...(document?.archivedMessages || []), ...(document?.messages || [])].flatMap(message => message.runs || []);
const initial = () => ({ version: 1, imageModelId: 'image-model', messages: [{ role: 'agent', text: '方案',
    runs: [{ runId: 'run', targetNodeId: 'image', status: 'running', mediaAssetKeys: [], persistenceStatus: 'pending' }] }] });
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function harness(options = {}) {
    const documents = new Map([['a', initial()], ['b', initial()]]);
    const retained = [], released = [], saved = [];
    const mutateConversation = (workflowId, reducer) => {
        if (!documents.has(workflowId)) return false;
        const next = reducer(clone(documents.get(workflowId)));
        if (!next) return false;
        documents.set(workflowId, next);
        return true;
    };
    const dependencies = {
        mutateConversation,
        media: {
            retain: async result => {
                retained.push(clone(result));
                if (options.retain) return options.retain(result);
                const keys = result.mediaAssetKeys.length ? result.mediaAssetKeys : ['media:a', 'media:b'];
                return { mediaAssetKeys: keys, persistenceStatus: 'retained',
                    mediaOwnershipTemporaryOwners: [{ ownerId: `owner:${result.workflowId}:${result.runId}`, assetKeys: keys }] };
            },
            release: async result => { released.push(clone(result)); return options.release ? options.release(result) : true; }
        },
        saveConversation: async () => {
            saved.push(clone(Object.fromEntries(documents)));
            return options.saveConversation?.(saved.length);
        },
        onChange: options.onChange
    };
    return { documents, retained, released, saved, dependencies, persistence: createPromptAgentResultPersistence(dependencies),
        run: (workflowId = 'a', runId = 'run') => runs(documents.get(workflowId)).find(run => run.runId === runId) };
}

test('completion updates the latest originating document and archived run without overwriting newer turns', async () => {
    const retaining = deferred();
    const app = harness({ retain: () => retaining.promise });
    const saving = app.persistence.save('a', 'run', batch);
    await turn();
    const originalOrder = app.run().completionOrder;
    const document = app.documents.get('a');
    document.archivedMessages = document.messages;
    document.messages = [{ role: 'user', text: '保存期间新增的消息' }];
    document.contextSummary = '最新摘要';
    document.compactedMessageCount = 1;
    const other = clone(app.documents.get('b'));
    retaining.resolve({ mediaAssetKeys: batch.mediaAssetKeys, persistenceStatus: 'retained',
        mediaOwnershipTemporaryOwners: [{ ownerId: 'owner', assetKeys: batch.mediaAssetKeys }] });
    assert.deepEqual(await saving, { status: 'saved' });
    assert.equal(app.documents.get('a').messages[0].text, '保存期间新增的消息');
    assert.equal(app.documents.get('a').contextSummary, '最新摘要');
    assert.deepEqual(app.documents.get('b'), other);
    assert.deepEqual(app.run().mediaAssetKeys, batch.mediaAssetKeys);
    assert.equal(app.run().completionOrder, originalOrder);
    assert.equal(app.saved.length, 2);
    assert.equal(app.released.length, 1);
});

test('duplicate saves and retries share a task that waits for the whole handoff', async () => {
    const release = deferred(), markerSave = deferred();
    const app = harness({ release: () => release.promise, saveConversation: count => count === 2 ? markerSave.promise : undefined });
    const saving = app.persistence.save('a', 'run', batch);
    assert.equal(app.persistence.save('a', 'run', batch), saving);
    assert.equal(app.persistence.retry('a', 'run'), saving);
    assert.equal(app.persistence.read('a', 'run').saving, true);
    let settled = false;
    saving.then(() => { settled = true; });
    await turn();
    assert.equal(app.retained.length, 1);
    assert.equal(settled, false);
    release.resolve(true);
    await turn();
    assert.equal(settled, false);
    assert.equal(app.persistence.read('a', 'run').saving, true);
    markerSave.resolve();
    await saving;
    assert.equal(app.persistence.read('a', 'run').saving, false);
    const preview = app.persistence.read('a', 'run').images;
    preview.reverse();
    assert.deepEqual(app.persistence.read('a', 'run').images, images);
});

test('different runs and workflows progress independently while one result is delayed', async () => {
    const retaining = deferred();
    const app = harness({ retain: async ({ workflowId, runId, mediaAssetKeys }) => {
        if (workflowId === 'a' && runId === 'run') await retaining.promise;
        return { mediaAssetKeys, persistenceStatus: 'retained' };
    } });
    app.documents.get('a').messages[0].runs.push({ runId: 'next', status: 'running', mediaAssetKeys: [] });
    const first = app.persistence.save('a', 'run', batch);
    const second = app.persistence.save('a', 'next', batch);
    const other = app.persistence.save('b', 'run', batch);
    await Promise.all([second, other]);
    assert.equal(app.persistence.read('a', 'run').saving, true);
    assert.equal(app.run('a', 'next').persistenceStatus, 'saved');
    assert.equal(app.run('b').persistenceStatus, 'saved');
    retaining.resolve();
    await first;
});

test('failed durable save retries by identity without retaining again or changing completion order', async () => {
    const app = harness({ saveConversation: count => { if (count === 1) throw new Error('磁盘暂不可写'); } });
    assert.equal((await app.persistence.save('a', 'run', batch)).status, 'failed');
    assert.equal(app.released.length, 0);
    assert.equal(app.run().persistenceStatus, 'failed');
    const order = app.run().completionOrder;
    app.documents.get('a').messages.push({ role: 'agent', text: '后来的结果', runs: [{ runId: 'newer', status: 'running', mediaAssetKeys: [] }] });
    await app.persistence.save('a', 'newer', batch);
    assert.deepEqual(await app.persistence.retry('a', 'run'), { status: 'saved' });
    assert.equal(app.retained.filter(result => result.runId === 'run').length, 1);
    assert.equal(app.run().completionOrder, order);
    assert.ok(app.run('a', 'newer').completionOrder > order);
    assert.deepEqual(app.run().mediaAssetKeys, batch.mediaAssetKeys);
});

test('failed retention retries the original full images without the caller supplying a snapshot', async () => {
    let attempts = 0;
    const app = harness({ retain: async result => {
        assert.deepEqual(result.images, images);
        if (++attempts === 1) return { persistenceStatus: 'failed', persistenceError: '图片保存失败' };
        return { mediaAssetKeys: batch.mediaAssetKeys, persistenceStatus: 'retained' };
    } });
    assert.equal((await app.persistence.save('a', 'run', { images })).status, 'failed');
    assert.equal(app.saved.length, 0);
    assert.equal(app.released.length, 0);
    assert.deepEqual(await app.persistence.retry('a', 'run'), { status: 'saved' });
    assert.equal(attempts, 2);
});

test('a second marker flush failure never rematerializes an already durably saved result', async () => {
    const app = harness({ saveConversation: count => { if (count === 2) throw new Error('状态标记保存失败'); } });
    assert.deepEqual(await app.persistence.save('a', 'run', batch), { status: 'saved' });
    assert.equal(app.run().persistenceStatus, 'saved');
    assert.deepEqual(await app.persistence.retry('a', 'run'), { status: 'saved' });
    assert.equal(app.retained.length, 1);
    assert.equal(app.released.length, 1);
    assert.equal(app.saved.length, 2);
});

test('failed reference handoff retains protection and retries release without another retention', async () => {
    let releases = 0;
    const app = harness({ release: async () => ++releases > 1 });
    assert.equal((await app.persistence.save('a', 'run', batch)).status, 'failed');
    assert.match(app.run().persistenceError, /引用交接/);
    assert.equal(app.run().mediaOwnershipTemporaryOwners.length, 1);
    await app.persistence.retry('a', 'run');
    assert.equal(app.run().persistenceStatus, 'saved');
    assert.equal(app.retained.length, 1);
    assert.equal(releases, 2);
});

test('clear fences late completion and waits for durable removal before any protection is released', async () => {
    const retaining = deferred(), clearing = deferred();
    const app = harness({ retain: () => retaining.promise, saveConversation: () => clearing.promise });
    const saving = app.persistence.save('a', 'run', batch);
    await turn();
    const clear = app.persistence.clear('a');
    assert.deepEqual(runs(app.documents.get('a')), []);
    assert.equal(app.persistence.read('a', 'run').images, undefined);
    retaining.resolve({ mediaAssetKeys: batch.mediaAssetKeys, persistenceStatus: 'retained',
        mediaOwnershipTemporaryOwners: [{ ownerId: 'owner', assetKeys: batch.mediaAssetKeys }] });
    await turn();
    assert.equal(app.released.length, 0);
    clearing.resolve();
    assert.deepEqual(await clear, { status: 'cleared' });
    assert.deepEqual(await saving, { status: 'discarded' });
    assert.deepEqual(runs(app.documents.get('a')), []);
    assert.equal(app.released.length, 2);
    assert.ok(app.released.every(result => result.workflowId === 'a' && result.runId === 'run'));
});

test('a failed durable clear keeps late retained protection until clear is successfully retried', async () => {
    const retaining = deferred();
    const app = harness({ retain: () => retaining.promise, saveConversation: count => { if (count === 1) throw new Error('暂不可写'); } });
    const saving = app.persistence.save('a', 'run', batch);
    await turn();
    await assert.rejects(app.persistence.clear('a'), /暂不可写/);
    retaining.resolve({ mediaAssetKeys: batch.mediaAssetKeys, persistenceStatus: 'retained',
        mediaOwnershipTemporaryOwners: [{ ownerId: 'owner', assetKeys: batch.mediaAssetKeys }] });
    assert.equal((await saving).status, 'discarded');
    assert.equal(app.released.length, 0);
    await app.persistence.clear('a');
    assert.equal(app.released.length, 1);
    assert.deepEqual(app.released[0].mediaOwnershipTemporaryOwners, [{ ownerId: 'owner', assetKeys: batch.mediaAssetKeys }]);
    assert.deepEqual(runs(app.documents.get('a')), []);
});

test('clear after a failed result save releases its protection only after the clear snapshot commits', async () => {
    const events = [];
    const app = harness({ saveConversation: count => { events.push('save'); if (count === 1) throw new Error('暂不可写'); },
        release: async () => { events.push('release'); return true; } });
    await app.persistence.save('a', 'run', batch);
    await app.persistence.clear('a');
    assert.deepEqual(events, ['save', 'save', 'release']);
});

test('deleting the workflow while retention is pending never recreates its document', async () => {
    const retaining = deferred();
    const app = harness({ retain: () => retaining.promise });
    const saving = app.persistence.save('a', 'run', batch);
    await turn();
    app.documents.delete('a');
    retaining.resolve({ mediaAssetKeys: batch.mediaAssetKeys, persistenceStatus: 'retained' });
    assert.deepEqual(await saving, { status: 'discarded' });
    assert.equal(app.documents.has('a'), false);
    assert.equal(app.released.length, 1);
    assert.equal(app.saved.length, 0);
});

test('clear preserves model, size, provider, thinking and search preferences and the other workflow', async () => {
    const app = harness();
    const preferences = { imageModelId: 'image-model', sizeSettings: { 'image-model': { resolution: '2K', aspectRatio: '1:1' } },
        thinkingSettings: { chat: { model: { effort: 'high' } }, image: {} },
        providerSettings: { chat: { model: 'provider' }, image: {}, search: {} }, searchSettings: { mode: 'off', modelId: '' } };
    Object.assign(app.documents.get('a'), preferences, { memory: '电影感', contextSummary: '当前摘要', referenceImages: [
        { name: '参考图', dataUrl: images[0] }
    ] });
    const other = clone(app.documents.get('b'));
    await app.persistence.clear('a');
    const document = app.documents.get('a');
    for (const [key, value] of Object.entries(preferences)) assert.deepEqual(document[key], value);
    assert.equal(document.version, 1);
    assert.equal(document.memory, '');
    assert.equal(document.contextSummary || '', '');
    assert.deepEqual(document.messages, []);
    assert.deepEqual(document.archivedMessages || [], []);
    assert.deepEqual(document.referenceImages || [], []);
    assert.deepEqual(app.documents.get('b'), other);
});

test('a restored retained run retries using durable ownership without its old in-memory images', async () => {
    const app = harness({ saveConversation: count => { if (count === 1) throw new Error('磁盘暂不可写'); } });
    await app.persistence.save('a', 'run', batch);
    const restored = createPromptAgentResultPersistence(app.dependencies);
    assert.equal(restored.read('a', 'run').images, undefined);
    assert.deepEqual(await restored.retry('a', 'run'), { status: 'saved' });
    assert.equal(app.retained.length, 1);
    assert.equal(app.released.length, 1);
});

test('keys-only results use the complete local batch and preserve missing positions on failure', async () => {
    const app = harness();
    const reads = [];
    let missing = true, writes = 0;
    const persistence = createPromptAgentResultPersistence({ ...app.dependencies, media: createPromptAgentResultMediaAdapter({
        getImageAsset: async key => { reads.push(key); return key === 'media:a' ? images[0] : missing ? '' : images[1]; },
        saveWorkflowNodeMediaAssets: async (values, workflowId, consumer, operationId) => {
            writes++;
            assert.deepEqual(values, images);
            return batch.mediaAssetKeys.map(asset_key => ({ asset_key, mediaTemporaryOwnerId: JSON.stringify([workflowId, consumer, operationId]) }));
        },
        cancelWorkflowNodeMediaOperation: async () => true
    }) });
    assert.equal((await persistence.save('a', 'run', { mediaAssetKeys: batch.mediaAssetKeys })).status, 'failed');
    assert.deepEqual(app.run().mediaAssetKeys, batch.mediaAssetKeys);
    assert.equal(writes, 0);
    missing = false;
    assert.deepEqual(await persistence.retry('a', 'run'), { status: 'saved' });
    assert.equal(writes, 1);
    assert.deepEqual(reads, ['media:a', 'media:b', 'media:a', 'media:b']);
});

test('a captured result batch cannot be replaced while waiting for a save retry', async () => {
    const app = harness({ saveConversation: count => { if (count === 1) throw new Error('暂不可写'); } });
    await app.persistence.save('a', 'run', batch);
    const original = clone(app.run());
    assert.deepEqual(await app.persistence.save('a', 'run', { images: [images[1]], mediaAssetKeys: ['media:replacement'] }), { status: 'discarded' });
    assert.deepEqual(app.run(), original);
    assert.equal(app.retained.length, 1);
    await app.persistence.retry('a', 'run');
    assert.deepEqual(app.run().mediaAssetKeys, batch.mediaAssetKeys);
});

test('clear can retry failed media cleanup even after the conversation records have been removed', async () => {
    let releases = 0;
    const app = harness({ release: async () => ++releases > 1 });
    await assert.rejects(app.persistence.clear('a'), /媒体清理待重试/);
    assert.deepEqual(runs(app.documents.get('a')), []);
    assert.deepEqual(await app.persistence.clear('a'), { status: 'cleared' });
    assert.equal(releases, 2);
});
