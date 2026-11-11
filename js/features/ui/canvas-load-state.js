// The latest navigation owns the visible loading state; stale completions cannot clear it.
const owners = new WeakMap();
export function beginCanvasLoad(documentRef) {
    const root = documentRef?.documentElement;
    if (!root?.dataset) return () => {};
    const token = {};
    owners.set(root, token);
    const render = status => {
        root.dataset.canvasLoadState = status;
        const canvas = documentRef.getElementById('canvas-container');
        canvas?.setAttribute('aria-busy', String(status === 'loading'));
        const loading = documentRef.getElementById('canvas-loading-state');
        if (!loading) return;
        loading.hidden = status === 'ready';
        loading.querySelector('[data-canvas-load-progress]').hidden = status !== 'loading';
        loading.querySelector('[data-canvas-load-label]').textContent = status === 'error'
            ? '工作流加载失败，请重新打开或刷新页面。' : '正在加载工作流…';
    };
    render('loading');
    return (failed = false) => { if (owners.get(root) === token) render(failed ? 'error' : 'ready'); };
}
