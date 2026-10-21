/**
 * 封装设置弹窗的开关与打开前回调，作为设置界面的轻量外层控制器。
 */
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';

export function createSettingsModalApi({ settingsModal, onOpen }) {
    let returnTo = null;
    function openSettingsModal(options = {}) {
        getSurfaceCoordinator(settingsModal.ownerDocument || document)?.closePopovers();
        returnTo = typeof options.onClose === 'function' ? options.onClose : null;
        document.querySelectorAll('.modal-tab-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === 'api');
        });
        document.querySelectorAll('.settings-tab-pane').forEach((pane) => {
            const isApiPane = pane.id === 'settings-tab-api';
            pane.classList.toggle('active', isApiPane);
            pane.hidden = !isApiPane;
        });
        onOpen();
        settingsModal.classList.remove('hidden');
    }

    function closeSettingsModal(onClose) {
        settingsModal.classList.add('hidden');
        if (onClose) onClose();
        const callback = returnTo;
        returnTo = null;
        if (callback) queueMicrotask(callback);
    }

    return {
        openSettingsModal,
        closeSettingsModal
    };
}
/**
 * 封装设置弹窗的打开、关闭和默认标签切换逻辑。
 */
