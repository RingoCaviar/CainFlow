export function createSettingsCloseCoordinator({
    getModels,
    isKnownModelProtocol,
    guideIncompleteModel,
    closeTopSettingsOverlay = () => false,
    closeSettingsOverlays,
    closeSettingsModal,
    pauseNotificationAudio
}) {
    function requestCloseSettings({ bypassValidation = false } = {}) {
        const incompleteModels = bypassValidation
            ? []
            : getModels().filter((model) => !isKnownModelProtocol(String(model?.protocol || '').trim()));

        if (incompleteModels.length > 0) {
            const firstIncompleteModel = incompleteModels[0];
            guideIncompleteModel(firstIncompleteModel, incompleteModels.length);
            return {
                closed: false,
                incompleteModelCount: incompleteModels.length,
                firstIncompleteModelId: firstIncompleteModel.id
            };
        }

        closeSettingsOverlays();
        closeSettingsModal();
        pauseNotificationAudio();
        return { closed: true, incompleteModelCount: 0, firstIncompleteModelId: '' };
    }

    function handleEscape() {
        if (closeTopSettingsOverlay()) return { closed: false, overlayClosed: true };
        return requestCloseSettings();
    }

    return { requestCloseSettings, handleEscape };
}
