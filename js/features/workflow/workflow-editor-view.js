const EDITOR_STATE_KEYS = ['nodes', 'connections', 'selectedNodes', 'canvas'];

export function createPreparedWorkflowEditorView({
    liveState,
    liveRoot,
    targetState,
    targetRoot,
    capturePrevious = () => null,
    adoptTarget = () => {},
    restorePrevious = () => {},
    disposeTarget = () => {},
    disposePrevious = () => {},
    onFinalizeError = () => {}
}) {
    let previousState = null;
    let previousNodes = [];
    const targetNodes = Array.from(targetRoot?.childNodes || []);
    let status = 'prepared';
    let previousProjection = null;

    function applyState(source) {
        EDITOR_STATE_KEYS.forEach((key) => { liveState[key] = source[key]; });
    }

    return {
        commit() {
            if (status !== 'prepared') return false;
            previousState = Object.fromEntries(EDITOR_STATE_KEYS.map((key) => [key, liveState[key]]));
            previousNodes = Array.from(liveRoot?.childNodes || []);
            previousProjection = capturePrevious();
            status = 'committed';
            liveRoot.replaceChildren(...targetNodes);
            applyState(targetState);
            adoptTarget(targetState);
            return true;
        },
        rollback() {
            if (status === 'prepared') {
                disposeTarget();
                status = 'rolled-back';
                return true;
            }
            if (status !== 'committed') return false;
            liveRoot.replaceChildren(...previousNodes);
            applyState(previousState);
            restorePrevious(previousProjection);
            disposeTarget();
            status = 'rolled-back';
            return true;
        },
        finalize() {
            if (status !== 'committed') return false;
            status = 'finalized';
            try { disposePrevious(previousState); } catch (error) { onFinalizeError(error); }
            try { disposeTarget({ keepNodes: true }); } catch (error) { onFinalizeError(error); }
            return true;
        },
        dispose() {
            if (status !== 'prepared') return false;
            disposeTarget();
            status = 'disposed';
            return true;
        }
    };
}
