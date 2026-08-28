const EDITOR_STATE_KEYS = ['nodes', 'connections', 'selectedNodes', 'canvas'];

function getWorkflowViewKey(workflowReference, workflowData) {
    if (workflowReference && typeof workflowReference === 'object') {
        if (workflowReference.workflowId) return workflowReference.workflowId;
        if (workflowReference.workflowName) return `path:${workflowReference.workflowName}`;
    }
    if (workflowData?.workflowId) return workflowData.workflowId;
    return typeof workflowReference === 'string' && workflowReference
        ? `path:${workflowReference}`
        : '';
}

export function createDetachedWorkflowViewBuilder({
    liveState,
    visibleNodesLayer,
    createRuntimeContext,
    bindVisibleNodeInteractions = () => {},
    visibleConnectionProjectionMaintenance = null
}) {
    const entries = new Map();
    let activeEntry = null;

    function applyState(source) {
        EDITOR_STATE_KEYS.forEach((key) => { liveState[key] = source[key]; });
    }

    function captureLiveState() {
        return Object.fromEntries(EDITOR_STATE_KEYS.map((key) => [key, liveState[key]]));
    }

    function disposeEntry(entry) {
        if (!entry || entry.disposed) return false;
        entry.disposed = true;
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        entry.context.dispose();
        return true;
    }

    async function createEntry(key, workflowReference, workflowData) {
        const context = createRuntimeContext(workflowReference, workflowData);
        try {
            await context.waitForImageRestores();
        } catch (error) {
            context.dispose();
            throw error;
        }
        context.refreshConnectionProjection();
        const entry = {
            key,
            context,
            state: context.state,
            nodes: Array.from(context.elements.nodesLayer?.childNodes || []),
            projectionHandoff: context.captureConnectionProjectionHandoff(),
            bound: false,
            activated: false,
            released: false,
            disposed: false
        };
        entries.set(key, entry);
        return entry;
    }

    async function prepare(workflowReference, workflowData) {
        if (!visibleNodesLayer) throw new Error('Visible workflow editor root is unavailable');
        const key = getWorkflowViewKey(workflowReference, workflowData);
        if (!key) throw new Error('Stable workflow editor view identity is required');
        const cachedEntry = entries.get(key);
        let entry = cachedEntry;
        if (!entry) {
            try {
                entry = await createEntry(key, workflowReference, workflowData);
            } catch (error) {
                if (activeEntry?.key === key && activeEntry.released && !activeEntry.disposed) {
                    activeEntry.released = false;
                    entries.set(key, activeEntry);
                }
                throw error;
            }
        }
        const created = !cachedEntry;
        const replacedEntry = created && activeEntry?.key === key && activeEntry.released
            ? activeEntry
            : null;
        let status = 'prepared';
        let previous = null;

        function discardCreatedEntry() {
            if (created && activeEntry !== entry) {
                disposeEntry(entry);
                if (replacedEntry && !replacedEntry.disposed) {
                    replacedEntry.released = false;
                    entries.set(replacedEntry.key, replacedEntry);
                }
            }
        }

        return {
            async commit({ signal = null } = {}) {
                if (status !== 'prepared' || signal?.aborted) return false;
                previous = {
                    entry: activeEntry,
                    state: captureLiveState(),
                    nodes: Array.from(visibleNodesLayer.childNodes || []),
                    projectionHandoff: visibleConnectionProjectionMaintenance?.captureViewHandoff?.()
                };
                if (activeEntry && activeEntry !== entry) {
                    EDITOR_STATE_KEYS.forEach((stateKey) => {
                        activeEntry.state[stateKey] = previous.state[stateKey];
                    });
                    activeEntry.nodes = previous.nodes;
                    activeEntry.projectionHandoff = previous.projectionHandoff;
                }
                status = 'committed';
                visibleNodesLayer.replaceChildren(...entry.nodes);
                applyState(entry.state);
                if (!entry.bound) {
                    entry.state.nodes.forEach((node) => bindVisibleNodeInteractions({
                        id: node.id,
                        type: node.type,
                        el: node.el
                    }));
                    entry.bound = true;
                }
                visibleConnectionProjectionMaintenance?.adoptViewHandoff?.(entry.projectionHandoff);
                activeEntry = entry;
                if (!entry.activated) {
                    const restored = await visibleConnectionProjectionMaintenance?.workflowRestored?.({ signal });
                    if (restored === false) return false;
                }
                return true;
            },
            rollback() {
                if (status === 'prepared') {
                    discardCreatedEntry();
                    status = 'rolled-back';
                    return true;
                }
                if (status !== 'committed' || !previous) return false;
                visibleNodesLayer.replaceChildren(...previous.nodes);
                applyState(previous.state);
                visibleConnectionProjectionMaintenance?.adoptViewHandoff?.(previous.projectionHandoff);
                activeEntry = previous.entry;
                if (previous.entry?.released) {
                    previous.entry.released = false;
                    entries.set(previous.entry.key, previous.entry);
                }
                discardCreatedEntry();
                status = 'rolled-back';
                return true;
            },
            finalize() {
                if (status !== 'committed') return false;
                entry.nodes = Array.from(visibleNodesLayer.childNodes || []);
                entry.activated = true;
                if (previous?.entry?.released && previous.entry !== entry) {
                    disposeEntry(previous.entry);
                }
                status = 'finalized';
                return true;
            },
            dispose() {
                if (status !== 'prepared') return false;
                discardCreatedEntry();
                status = 'disposed';
                return true;
            }
        };
    }

    function release(workflowReference) {
        const key = getWorkflowViewKey(workflowReference, null);
        const entry = entries.get(key);
        if (!entry) return false;
        if (entry === activeEntry) {
            entries.delete(key);
            entry.released = true;
            return true;
        }
        return disposeEntry(entry);
    }

    return { prepare, release };
}
