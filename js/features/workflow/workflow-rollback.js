export async function rollbackWorkflowActivation({
    prepared,
    restorePrevious,
    cleanupCreatedTarget,
    restoreExistingTarget,
    enterSafeEmpty,
    reveal,
    render,
    onRestoreError = () => {}
}) {
    let safeEmpty = false;
    try {
        const restored = await restorePrevious(prepared.previous);
        if (restored === false) throw new Error('Previous workflow view could not be restored');
    } catch (error) {
        safeEmpty = true;
        onRestoreError(error);
        enterSafeEmpty();
    } finally {
        if (prepared.createdTab) cleanupCreatedTarget(prepared.tab);
        else if (prepared.previousTarget) restoreExistingTarget(prepared.tab, prepared.previousTarget);
        reveal();
        render();
    }
    return { safeEmpty };
}
