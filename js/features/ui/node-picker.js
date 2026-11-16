import { listNodeDefinitions } from '../../nodes/registry.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';

const pickerSurface = 'canvas-node-picker';

/** The catalog and drag-to-create share presentation while keeping their own creation paths. */
export function createNodePicker({
    canvasContainer, viewportApi, addNode, showToast, panel = null, documentRef = document
}) {
    const windowRef = documentRef.defaultView;
    const surfaces = getSurfaceCoordinator(documentRef);
    const definitions = listNodeDefinitions();
    const recentTypes = [];
    let source = null;
    let search, list, heading;
    let buttons = [];
    let activeIndex = 0;

    function record(type) {
        if (!definitions.some(node => node.type === type)) return;
        const index = recentTypes.indexOf(type);
        if (index >= 0) recentTypes.splice(index, 1);
        recentTypes.unshift(type);
        recentTypes.length = Math.min(recentTypes.length, 6);
    }

    function close({ restoreFocus = false } = {}) {
        if (!source) return;
        const { trigger } = source;
        source = null;
        panel.classList.add('hidden');
        if (trigger?.getAttribute('aria-controls') === panel.id) trigger.setAttribute('aria-expanded', 'false');
        search.setAttribute('aria-expanded', 'false');
        search.removeAttribute('aria-activedescendant');
        list.replaceChildren();
        buttons = [];
        surfaces?.forgetPopover(pickerSurface);
        if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    }

    function select(node) {
        if (!source) return;
        const { compatible, create, position } = source;
        try {
            const added = compatible
                ? create(node, position)
                : addNode(node.type, position.x, position.y);
            if (!added) {
                if (compatible) close({ restoreFocus: true });
                else showToast?.('创建节点失败', 'error');
                return;
            }
            record(node.type);
            const pickerHadFocus = panel.contains(documentRef.activeElement);
            close();
            if (pickerHadFocus) canvasContainer.focus?.({ preventScroll: true });
        } catch (error) { showToast?.(`创建节点失败：${error.message}`, 'error'); }
    }

    function highlight() {
        buttons.forEach((button, index) => {
            const active = index === activeIndex;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });
        const active = buttons[activeIndex];
        if (!active) { search.removeAttribute('aria-activedescendant'); return; }
        search.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
    }

    function render() {
        const query = search.value.trim().toLocaleLowerCase();
        const { candidates, compatible } = source;
        const results = candidates.filter(node => `${node.title} ${node.type} ${node.matchLabel || ''}`.toLocaleLowerCase().includes(query));
        list.replaceChildren();
        buttons = [];
        function append(nodes, title = '') {
            if (!nodes.length) return;
            const group = documentRef.createElement('div');
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', title || heading.textContent);
            if (title) {
                const label = documentRef.createElement('div');
                label.className = 'node-picker-heading';
                label.setAttribute('aria-hidden', 'true');
                label.textContent = title;
                group.append(label);
            }
            for (const node of nodes) {
                const button = documentRef.createElement('button');
                button.type = 'button';
                button.className = 'node-picker-result';
                button.id = `node-picker-option-${buttons.length}`;
                button.dataset.type = node.type;
                button.setAttribute('role', 'option');
                button.textContent = node.title;
                if (compatible) {
                    button.dataset.popupNodeType = node.type;
                    if (node.matchLabel) {
                        const hint = documentRef.createElement('small');
                        hint.className = 'node-picker-match';
                        hint.textContent = `${node.matchDirection === 'input' ? '输入' : '输出'} · ${node.matchLabel}`;
                        button.append(hint);
                    }
                }
                button.addEventListener('click', () => select(node));
                group.append(button);
                buttons.push(button);
            }
            list.append(group);
        }
        const recent = !compatible && !query
            ? recentTypes.map(type => definitions.find(node => node.type === type))
            : [];
        append(recent, '最近使用');
        append(results.filter(node => !recent.includes(node)), recent.length ? '其他节点' : '');
        if (!results.length) {
            const empty = documentRef.createElement('p');
            empty.setAttribute('role', 'status');
            empty.textContent = compatible ? '没有匹配的兼容节点' : '没有匹配的节点';
            list.append(empty);
        }
        activeIndex = 0;
        list.scrollTop = 0;
        highlight();
    }

    function handleKeys(event) {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            close({ restoreFocus: true });
            return;
        }
        const focusedIndex = buttons.indexOf(documentRef.activeElement);
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (focusedIndex >= 0 || event.target === search)) {
            event.preventDefault();
            if (!buttons.length) return;
            if (focusedIndex >= 0) activeIndex = focusedIndex;
            activeIndex = Math.max(0, Math.min(buttons.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
            highlight();
            if (focusedIndex >= 0) buttons[activeIndex]?.focus({ preventScroll: true });
        } else if (event.key === 'Enter' && (event.target === search || focusedIndex >= 0)) {
            event.preventDefault();
            buttons[focusedIndex >= 0 ? focusedIndex : activeIndex]?.click();
        }
    }

    function mount() {
        if (!panel) {
            panel = documentRef.createElement('section');
            documentRef.body.append(panel);
        }
        panel.id ||= 'connection-create-popup';
        panel.classList.add('node-picker-panel', 'hidden');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-labelledby', 'node-picker-title');
        panel.innerHTML = `<header><h2 id="node-picker-title"></h2>
            <button type="button" class="node-picker-close" aria-label="关闭节点选择器">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
            </button></header>
            <input type="search" role="combobox" aria-label="搜索节点名称或类型" aria-autocomplete="list"
                aria-controls="node-picker-results" aria-expanded="false" placeholder="搜索节点名称或类型…" autocomplete="off">
            <div class="node-picker-results" id="node-picker-results" role="listbox" aria-label="可用节点"></div>
            <footer><span>↑ ↓ 选择</span><span>Enter 添加</span><span>Esc 关闭</span></footer>`;
        search = panel.querySelector('input');
        list = panel.querySelector('.node-picker-results');
        heading = panel.querySelector('h2');
        panel.querySelector('.node-picker-close').addEventListener('click', () => close({ restoreFocus: true }));
        search.addEventListener('input', () => { if (source) render(); });
        panel.addEventListener('keydown', handleKeys);
        panel.addEventListener('focusout', event => {
            if (event.relatedTarget && event.relatedTarget !== source?.trigger && !panel.contains(event.relatedTarget)) close();
        });
        windowRef.addEventListener('resize', () => { if (source) positionPanel(); });
    }

    function positionPanel() {
        const padding = 8;
        const gap = 6;
        const { point, anchor } = source;
        const rect = anchor?.getBoundingClientRect();
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const maxLeft = Math.max(padding, windowRef.innerWidth - width - padding);
        const maxTop = Math.max(padding, windowRef.innerHeight - height - padding);
        const left = rect?.left ?? (point.x + gap);
        const top = rect
            ? (rect.bottom + gap <= maxTop ? rect.bottom + gap : rect.top - height - gap)
            : point.y + gap;
        panel.style.left = `${Math.max(padding, Math.min(left, maxLeft))}px`;
        panel.style.top = `${Math.max(padding, Math.min(top, maxTop))}px`;
    }

    function open(point = null, {
        trigger = documentRef.activeElement, anchor = null, candidates = definitions, create = null, canvasPoint = null
    } = {}) {
        close();
        if (!search) mount();
        const rect = canvasContainer.getBoundingClientRect();
        point ||= { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const position = canvasPoint || viewportApi.screenToCanvas(point.x, point.y);
        source = { point, anchor, trigger, position, candidates, create, compatible: Boolean(create) };
        heading.textContent = source.compatible ? '创建并连接节点' : '添加节点';
        search.value = '';
        search.setAttribute('aria-expanded', 'true');
        panel.classList.remove('hidden');
        if (trigger?.getAttribute('aria-controls') === panel.id) trigger.setAttribute('aria-expanded', 'true');
        render();
        positionPanel();
        surfaces?.openPopover(pickerSurface, { element: panel, trigger,
            close: () => close({ restoreFocus: panel.contains(documentRef.activeElement) }) });
        if (source) search.focus({ preventScroll: true });
    }

    return { open, close, record };
}
