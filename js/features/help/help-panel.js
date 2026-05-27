/**
 * Manages the floating help panel and keeps the in-app operation guide current.
 */
export function createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    closeHistorySidebar,
    documentRef = document
}) {
    const helpContent = `
    <div class="help-intro">常用操作放在前面；高级连线技巧仍可通过右键菜单和节点按钮完成。</div>
    <div class="help-section">
        <h4>开始</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">运行工作流</span><span class="help-key">Ctrl + Enter</span></div>
            <div class="help-item"><span class="help-desc">保存会话</span><span class="help-key">Ctrl + S</span></div>
            <div class="help-item"><span class="help-desc">导入 / 导出</span><span class="help-key">Ctrl + O / E</span></div>
            <div class="help-item"><span class="help-desc">撤销</span><span class="help-key">Ctrl + Z</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>画布</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">添加节点</span><span class="help-key">右键空白处</span></div>
            <div class="help-item"><span class="help-desc">框选节点</span><span class="help-key">拖拽空白处</span></div>
            <div class="help-item"><span class="help-desc">平移 / 缩放</span><span class="help-key">空格拖拽 / 滚轮</span></div>
            <div class="help-item"><span class="help-desc">查看全部节点</span><span class="help-key">F</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>节点</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">复制选中节点</span><span class="help-key">Ctrl + C</span></div>
            <div class="help-item"><span class="help-desc">带连线粘贴</span><span class="help-key">Ctrl + Shift + V</span></div>
            <div class="help-item"><span class="help-desc">启用 / 禁用</span><span class="help-key">M</span></div>
            <div class="help-item"><span class="help-desc">删除选中节点</span><span class="help-key">Delete</span></div>
            <div class="help-item"><span class="help-desc">取消运行节点</span><span class="help-key">长按取消</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>连线与素材</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">创建连线</span><span class="help-key">拖拽端口</span></div>
            <div class="help-item"><span class="help-desc">删除连线</span><span class="help-key">双击连线</span></div>
            <div class="help-item"><span class="help-desc">剪断多条连线</span><span class="help-key">Ctrl + 右键划线</span></div>
            <div class="help-item"><span class="help-desc">导入图片</span><span class="help-key">拖入画布</span></div>
            <div class="help-item"><span class="help-desc">复用历史图片</span><span class="help-key">拖拽历史卡片</span></div>
        </div>
    </div>
    <div class="help-tip">
        <strong>小提示</strong>
        <div>只运行选中节点时，会优先读取未选中上游的已有缓存。</div>
        <div>界面异常或资源没更新时，按 <span class="help-key">Ctrl + F5</span> 强制刷新。</div>
    </div>
`;

    function closeHelpPanel() {
        const panel = documentRef.getElementById('help-panel');
        const btnHelp = documentRef.getElementById('btn-help');
        panel?.classList.add('hidden');
        btnHelp?.classList.remove('active');
        if (btnHelp && documentRef.activeElement === btnHelp) {
            btnHelp.blur();
        }
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
