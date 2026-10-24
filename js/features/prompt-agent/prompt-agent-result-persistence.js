import { createPromptAgentConversationStore } from './prompt-agent-conversation-store.js';
import { stampResultCompletion } from './prompt-agent-result-order.js';

const clone = value => JSON.parse(JSON.stringify(value));
const runKey = (workflowId, runId) => JSON.stringify([workflowId, runId]);
const allRuns = snapshot => [...(snapshot?.archivedMessages || []), ...(snapshot?.messages || [])]
    .flatMap(message => message.runs || []);

/** Own the complete result handoff; conversation documents remain authoritative. */
export function createPromptAgentResultPersistence({
    mutateConversation,
    saveConversation = async () => {},
    media = null,
    onChange = () => {}
} = {}) {
    const tasks = new Map();
    const images = new Map();
    const clears = new Map();

    function changed(workflowId) {
        // Presentation failure must not interrupt an ownership handoff.
        try { onChange(workflowId); } catch { /* The document is still authoritative. */ }
    }

    function readRun(workflowId, runId) {
        let found = null;
        mutateConversation(workflowId, snapshot => {
            const run = allRuns(snapshot).find(item => item.runId === runId);
            if (run) found = clone(run);
            return false;
        });
        return found;
    }

    function updateRun(workflowId, runId, patch) {
        return mutateConversation(workflowId, snapshot => {
            const run = allRuns(snapshot).find(item => item.runId === runId);
            if (!run) return false;
            if (run.mediaAssetKeys?.length && Array.isArray(patch.mediaAssetKeys)
                && JSON.stringify(run.mediaAssetKeys) !== JSON.stringify(patch.mediaAssetKeys)) return false;
            Object.assign(run, patch);
            stampResultCompletion(snapshot, run);
            return snapshot;
        });
    }

    const release = (workflowId, runId, result) => media?.release({ ...result, workflowId, runId }) ?? true;

    async function discard(workflowId, runId, result) {
        // A late retention may finish while clear is still being saved. Never
        // release protection until that removal has actually become durable.
        const clearing = clears.get(workflowId);
        if (clearing) clearing.runs.set(runId, { runId,
            mediaAssetKeys: result.mediaAssetKeys || [],
            mediaOwnershipTemporaryOwners: result.mediaOwnershipTemporaryOwners || [] });
        await clearing?.durable;
        await release(workflowId, runId, result);
        images.delete(runKey(workflowId, runId));
        return { status: 'discarded' };
    }

    async function persist(workflowId, runId, result) {
        const key = runKey(workflowId, runId);
        let retained;
        let handoffComplete = false;
        try {
            const current = readRun(workflowId, runId);
            if (!current) return { status: 'discarded' };
            if (current.persistenceStatus === 'saved') return { status: 'saved' };
            // A retry always reads current ownership, never a caller's old run.
            retained = { ...current, ...result };
            if (current.mediaAssetKeys?.length && result?.mediaAssetKeys?.length
                && JSON.stringify(current.mediaAssetKeys) !== JSON.stringify(result.mediaAssetKeys)) {
                return { status: 'discarded' };
            }
            if (current.mediaAssetKeys?.length) retained.mediaAssetKeys = current.mediaAssetKeys;
            retained.mediaOwnershipTemporaryOwners = current.mediaOwnershipTemporaryOwners || [];
            if (result?.images?.length) images.set(key, result.images.slice());
            // Capture completion before asynchronous saves; a retry is not a
            // newer generation, even if another run finishes in the meantime.
            updateRun(workflowId, runId, { status: 'completed' });
            if (retained.mediaOwnershipTemporaryOwners.length) {
                retained.persistenceStatus = 'retained';
                retained.persistenceError = '';
            } else if (media) {
                retained = { ...retained, ...await media.retain({ workflowId, runId,
                    images: images.get(key) || [], mediaAssetKeys: retained.mediaAssetKeys || [] }) };
            }
            if (retained.persistenceStatus !== 'failed') retained.persistenceError = '';
            const accepted = updateRun(workflowId, runId, {
                status: 'completed', mediaAssetKeys: retained.mediaAssetKeys || [],
                persistenceStatus: retained.persistenceStatus === 'failed' ? 'failed' : 'retained',
                persistenceError: retained.persistenceError || '',
                mediaOwnershipTemporaryOwners: retained.mediaOwnershipTemporaryOwners || []
            });
            if (!accepted) return await discard(workflowId, runId, retained);
            if (retained.persistenceStatus === 'failed') return { status: 'failed', error: retained.persistenceError };
            await saveConversation();
            if (!readRun(workflowId, runId)) return await discard(workflowId, runId, retained);
            if (await release(workflowId, runId, retained) === false) {
                throw new Error('图片已保存，媒体引用交接尚未完成，请重试保存。');
            }
            handoffComplete = true;
            updateRun(workflowId, runId, {
                persistenceStatus: 'saved', persistenceError: '', mediaOwnershipTemporaryOwners: []
            });
            await saveConversation();
            return { status: 'saved' };
        } catch (error) {
            // Once ownership is durable and released, a cosmetic marker flush
            // must not invite rematerialization of an already fenced operation.
            if (handoffComplete) return { status: 'saved' };
            const recorded = updateRun(workflowId, runId, {
                status: 'completed', persistenceStatus: 'failed', persistenceError: error?.message || '本地保存失败'
            });
            return { status: recorded ? 'failed' : 'discarded', error: error?.message || '本地保存失败' };
        }
    }

    function save(workflowId, runId, result) {
        const key = runKey(workflowId, runId);
        if (tasks.has(key)) return tasks.get(key);
        const captured = result ? clone(result) : undefined;
        const task = Promise.resolve().then(() => persist(workflowId, runId, captured)).finally(() => {
            tasks.delete(key);
            changed(workflowId);
        });
        tasks.set(key, task);
        changed(workflowId);
        return task;
    }

    function retry(workflowId, runId) {
        return save(workflowId, runId);
    }

    function clear(workflowId) {
        const previous = clears.get(workflowId);
        const runs = new Map(previous?.runs || []);
        const accepted = mutateConversation(workflowId, snapshot => {
            for (const run of allRuns(snapshot)) runs.set(run.runId, clone(run));
            const store = createPromptAgentConversationStore();
            store.restore(snapshot);
            store.clear();
            return store.snapshot();
        });
        for (const key of images.keys()) if (JSON.parse(key)[0] === workflowId) images.delete(key);
        if (!accepted) return Promise.resolve({ status: 'discarded' });
        // Publish the barrier before any asynchronous retention can finish.
        const durable = Promise.resolve().then(() => saveConversation());
        const entry = { runs, durable };
        clears.set(workflowId, entry);
        changed(workflowId);
        return durable.then(async () => {
            const released = await Promise.all([...runs.values()].map(run => release(workflowId, run.runId, run)));
            if (released.some(value => value === false)) throw new Error('媒体清理待重试');
            if (clears.get(workflowId) === entry) clears.delete(workflowId);
            return { status: 'cleared' };
        });
    }

    function read(workflowId, runId) {
        const key = runKey(workflowId, runId);
        return { saving: tasks.has(key), images: images.get(key)?.slice() };
    }

    return Object.freeze({ save, retry, clear, read });
}
