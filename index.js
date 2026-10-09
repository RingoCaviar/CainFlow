// Keep the recovery shell independent of the application module graph.
const recovery = document.getElementById('startup-recovery');
const message = recovery?.querySelector('p');
let startupFinished = false;
const waitingTimer = setTimeout(() => {
    if (startupFinished || !recovery) return;
    if (message) message.textContent = '启动仍未完成，请稍候。若长时间没有变化，可以手动重新加载。';
    recovery.hidden = false;
}, 20000);

import('./js/app/bootstrap.js')
    .then(({ bootstrapCainFlowApp }) => bootstrapCainFlowApp())
    .then(() => {
        startupFinished = true;
        clearTimeout(waitingTimer);
        if (recovery) recovery.hidden = true;
    })
    .catch(() => {
        startupFinished = true;
        clearTimeout(waitingTimer);
        if (message) message.textContent = '启动失败，工作流数据未被此恢复功能清除。请重新加载或关闭后重开。';
        if (recovery) recovery.hidden = false;
        // The bootstrap module retains its existing internal error state.
    });
