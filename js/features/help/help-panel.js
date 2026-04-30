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
    <div class="help-section">
        <h4>核心快捷键</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">运行完整工作流</span><span class="help-key">Ctrl + Enter</span></div>
            <div class="help-item"><span class="help-desc">保存当前会话</span><span class="help-key">Ctrl + S</span></div>
            <div class="help-item"><span class="help-desc">导入工作流文件</span><span class="help-key">Ctrl + O</span></div>
            <div class="help-item"><span class="help-desc">导出工作流文件</span><span class="help-key">Ctrl + E</span></div>
            <div class="help-item"><span class="help-desc">撤销上一步</span><span class="help-key">Ctrl + Z</span></div>
            <div class="help-item"><span class="help-desc">复制选中节点</span><span class="help-key">Ctrl + C</span></div>
            <div class="help-item"><span class="help-desc">全选画布节点</span><span class="help-key">Ctrl + A</span></div>
            <div class="help-item"><span class="help-desc">删除选中节点</span><span class="help-key">Delete</span></div>
            <div class="help-item"><span class="help-desc">自适应查看全部节点</span><span class="help-key">F</span></div>
            <div class="help-item"><span class="help-desc">关闭菜单、面板或清空选择</span><span class="help-key">Esc</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>画布导航</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">打开添加节点菜单</span><span class="help-key">右键画布</span></div>
            <div class="help-item"><span class="help-desc">框选多个节点</span><span class="help-key">左键拖拽空白处</span></div>
            <div class="help-item"><span class="help-desc">平移画布</span><span class="help-key">中键 / 空格 + 左键</span></div>
            <div class="help-item"><span class="help-desc">临时平移画布</span><span class="help-key">Alt + 左键</span></div>
            <div class="help-item"><span class="help-desc">缩放视图</span><span class="help-key">滚轮</span></div>
            <div class="help-item"><span class="help-desc">只运行当前选择</span><span class="help-key">框选后右键</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>节点编辑</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">移动节点或选区</span><span class="help-key">拖拽节点</span></div>
            <div class="help-item"><span class="help-desc">克隆节点或选区</span><span class="help-key">Ctrl + 拖拽</span></div>
            <div class="help-item"><span class="help-desc">调整节点尺寸</span><span class="help-key">右下角手柄</span></div>
            <div class="help-item"><span class="help-desc">启用或禁用节点</span><span class="help-key">节点电源按钮</span></div>
            <div class="help-item"><span class="help-desc">删除并尝试保留上下游</span><span class="help-key">Alt + 删除按钮</span></div>
            <div class="help-item"><span class="help-desc">从连线中摘取节点</span><span class="help-key">拖拽时晃动 1 秒</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>连线操作</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">创建连接</span><span class="help-key">拖拽端口圆点</span></div>
            <div class="help-item"><span class="help-desc">拖到空白处快速建点</span><span class="help-key">松手后点选兼容节点</span></div>
            <div class="help-item"><span class="help-desc">删除单条连接</span><span class="help-key">双击连线</span></div>
            <div class="help-item"><span class="help-desc">快速剪断多条连接</span><span class="help-key">Ctrl + 右键划线</span></div>
            <div class="help-item"><span class="help-desc">把孤立节点插入连线</span><span class="help-key">拖到兼容连线上松开</span></div>
            <div class="help-item"><span class="help-desc">插入或保留连接时</span><span class="help-key">仅匹配同类型端口</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>图片与面板</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">导入图片到画布</span><span class="help-key">拖拽图片文件</span></div>
            <div class="help-item"><span class="help-desc">写入现有导入节点</span><span class="help-key">拖到 ImageImport</span></div>
            <div class="help-item"><span class="help-desc">从历史记录复用图片</span><span class="help-key">拖拽历史卡片</span></div>
            <div class="help-item"><span class="help-desc">管理提示词预设</span><span class="help-key">左侧提示词库</span></div>
            <div class="help-item"><span class="help-desc">查看请求和错误细节</span><span class="help-key">左侧日志</span></div>
            <div class="help-item"><span class="help-desc">配置供应商、模型和连线</span><span class="help-key">设置面板</span></div>
        </div>
    </div>
    <div class="help-tip">
        <div>只运行选中节点时，未选中的上下游不会自动执行，但会尽量读取已有缓存结果。</div>
        <div style="margin-top: 4px;">节点插入、节点摘取、Alt 删除保留连接都会遵守端口数据类型；类型不匹配时不会强行连接。</div>
        <div style="margin-top: 4px; color: var(--accent-orange); opacity: 0.9;">更新后如界面异常，建议使用 <span class="help-key" style="color: var(--accent-orange); border-color: rgba(245, 158, 11, 0.3);">Ctrl + F5</span> 强制刷新。</div>
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
