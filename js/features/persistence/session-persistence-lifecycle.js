export function installSessionPersistenceOnExit({ windowRef = window, flushSession = () => {} } = {}) {
    if (typeof windowRef?.addEventListener !== 'function') return;
    let flushed = false;
    const flush = () => {
        if (flushed) return;
        flushed = true;
        flushSession();
    };
    windowRef.addEventListener('pagehide', flush);
    windowRef.addEventListener('beforeunload', flush);
}
