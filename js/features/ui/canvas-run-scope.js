import { getNodeDefinition } from '../../nodes/registry.js';
import { getCommerceRunPreflight } from '../execution/commerce-run-preflight.js';
import { getSurfaceCoordinator } from './surface-coordinator.js';

export function projectCanvasRunScope({ state, plan, isFixedTextChatWithCachedResult }) {
    const candidates = plan.executionOrder.filter(id => state.nodes.get(id)?.enabled !== false);
    const runIds = new Set(candidates.filter(id => id === plan.forceRunNodeId || !isFixedTextChatWithCachedResult(state.nodes.get(id))));
    const reusedIds = new Set(candidates.filter(id => !runIds.has(id)));
    const routes = new Map();
    const routing = [];
    for (const id of runIds) {
        for (const edge of plan.inputConnectionsByNode[id] || []) {
            const source = state.nodes.get(edge.from.nodeId);
            if (!source || source.enabled === false) continue;
            const shouldRun = runIds.has(source.id);
            if (!shouldRun) reusedIds.add(source.id);
            routes.set(edge.id, shouldRun ? 'run' : 'reuse');
            routing.push([edge.id, source.id, edge.from.port, id, edge.to.port]);
        }
    }
    const commerce = getCommerceRunPreflight({ state, plan });
    const scopeKey = JSON.stringify([[...runIds], [...reusedIds], routing, commerce.map(({ nodeId, approvalKey }) => [nodeId, approvalKey])]);
    return { runIds, reusedIds, routes, scopeKey, commerce };
}

function nodeTitle(state, id) {
    const node = state.nodes.get(id);
    return node?.customTitle || getNodeDefinition(node?.type)?.title || node?.type || id;
}

