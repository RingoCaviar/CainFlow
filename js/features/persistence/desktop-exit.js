export function createDesktopExit({ settle, save, release, finish, finishRestart,
    hasRunningTasks = () => false, confirmDiscard, setBlocked, report }) {
    let pending = null;
    return ({ restartJobId = '' } = {}) => {
        if (pending) return pending;
        pending = Promise.resolve().then(async () => {
            let blocked = true;
            setBlocked(true);
            try {
                const checkRestart = () => {
                    if (restartJobId && hasRunningTasks()) throw new Error('仍有生成或 Agent 任务运行，请等待任务完成后再重启');
                    if (restartJobId && !finishRestart) throw new Error('当前环境不支持自动重启，请手动重启主程序');
                };
                checkRestart();
                await settle({ restart: Boolean(restartJobId) });
                checkRestart();
                await save();
                checkRestart();
                // Restart preparation may fail. Keep Undo usable until the process
                // actually exits; backend shutdown releases its temporary owners.
                if (!restartJobId) {
                    try { await release(); } catch (error) { report(error); }
                }
                if (restartJobId) await finishRestart(restartJobId);
                else await finish();
                return true;
            } catch (error) {
                report(error);
                setBlocked(false);
                blocked = false;
                if (!restartJobId && await confirmDiscard(error)) {
                    // The backend releases this process's temporary protection;
                    // durable workflow and Agent references remain untouched.
                    await finish();
                    return true;
                }
                return false;
            } finally { if (blocked) setBlocked(false); pending = null; }
        });
        return pending;
    };
}
