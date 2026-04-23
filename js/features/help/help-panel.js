/**
 * 管理帮助面板的打开关闭与画布状态联动，为用户提供内置说明入口。
 */
export function createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    closeHistorySidebar,
    documentRef = document
}) {
    const helpContent = `
    <div class="help-section">
        <h4>核心快捷键</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-key">Ctrl + Enter</span><span class="help-desc">运行工作流</span></div>
            <div class="help-item"><span class="help-key">Ctrl + S</span><span class="help-desc">保存工作流</span></div>
            <div class="help-item"><span class="help-key">Ctrl + Z</span><span class="help-desc">撤销操作</span></div>
            <div class="help-item"><span class="help-key">Delete</span><span class="help-desc">删除选中节点</span></div>
            <div class="help-item"><span class="help-key">F</span><span class="help-desc">自适应缩放视图</span></div>
            <div class="help-item"><span class="help-key">D</span><span class="help-desc">启用/禁用选中节点</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>鼠标与画布</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">右键画布</span><span class="help-key">添加节点菜单</span></div>
            <div class="help-item"><span class="help-desc">框选后右键</span><span class="help-key">只运行选中的节点</span></div>
            <div class="help-item"><span class="help-desc">中键/空格+左键</span><span class="help-key">平移画布</span></div>
            <div class="help-item"><span class="help-desc">滚轮</span><span class="help-key">缩放视图</span></div>
            <div class="help-item"><span class="help-desc">双击连接线</span><span class="help-key">断开连接</span></div>
            <div class="help-item"><span class="help-desc">Ctrl+右键拖拽</span><span class="help-key">剪断连接线</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>节点协作</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">拖拽圆点</span><span class="help-key">创建连接</span></div>
            <div class="help-item"><span class="help-desc">Ctrl + 拖拽</span><span class="help-key">克隆节点</span></div>
        </div>
    </div>
    <div class="help-tip">
        <div>配合“自动重试”功能，可以大幅提升生图成功率。</div>
        <div style="margin-top: 4px;">“只运行选中的节点”只执行当前选择集，未选中的上下游不会自动运行，但会尽量读取上游已有缓存值。</div>
        <div style="margin-top: 4px; color: var(--accent-orange); opacity: 0.9;">提示：建议使用 <span class="help-key" style="color: var(--accent-orange); border-color: rgba(245, 158, 11, 0.3);">Ctrl + F5</span> 进行强制刷新，以获取最新版本。</div>
    </div>
`;

    function closeHelpPanel() {
        const panel = documentRef.getElementById('help-panel');
        const btnHelp = documentRef.getElementById('btn-help');
        panel?.classList.add('hidden');
        btnHelp?.classList.remove('active');
    }

    function toggleHelpPanel() {
        const panel = documentRef.getElementById('help-panel');
        const content = documentRef.getElementById('help-panel-content');
        const btnHelp = documentRef.getElementById('btn-help');

        if (!panel || !content) return;

        if (panel.classList.contains('hidden')) {
            content.innerHTML = helpContent;
            panel.classList.remove('hidden');
            btnHelp?.classList.add('active');

            const historySidebar = documentRef.getElementById('history-sidebar');
            if (historySidebar && !historySidebar.classList.contains('hidden')) {
                closeHistorySidebar?.();
            }
        } else {
            closeHelpPanel();
        }
    }

    function initHelpPanel() {
        documentRef.getElementById('btn-help')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleHelpPanel();
        });

        documentRef.getElementById('btn-close-help')?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeHelpPanel();
        });

        canvasContainer?.addEventListener('mousedown', (e) => {
            if (e.target === canvasContainer || e.target === nodesLayer) {
                closeHelpPanel();
            }
        });

        documentRef.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeHelpPanel();
            }
        });
    }

    return {
        initHelpPanel,
        toggleHelpPanel,
        closeHelpPanel
    };
}
