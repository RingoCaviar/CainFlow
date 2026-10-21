export async function flushSessionToDisk(sessionManager, diskStorage) {
    if (!sessionManager.flushSave()) throw new Error('会话保存失败，请重试保存。');
    try {
        // Confirm this session snapshot, not the outcome of unrelated settings.
        await diskStorage.waitForKey('nodeflow_ai_state');
    } catch (error) {
        throw new Error(`会话保存失败：${error?.message || '请重试保存。'}`);
    }
}
