/**
 * Manages the floating help panel and keeps the in-app operation guide current.
 */
export function createHelpPanelApi({
    canvasContainer,
    nodesLayer,
    panelManager = null,
    closeHistorySidebar,
    documentRef = document
}) {
    const helpContent = `
    <div class="help-intro">从左侧工具栏打开常用面板；画布快捷键只在鼠标位于画布或画布获得焦点时生效。</div>
    <div class="help-section">
        <h4>左侧工具栏</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">工作流列表</span><span class="help-key">工作流</span></div>
            <div class="help-item"><span class="help-desc">缓存占用与清理</span><span class="help-key">缓存</span></div>
            <div class="help-item"><span class="help-desc">今日请求统计</span><span class="help-key">统计</span></div>
            <div class="help-item"><span class="help-desc">提示词管理</span><span class="help-key">提示词</span></div>
            <div class="help-item"><span class="help-desc">整理当前画布</span><span class="help-key">自动整理</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>运行与文件</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">运行工作流</span><span class="help-key">Ctrl + Enter</span></div>
            <div class="help-item"><span class="help-desc">停止全部运行</span><span class="help-key">顶部停止</span></div>
            <div class="help-item"><span class="help-desc">保存当前工作流</span><span class="help-key">Ctrl + S</span></div>
            <div class="help-item"><span class="help-desc">导入 / 导出工作流</span><span class="help-key">Ctrl + O / E</span></div>
            <div class="help-item"><span class="help-desc">撤回上一步</span><span class="help-key">Ctrl + Z</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>画布视图</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">添加节点</span><span class="help-key">右键空白处</span></div>
            <div class="help-item"><span class="help-desc">框选节点</span><span class="help-key">拖拽空白处</span></div>
            <div class="help-item"><span class="help-desc">全选节点</span><span class="help-key">Ctrl + A</span></div>
            <div class="help-item"><span class="help-desc">平移画布</span><span class="help-key">空格拖拽</span></div>
            <div class="help-item"><span class="help-desc">缩放画布</span><span class="help-key">滚轮 / 顶部按钮</span></div>
            <div class="help-item"><span class="help-desc">聚焦选中或全部</span><span class="help-key">F</span></div>
            <div class="help-item"><span class="help-desc">取消选择 / 关闭菜单</span><span class="help-key">Esc</span></div>
        </div>
    </div>
    <div class="help-section">
        <h4>节点</h4>
        <div class="help-grid">
            <div class="help-item"><span class="help-desc">复制选中节点</span><span class="help-key">Ctrl + C</span></div>
            <div class="help-item"><span class="help-desc">带连线粘贴</span><span class="help-key">Ctrl + Shift + V</span></div>
            <div class="help-item"><span class="help-desc">拖拽克隆</span><span class="help-key">Ctrl + 拖拽</span></div>
            <div class="help-item"><span class="help-desc">启用 / 禁用</span><span class="help-key">M / 节点按钮</span></div>
            <div class="help-item"><span class="help-desc">折叠 / 展开</span><span class="help-key">双击标题</span></div>
            <div class="help-item"><span class="help-desc">删除选中节点</span><span class="help-key">Delete</span></div>
            <div class="help-item"><span class="help-desc">只取消单个节点</span><span class="help-key">长按取消 2 秒</span></div>
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
        <div>只运行选中节点时，会优先读取未选中上游的已有缓存；运行中的节点不能直接移动，按住 <span class="help-key">Ctrl</span> 可克隆。</div>
        <div>界面异常或资源没更新时，按 <span class="help-key">Ctrl + F5</span> 强制刷新。</div>
    </div>
`;

    function setPanelOpenState(panel, open) {
        if (!panel) return;
        panel.classList.toggle('active', open);
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) {
            panel.removeAttribute('inert');
            panel.inert = false;
        } else {
            panel.setAttribute('inert', '');
            panel.inert = true;
        }
    }

    function closeHelpPanel() {
        const panel = documentRef.getElementById('help-panel');
        const btnHelp = documentRef.getElementById('btn-help');
        setPanelOpenState(panel, false);
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

        if (!panel.classList.contains('active')) {
            panelManager?.closeAll?.();
            closeHistorySidebar?.();
            content.innerHTML = helpContent;
            setPanelOpenState(panel, true);
            btnHelp?.classList.add('active');
        } else {
            closeHelpPanel();
        }
    }

    function initHelpPanel() {
        documentRef.getElementById('side-bar')?.addEventListener('click', (e) => {
            const button = e.target?.closest?.('.side-bar-btn');
            if (button && button.id !== 'btn-help') {
                closeHelpPanel();
            }
        });

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
