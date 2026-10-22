export function createDesktopExit({ settle, save, release, finish, confirmDiscard, setBlocked, report }) {
    let pending = null;
    return () => {
        if (pending) return pending;
        pending = (async () => {
            setBlocked(true);
            try {
                await settle();
                await save();
                try { await release(); } catch (error) { report(error); }
                await finish();
            } catch (error) {
                report(error);
                if (await confirmDiscard(error)) {
                    // The backend releases this process's temporary protection;
                    // durable workflow and Agent references remain untouched.
                    await finish();
                }
            } finally { setBlocked(false); pending = null; }
        })();
        return pending;
    };
}