export function createCanvasRunScopeMenu({ state, documentRef, getWorkflowId, getPreview, runWorkflow, openNodeSettings }) {
    const navigation = documentRef.getElementById('canvas-navigation');
    if (!navigation) return null;
    const windowRef = documentRef.defaultView;
    const surfaces = getSurfaceCoordinator(documentRef);
    const trigger = documentRef.createElement('button');
    trigger.type = 'button';
    trigger.className = 'canvas-run-scope-trigger';
    trigger.hidden = true;
    trigger.title = '预览并选择运行范围';
    trigger.setAttribute('aria-label', '预览并选择运行范围');
    trigger.setAttribute('aria-controls', 'canvas-run-scope');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="m7 5 12 7-12 7Z"/></svg><span>运行范围</span>';
    navigation.prepend(trigger);

    const panel = documentRef.createElement('section');
    panel.id = 'canvas-run-scope';
    panel.setAttribute('popover', 'manual');
    panel.setAttribute('aria-labelledby', 'canvas-run-scope-title');
    panel.innerHTML = `
        <h2 id="canvas-run-scope-title">运行范围</h2>
        <div class="canvas-run-scope-scroll">
            <fieldset aria-label="选择运行范围">
                <label><input type="radio" name="canvas-run-scope" value="selected-only"><span data-selected-label>仅此节点</span></label>
                <label><input type="radio" name="canvas-run-scope" value="target-node">运行到此节点</label>
                <label><input type="radio" name="canvas-run-scope" value="all">运行整个工作流</label>
            </fieldset>
            <section class="canvas-run-scope-commerce" aria-labelledby="canvas-run-scope-commerce-title" hidden>
                <h3 id="canvas-run-scope-commerce-title">套图图位</h3>
                <div class="canvas-run-scope-commerce-rows" aria-live="polite"></div>
            </section>
            <div class="canvas-run-scope-summary" role="status" aria-live="polite"></div>
        </div>
        <button type="button" data-confirm-run-scope>运行此范围</button>`;
    documentRef.body.append(panel);
    const selectedLabel = panel.querySelector('[data-selected-label]');
    const selected = panel.querySelector('[value="selected-only"]');
    const target = panel.querySelector('[value="target-node"]');
    const all = panel.querySelector('[value="all"]');
    const summary = panel.querySelector('.canvas-run-scope-summary');
    const commerceSection = panel.querySelector('.canvas-run-scope-commerce');
    const commerceRows = commerceSection.querySelector('.canvas-run-scope-commerce-rows');
    const confirm = panel.querySelector('[data-confirm-run-scope]');
    const marked = new Set();
    let snapshot = null;
    let previewSignature = '';
    let commerceSignature = '';

    function selectedIds() {
        return [...state.selectedNodes].filter(id => state.nodes.has(id));
    }

    function isOpen() {
        return panel.matches(':popover-open');
    }

    function clearRoute() {
        for (const element of marked) delete element.dataset.canvasRunRoute;
        marked.clear();
    }

    function markRoute({ runIds, reusedIds, routes }) {
        clearRoute();
        function mark(element, kind) {
            if (!element) return;
            element.dataset.canvasRunRoute = kind;
            marked.add(element);
        }
        for (const id of runIds) mark(state.nodes.get(id)?.el, 'run');
        for (const id of reusedIds) mark(state.nodes.get(id)?.el, 'reuse');
        if (routes.size) {
            for (const path of documentRef.querySelectorAll('#connections-group .connection-path[data-conn-id]')) {
                const kind = routes.get(path.dataset.connId);
                if (kind) mark(path, kind);
            }
        }
    }

    function position() {
        if (!isOpen()) return;
        const anchor = trigger.getBoundingClientRect();
        const width = Math.min(362, windowRef.innerWidth - 24);
        panel.style.width = `${width}px`;
        panel.style.left = `${Math.max(12, Math.min(anchor.left, windowRef.innerWidth - 12 - width))}px`;
        panel.style.bottom = `${windowRef.innerHeight - anchor.top + 10}px`;
        panel.style.maxHeight = `${Math.max(32, anchor.top - 22)}px`;
    }

    function close({ focus = false } = {}) {
        snapshot = null;
        previewSignature = '';
        clearRoute();
        surfaces.forgetPopover(panel.id);
        if (isOpen()) panel.hidePopover();
        trigger.setAttribute('aria-expanded', 'false');
        if (focus && !trigger.hidden) trigger.focus({ preventScroll: true });
    }

    function runInput() {
        const mode = panel.querySelector('input:checked').value;
        if (mode === 'all') return { mode };
        if (mode === 'target-node') return { mode, targetNodeId: snapshot.ids[0] };
        return { mode, selectedNodeIds: snapshot.ids };
    }

    function appendSummary(label, ids, kind) {
        if (!ids.size) return;
        const line = documentRef.createElement('div');
        const title = documentRef.createElement('strong');
        title.textContent = `${label} · ${ids.size}`;
        title.dataset.routeLegend = kind;
        const names = [...ids].slice(0, 8).map(id => nodeTitle(state, id));
        const rest = ids.size > names.length ? `，另有 ${ids.size - names.length} 个节点` : '';
        line.append(title, documentRef.createTextNode(names.join('、') + rest));
        summary.append(line);
    }

    function renderCommerce(rows, allowFill) {
        const names = rows.map(row => nodeTitle(state, row.nodeId));
        const signature = JSON.stringify([rows, names, allowFill]);
        if (commerceSignature === signature) return;
        commerceSignature = signature;
        const focusedNodeId = documentRef.activeElement?.dataset.commerceRunSettings;
        let nextFocus;
        commerceSection.hidden = rows.length === 0;
        commerceRows.replaceChildren();
        for (const [index, row] of rows.entries()) {
            const {
                nodeId, issue, shotCount, generateCount, candidateCount, referenceCount, finalizedCount, excludedCount, upstreamWillRun,
                hasCompleted, unfinishedCount
            } = row;
            const name = names[index];
            const article = documentRef.createElement('div');
            article.className = 'canvas-run-scope-commerce-row';
            article.dataset.commerceRunNode = nodeId;
            const title = documentRef.createElement('strong');
            title.textContent = name;
            article.append(title);
            const recovery = issue ? documentRef.createElement('div') : article;
            if (issue) {
                recovery.className = 'canvas-run-scope-commerce-recovery';
                const note = documentRef.createElement('p');
                note.className = 'canvas-run-scope-commerce-note';
                note.textContent = issue.message;
                recovery.append(note);
                article.append(recovery);
            }
            const counts = documentRef.createElement('p');
            counts.className = 'canvas-run-scope-commerce-counts';
            const generation = `模型生成 ${generateCount} 张${candidateCount > 1 ? '候选' : ''}`;
            counts.textContent = `${shotCount} 个图位 · ${generation} · 复用原图 ${referenceCount} 张`;
            if (finalizedCount) counts.textContent += ` · 保留定稿 ${finalizedCount} 张`;
            if (excludedCount) counts.textContent += ` · 暂不执行 ${excludedCount} 个图位`;
            article.append(counts);
            const notes = [
                upstreamWillRun ? '本次也会运行上游节点，商品参考图可能变化。参考图变化后需重新规划并确认套图。' : '',
                !issue && hasCompleted && shotCount > finalizedCount
                    ? '本次会重新处理已完成且未定稿的图位。' : ''
            ].filter(Boolean);
            for (const text of notes) {
                const note = documentRef.createElement('p');
                note.className = 'canvas-run-scope-commerce-note';
                note.textContent = text;
                article.append(note);
            }
            const fill = allowFill && !issue && hasCompleted && unfinishedCount > 0;
            const action = issue?.action || (fill ? 'fill' : '');
            if (action && openNodeSettings) {
                const settings = documentRef.createElement('button');
                settings.type = 'button';
                settings.dataset.commerceRunSettings = nodeId;
                const label = fill ? `去参数面板补齐 ${unfinishedCount} 个图位` : '打开参数面板';
                settings.textContent = label;
                settings.setAttribute('aria-label', `${label} · ${name}`);
                settings.addEventListener('click', () => {
                    close({ focus: true });
                    openNodeSettings(nodeId, action);
                });
                if (focusedNodeId === nodeId) nextFocus = settings;
                recovery.append(settings);
            }
            commerceRows.append(article);
        }
        if (focusedNodeId) (nextFocus || panel.querySelector('input:checked')).focus({ preventScroll: true });
    }

    function renderPreview(preview = getPreview(runInput()), changed = false) {
        const { runIds, reusedIds, message, commerce = [] } = preview;
        previewSignature = JSON.stringify([preview.scopeKey, message]);
        markRoute(preview);
        summary.replaceChildren();
        appendSummary('将执行', runIds, 'run');
        appendSummary('尝试读取已有输出', reusedIds, 'reuse');
        if ((message && !commerce.some(row => row.issue?.message === message)) || changed) {
            const messageElement = documentRef.createElement('p');
            messageElement.textContent = message || '画布已变化，请核对更新后的运行范围。';
            summary.append(messageElement);
        }
        const allowFill = !message && snapshot.ids.length === 1 && commerce.length === 1
            && panel.querySelector('input:checked').value === 'selected-only';
        renderCommerce(commerce, allowFill);
        const redo = allowFill && !commerce[0].issue && commerce[0].hasCompleted && commerce[0].shotCount > commerce[0].finalizedCount;
        confirm.textContent = redo ? '重做已确认图位' : '运行此范围';
        confirm.disabled = Boolean(message) || !runIds.size;
    }

    function refresh() {
        const ids = selectedIds();
        const workflowId = getWorkflowId();
        const loadState = documentRef.documentElement.dataset.canvasLoadState || 'ready';
        trigger.hidden = !state.nodes.size || !workflowId || loadState !== 'ready';
        if (!isOpen()) return;
        if (trigger.hidden || snapshot?.workflowId !== workflowId
            || ids.length !== snapshot.ids.length || ids.some(id => !snapshot.ids.includes(id))) {
            close();
            return;
        }
        renderPreview();
        position();
    }

    trigger.addEventListener('mousedown', event => event.stopPropagation());
    trigger.addEventListener('click', () => {
        if (isOpen()) { close({ focus: true }); return; }
        const ids = selectedIds();
        const workflowId = getWorkflowId();
        if (trigger.hidden || !workflowId || surfaces.topModal()) return;
        snapshot = { ids, workflowId };
        selectedLabel.textContent = ids.length === 1 ? '仅此节点' : `仅选中的 ${ids.length} 个节点`;
        selected.disabled = selected.closest('label').hidden = ids.length === 0;
        target.disabled = target.closest('label').hidden = ids.length !== 1;
        const first = ids.length ? selected : all;
        first.checked = true;
        panel.showPopover();
        surfaces.openPopover(panel.id, { element: panel, trigger, close });
        trigger.setAttribute('aria-expanded', 'true');
        renderPreview();
        position();
        first.focus({ preventScroll: true });
    });

    panel.addEventListener('change', () => renderPreview());
    confirm.addEventListener('click', () => {
        if (!isOpen() || confirm.disabled) return;
        const ids = selectedIds();
        if (snapshot?.workflowId !== getWorkflowId() || ids.length !== snapshot.ids.length
            || ids.some(id => !snapshot.ids.includes(id))) { close(); return; }
        const input = runInput();
        const workflowId = snapshot.workflowId;
        const signature = previewSignature;
        const preview = getPreview(input);
        renderPreview(preview);
        if (previewSignature !== signature) {
            if (!confirm.disabled) renderPreview(preview, true);
            return;
        }
        close({ focus: true });
        const staleMessage = '画布已变化，请重新核对运行范围。';
        void runWorkflow(input, {
            validateBeforeRun: () => {
                const current = getPreview(input);
                if (workflowId !== getWorkflowId() || current.message || current.scopeKey !== preview.scopeKey) {
                    throw new Error(staleMessage);
                }
            },
            validateExecutionPlan: dispatch => {
                if (projectCanvasRunScope(dispatch).scopeKey !== preview.scopeKey) throw new Error(staleMessage);
            }
        }).catch(() => {});
    });
    windowRef.addEventListener('resize', position);
    new windowRef.MutationObserver(refresh).observe(documentRef.documentElement, {
        attributes: true, attributeFilter: ['data-canvas-load-state']
    });
    refresh();
    return { refresh };
}
