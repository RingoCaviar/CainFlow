export class WorkflowActivationSupersededError extends Error {
    constructor() {
        super('Workflow activation was superseded');
        this.name = 'WorkflowActivationSupersededError';
    }
}

export function createWorkflowTransitionLane({ onError = () => {}, maxValidationRetries = 3 } = {}) {
    let generation = 0;
    let activeKey = '';
    let pending = null;
    let commitTail = Promise.resolve();

    function isCurrent(token) {
        return token === generation;
    }

    async function disposePrepared(prepared) {
        if (typeof prepared?.dispose !== 'function') return;
        await prepared.dispose();
    }

    function activate(key, operations, validationRetries = 0) {
        if (!key) return Promise.resolve(false);
        if (key === activeKey && !pending && operations?.force !== true) return Promise.resolve(true);
        if (pending?.key === key && operations?.force !== true) return pending.promise;

        const token = ++generation;
        pending?.abortController.abort();
        const abortController = new AbortController();
        const task = (async () => {
            let prepared = null;
            let commitAttempted = false;
            let rollbackAttempted = false;
            let rollbackResult = null;
            try {
                prepared = await operations.prepare({ key, token, signal: abortController.signal });
                if (prepared == null) return false;
                if (!isCurrent(token)) {
                    await disposePrepared(prepared);
                    return false;
                }

                const previousCommit = commitTail;
                let releaseCommit;
                commitTail = new Promise((resolve) => { releaseCommit = resolve; });
                await previousCommit;
                try {
                    if (!isCurrent(token)) {
                        await disposePrepared(prepared);
                        return false;
                    }
                    const validationResult = typeof operations.validate === 'function'
                        ? operations.validate(prepared)
                        : true;
                    if (validationResult == null) {
                        await disposePrepared(prepared);
                        prepared = null;
                        return false;
                    }
                    if (validationResult === false) {
                        await disposePrepared(prepared);
                        prepared = null;
                        if (validationRetries >= maxValidationRetries) {
                            onError(new Error('Workflow activation target did not stabilize'), {
                                key,
                                token,
                                phase: 'validate',
                                validationRetries
                            });
                            return false;
                        }
                        if (pending?.token === token) pending = null;
                        return activate(key, operations, validationRetries + 1);
                    }
                    commitAttempted = true;
                    const committed = await operations.commit(prepared, {
                        key,
                        token,
                        signal: abortController.signal,
                        isCurrent: () => isCurrent(token)
                    });
                    if (committed === false || !isCurrent(token)) {
                        rollbackAttempted = true;
                        rollbackResult = await operations.rollback?.(prepared, { key, token, superseded: !isCurrent(token) });
                        return false;
                    }
                    try {
                        operations.finalize?.(prepared, { key, token });
                    } catch (finalizeError) {
                        onError(finalizeError, { key, token, phase: 'finalize' });
                    }
                    activeKey = typeof operations.getActiveKey === 'function'
                        ? (operations.getActiveKey(prepared) || key)
                        : key;
                    return true;
                } finally {
                    releaseCommit();
                }
            } catch (error) {
                if (rollbackAttempted) {
                    await disposePrepared(prepared);
                    onError(error, { key, token, phase: 'rollback' });
                    return false;
                }
                if (commitAttempted && !rollbackAttempted) {
                    try {
                        rollbackAttempted = true;
                        rollbackResult = await operations.rollback?.(prepared, { key, token, error, superseded: !isCurrent(token) });
                    } catch (rollbackError) {
                        onError(rollbackError, { key, token, phase: 'rollback', cause: error });
                    }
                }
                if (abortController.signal.aborted || !isCurrent(token) || error instanceof WorkflowActivationSupersededError) {
                    await disposePrepared(prepared);
                    return false;
                }
                await disposePrepared(prepared);
                onError(error, { key, token, rollbackResult });
                return false;
            } finally {
                if (pending?.token === token) pending = null;
            }
        })();
        pending = { key, token, promise: task, abortController };
        return task;
    }

    function setActiveKey(key = '') {
        activeKey = key || '';
    }

    function cancel() {
        generation += 1;
        pending?.abortController.abort();
        pending = null;
    }

    function resetActive() {
        activeKey = '';
    }

    function retainActive(key) {
        if (!key || key !== activeKey) return false;
        generation += 1;
        pending?.abortController.abort();
        pending = null;
        return true;
    }

    return { activate, cancel, isCurrent, resetActive, retainActive, setActiveKey };
}
