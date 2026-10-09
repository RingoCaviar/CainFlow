import { listNodeDefinitions } from '../../nodes/registry.js';

/** Search the registered node catalog while retaining the existing creation path. */
export function createNodePicker({ canvasContainer, viewportApi, addNode, showToast, documentRef = document }) {
    let panel = null;
    let origin = null;
    let previousFocus = null;
    let results = [];
    let activeIndex = 0;
    const recentTypes = [];
    const definitions = listNodeDefinitions();

    function record(type) {
        if (!definitions.some((node) => node.type === type)) return;
        const index = recentTypes.indexOf(type);
        if (index >= 0) recentTypes.splice(index, 1);
        recentTypes.unshift(type);
        recentTypes.length = Math.min(recentTypes.length, 6);
    }

    function close() {
        panel?.classList.add('hidden');
        previousFocus?.focus?.();
    }

    function select(type) {
        try {
            const position = viewportApi.screenToCanvas(origin.x, origin.y);
            const id = addNode(type, position.x, position.y);
            if (!id) { showToast?.('创建节点失败', 'error'); return; }
            record(type);
            close();
            canvasContainer.focus?.();
        } catch (error) { showToast?.(`创建节点失败：${error.message}`, 'error'); }
    }

    function render() {
        const query = panel.querySelector('input').value.trim().toLocaleLowerCase();
        results = definitions.filter((node) => `${node.title} ${node.type}`.toLocaleLowerCase().includes(query));
        const list = panel.querySelector('.node-picker-results');
        list.replaceChildren();
        const append = (nodes, heading) => {
            if (!nodes.length) return;
            const label = documentRef.createElement('div');
            label.className = 'node-picker-heading';
            label.textContent = heading;
            list.append(label);
            for (const node of nodes) {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.className = 'node-picker-result';
                button.dataset.type = node.type;
                button.textContent = node.title;
                button.addEventListener('click', () => select(node.type));
                list.append(button);
            }
        };
        if (!query) append(recentTypes.map((type) => definitions.find((node) => node.type === type)), '最近使用 · 本次会话');
        append(results, query ? `找到 ${results.length} 个节点` : '全部节点');
        if (!results.length) {
            const empty = documentRef.createElement('p');
            empty.textContent = '没有匹配的节点，试试“图片”或“文本”';
            list.append(empty);
        }
        activeIndex = 0;
        highlight();
    }

    function highlight() {
        const buttons = [...panel.querySelectorAll('.node-picker-result')];
        buttons.forEach((button, index) => button.classList.toggle('is-active', index === activeIndex));
        buttons[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    function open(point = null) {
        const rect = canvasContainer.getBoundingClientRect();
        origin = point || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        previousFocus = documentRef.activeElement;
        if (!panel) {
            panel = documentRef.createElement('div');
            panel.className = 'modal-overlay node-picker-overlay hidden';
            panel.innerHTML = '<section class="node-picker-panel" role="dialog" aria-modal="true" aria-labelledby="node-picker-title"><header><h2 id="node-picker-title">添加节点</h2><button type="button" class="node-picker-close" aria-label="关闭">×</button></header><input type="search" aria-label="搜索节点名称或类型" placeholder="搜索节点名称，如 图片生成、文本…"><div class="node-picker-results"></div><footer>↑ ↓ 选择 · Enter 添加 · Esc 关闭</footer></section>';
            documentRef.body.append(panel);
            panel.querySelector('.node-picker-close').addEventListener('click', close);
            panel.addEventListener('click', (event) => { if (event.target === panel) close(); });
            panel.querySelector('input').addEventListener('input', render);
            panel.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.isComposing || event.keyCode === 229) return;
                if (event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
                const buttons = [...panel.querySelectorAll('.node-picker-result')];
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const focusedIndex = buttons.indexOf(documentRef.activeElement);
                    if (focusedIndex >= 0) activeIndex = focusedIndex;
                    activeIndex = Math.max(0, Math.min(buttons.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
                    highlight();
                    if (focusedIndex >= 0) buttons[activeIndex]?.focus();
                } else if (event.key === 'Enter' && event.target.matches('input, .node-picker-result')) {
                    const focusedIndex = buttons.indexOf(documentRef.activeElement);
                    if (focusedIndex >= 0) activeIndex = focusedIndex;
                    event.preventDefault(); buttons[activeIndex]?.click();
                } else if (event.key === 'Tab') {
                    const controls = [...panel.querySelectorAll('button,input')];
                    const first = controls[0], last = controls.at(-1);
                    if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
                    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
                }
            });
        }
        panel.classList.remove('hidden');
        panel.querySelector('input').value = '';
        render();
        panel.querySelector('input').focus();
    }

    return { open, close, record };
}
