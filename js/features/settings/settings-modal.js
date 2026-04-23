/**
 * 封装设置弹窗的开关与打开前回调，作为设置界面的轻量外层控制器。
 */
export function createSettingsModalApi({ settingsModal, onOpen }) {
    function openSettingsModal() {
        document.querySelectorAll('.modal-tab-btn').forEach((button) => {
            button.classList.toggle('active', button.dataset.tab === 'api');
        });
        document.querySelectorAll('.settings-tab-pane').forEach((pane) => {
            pane.classList.toggle('active', pane.id === 'settings-tab-api');
        });
        onOpen();
        settingsModal.classList.remove('hidden');
    }

    function closeSettingsModal(onClose) {
        settingsModal.classList.add('hidden');
        if (onClose) onClose();
    }

    return {
        openSettingsModal,
        closeSettingsModal
    };
}
/**
 * 封装设置弹窗的打开、关闭和默认标签切换逻辑。
 */
