/**
 * 统一缓存页面关键 DOM 引用，减少散落的选择器访问并便于模块注入。
 */
export function createElements(doc = document) {
    return {
        canvasContainer: doc.getElementById('canvas-container'),
        nodesLayer: doc.getElementById('nodes-layer'),
        connectionsGroup: doc.getElementById('connections-group'),
        tempConnection: doc.getElementById('temp-connection'),
        originAxes: doc.getElementById('origin-axes'),
        contextMenu: doc.getElementById('context-menu'),
        toastContainer: doc.getElementById('toast-container'),
        logList: doc.getElementById('log-list'),
        historyList: doc.getElementById('history-list'),
        workflowList: doc.getElementById('workflow-list'),
        zoomLevel: doc.getElementById('zoom-level'),
        btnLogs: doc.getElementById('btn-logs'),
        errorModal: {
            root: doc.getElementById('modal-error'),
            title: doc.getElementById('error-modal-title'),
            msg: doc.getElementById('error-modal-msg'),
            detail: doc.getElementById('error-modal-detail')
        }
    };
}
/**
 * 统一缓存页面关键 DOM 引用，减少散落的选择器访问。
 */
