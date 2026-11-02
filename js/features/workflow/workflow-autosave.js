/** Debounce durable writes by workflow identity, retaining edits made during a write. */
export function createWorkflowAutosave({ save, onFailure = () => {}, onSaved = () => {},
    canSave = () => true, isBlocked = () => false, delay = 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const pending = new Map();
    const running = new Map();
    const timers = new Map();
    let revision = 0;

    function cancelTimer(id) {
        clearTimer(timers.get(id));
        timers.delete(id);
    }

    function schedule(id) {
        cancelTimer(id);
        const timer = setTimer(() => { timers.delete(id); void flush(id); }, delay);
        timer?.unref?.();
        timers.set(id, timer);
    }

    function change(id) {
        if (!id) return;
        pending.set(id, ++revision);
        schedule(id);
    }

    async function flush(id, force = false) {
        cancelTimer(id);
        if (running.has(id)) {
            if (!await running.get(id)) return false;
            return pending.has(id) ? flush(id, force) : true;
        }
        if (!pending.has(id)) return true;
        if (isBlocked(id) || (!force && !canSave(id))) { schedule(id); return false; }
        const version = pending.get(id);
        const task = (async () => {
            try {
                if (!await save(id)) throw new Error('工作流保存失败');
                if (pending.get(id) === version) pending.delete(id);
                onSaved(id, pending.has(id));
                return true;
            } catch (error) {
                onFailure(id, error);
                return false;
            }
        })();
        running.set(id, task);
        try { return await task; }
        finally { running.delete(id); }
    }

    async function drain(ids = [...pending.keys()], { force = false } = {}) {
        const results = [];
        for (const id of ids) {
            let ok;
            do { ok = await flush(id, force); } while (ok && pending.has(id));
            results.push({ workflowId: id, status: ok ? 'committed' : 'failed' });
        }
        return { status: 'completed', results };
    }

    return { change, flush: drain, hasPending: () => pending.size > 0,
        isPending: id => pending.has(id),
        forget(id) { cancelTimer(id); pending.delete(id); } };
}
