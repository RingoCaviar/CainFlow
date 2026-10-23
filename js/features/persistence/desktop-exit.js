export function createDesktopExit({ settle, save, release, finish, confirmDiscard, setBlocked, report }) {
    let pending = null;
    return () => {
        if (pending) return pending;
        pending = (async () => {
            let blocked = true;
            setBlocked(true);
            try {
                await settle();
                await save();
                try { await release(); } catch (error) { report(error); }
                await finish();
            } catch (error) {
                report(error);
                setBlocked(false);
                blocked = false;
                if (await confirmDiscard(error)) {
                    // The backend releases this process's temporary protection;
                    // durable workflow and Agent references remain untouched.
                    await finish();
                }
            } finally { if (blocked) setBlocked(false); pending = null; }
        })();
        return pending;
    };
}
