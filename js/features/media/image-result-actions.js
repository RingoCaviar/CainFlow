import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

let menuSequence = 0;

// Every surface supplies a fixed original and a liveness check, never a "latest result" lookup.
export function createImageResultActions({ documentRef, source, getWorkflowId, openPreview, prepareReference,
    downloadImage, copyImage, showToast = () => {}, disabled = false }) {
    const element = documentRef.createElement('div'); element.className = 'image-result-actions';
    element.setAttribute('role', 'toolbar'); element.setAttribute('aria-label', '图片结果操作');
    const labels = { preview: '放大', reference: '用作参考', edit: '交给助手修改', download: '下载' };
    const buttons = new Map();
    const current = workflowId => getWorkflowId() === workflowId && source.isCurrent() !== false;
    const execute = async action => {
        const workflowId = getWorkflowId();
        if (disabled || !current(workflowId)) return;
        const button = buttons.get(action);
        if (button?.dataset.resultBusy === '1') return;
        if (button) { button.disabled = true; button.dataset.resultBusy = '1'; button.setAttribute('aria-busy', 'true'); }
        try {
            const image = await source.readOriginal();
            if (!current(workflowId)) return;
            if (!/^data:image\//i.test(image || '')) throw new Error('原图不可用，请先恢复原图。');
            if (action === 'preview') await openPreview(image, () => {
                if (!current(workflowId)) return;
                if (source.restoreFocus) source.restoreFocus();
                else if (button?.isConnected && !button.closest('[inert]')) button.focus({ preventScroll: true });
            });
            else if (action === 'reference' || action === 'edit') {
                source.beforeHandoff?.();
                await prepareReference({ workflowId, image, assetKey: source.assetKey, historyId: source.historyId, name: source.name }, { edit: action === 'edit' });
            } else if (action === 'download') await downloadImage(image, source);
            else if (action === 'copy') await copyImage(image);
        } catch (error) {
            if (current(workflowId)) showToast(error.message || '图片操作失败', 'warning');
        } finally {
            if (button) {
                delete button.dataset.resultBusy; button.removeAttribute('aria-busy');
                if (button.isConnected) button.disabled = disabled || button.dataset.runningLockApplied === '1' || button.dataset.cloneLocked === '1';
            }
        }
    };
    for (const [action, label] of Object.entries(labels)) {
        const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = label;
        button.dataset.resultAction = action; button.dataset.nodeReadAction = 'true'; button.disabled = disabled;
        button.addEventListener('click', event => { event.stopPropagation(); void execute(action); });
        buttons.set(action, button); element.append(button);
    }
    if (copyImage) {
        const trigger = documentRef.createElement('button'); trigger.type = 'button'; trigger.textContent = '更多';
        trigger.dataset.resultAction = 'more'; trigger.dataset.nodeReadAction = 'true'; trigger.disabled = disabled;
        trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
        const surfaces = getSurfaceCoordinator(documentRef), menuId = `image-result-actions-${++menuSequence}`;
        let menu;
        const close = () => { menu?.remove(); menu = null; trigger.setAttribute('aria-expanded', 'false'); surfaces?.forgetPopover(menuId); };
        trigger.addEventListener('click', event => {
            event.stopPropagation();
            if (menu) { close(); return; }
            menu = documentRef.createElement('div'); menu.className = 'context-menu image-result-menu'; menu.setAttribute('role', 'menu');
            const copy = documentRef.createElement('button'); copy.type = 'button'; copy.className = 'context-menu-item';
            copy.textContent = '复制图片'; copy.setAttribute('role', 'menuitem');
            copy.addEventListener('click', event => { event.stopPropagation(); close(); void execute('copy'); });
            menu.append(copy); documentRef.body.append(menu);
            const rect = trigger.getBoundingClientRect(), view = documentRef.defaultView;
            Object.assign(menu.style, { position: 'fixed', left: `${Math.max(6, Math.min(rect.right - 170, view.innerWidth - 176))}px`,
                top: `${Math.max(6, rect.top > menu.offsetHeight + 12 ? rect.top - menu.offsetHeight - 6 : Math.min(rect.bottom + 6, view.innerHeight - menu.offsetHeight - 6))}px` });
            trigger.setAttribute('aria-expanded', 'true');
            surfaces?.openPopover(menuId, { element: menu, trigger, owner: element.closest('#prompt-agent-panel, #history-preview-modal, .fullscreen-overlay'), close });
            menu.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); }
                else if (event.key === 'Tab') close();
            });
            copy.focus();
        });
        element.append(trigger);
    }
    return { element, execute };
}
