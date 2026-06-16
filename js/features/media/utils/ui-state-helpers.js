/**
 * UI 状态查询工具函数
 * 用于检查界面状态、焦点、可见性等
 */

/**
 * 检查节点是否正在运行
 * @param {string} nodeId - 节点ID
 * @param {object} state - 全局状态
 * @param {Function} getNodeById - 获取节点的函数
 * @returns {boolean} 是否正在运行
 */
export function isNodeRunning(nodeId, state, getNodeById) {
    return state.runningNodeIds?.has(nodeId) || getNodeById(nodeId)?.el?.classList.contains('running');
}

/**
 * 检查用户是否正在输入字段中
 * @param {Document} documentRef - document 对象
 * @returns {boolean} 是否正在输入
 */
export function isTypingIntoField(documentRef) {
    const activeElement = documentRef.activeElement;
    return Boolean(activeElement && (
        activeElement.tagName === 'INPUT'
        || activeElement.tagName === 'TEXTAREA'
        || activeElement.tagName === 'SELECT'
        || activeElement.isContentEditable
    ));
}

/**
 * 检查是否有阻塞性沉浸式覆盖层
 * @param {Document} documentRef - document 对象
 * @returns {boolean} 是否有阻塞性覆盖层
 */
export function hasBlockingImmersiveOverlay(documentRef) {
    if (documentRef.querySelector('.fullscreen-overlay')) return true;
    const historyPreview = documentRef.getElementById('history-preview-modal');
    return Boolean(historyPreview && !historyPreview.classList.contains('hidden'));
}

/**
 * 获取当前聚焦的节点ID
 * @param {object} state - 全局状态
 * @returns {string|undefined} 节点ID，如果没有单个选中的节点则返回 undefined
 */
export function getFocusedNodeId(state) {
    if (state.selectedNodes?.size === 1) {
        const selectedNodeId = Array.from(state.selectedNodes)[0];
        if (state.nodes?.has(selectedNodeId)) return selectedNodeId;
    }
    return undefined;
}

/**
 * 检查元素是否在视口中可见（未被遮挡）
 * @param {HTMLElement} element - 待检查的元素
 * @param {Document} documentRef - document 对象
 * @param {Window} windowRef - window 对象
 * @returns {boolean} 是否可见
 */
export function isChromeElementExposed(element, documentRef, windowRef) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const x = Math.min(windowRef.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(windowRef.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const topElement = documentRef.elementFromPoint(x, y);
    return topElement === element || element.contains(topElement);
}

/**
 * 检查是否应该忽略 Chrome UI 偏移量（工具栏/侧边栏被遮挡时）
 * @param {Document} documentRef - document 对象
 * @param {Window} windowRef - window 对象
 * @returns {boolean} 是否应该忽略偏移量
 */
export function shouldIgnoreChromeOffsetForPreview(documentRef, windowRef) {
    const body = documentRef.body;
    if (!body) return false;

    const toolbarCovered = body.classList.contains('toolbar-pinned')
        && !isChromeElementExposed(documentRef.getElementById('toolbar'), documentRef, windowRef);
    const sidebarCovered = body.classList.contains('sidebar-pinned')
        && !isChromeElementExposed(documentRef.getElementById('side-bar'), documentRef, windowRef);

    return toolbarCovered || sidebarCovered;
}
