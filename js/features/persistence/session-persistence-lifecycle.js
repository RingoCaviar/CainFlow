export function installSessionPersistenceOnExit({ windowRef = window, flushSession = () => {},
    flushWorkflows = async () => {}, hasPendingWorkflows = () => false } = {}) {
    if (typeof windowRef?.addEventListener !== 'function') return;
    let flushed = false;
    const flush = () => {
        if (flushed) return;
        flushed = true;
        flushSession();
    };
    windowRef.addEventListener('pagehide', flush);
    windowRef.addEventListener('beforeunload', event => {
        // Browsers cannot await asynchronous writes during unload. Preserve the
        // recovery cache and guard navigation until the durable write completes.
        if (hasPendingWorkflows()) {
            flushSession();
            void Promise.resolve(flushWorkflows()).catch(() => {});
            event?.preventDefault?.();
            if (event) event.returnValue = '';
            return;
        }
        flush();
    });
    windowRef.addEventListener('pageshow', () => { flushed = false; });
    windowRef.addEventListener('focus', () => { flushed = false; });
}
