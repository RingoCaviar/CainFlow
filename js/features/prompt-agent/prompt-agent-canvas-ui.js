import { createThinkingControl } from '../execution/thinking-control.js';
import { getResolvedProviderForModel } from '../execution/provider-request-utils.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { createPromptAgentModelMenus, getAgentModelLabel } from './prompt-agent-model-menu.js';

export function renderCanvasPlan({ documentRef, parent, plan, adapter, getModels, getProviders = () => [], getThinking = () => undefined, getModelId, changed, run, isCurrent, preview = () => {} }) {
    const card = documentRef.createElement('section'); card.className = 'prompt-agent-canvas-plan';
    parent.appendChild(card);
    let busy = false;
    const element = (tag, text, owner = card) => { const node = documentRef.createElement(tag); node.textContent = text;
        if (tag === 'button') node.className = 'btn btn-secondary'; owner.appendChild(node); return node; };
    const title = element('strong', '画布操作方案');
    title.title = plan.id;
    const inputs = element('div', ''); inputs.className = 'prompt-agent-plan-inputs';
    const references = adapter.inputs?.(plan) || [];
    element('span', references.length ? `参考图 · ${references.length} 项`
        : plan.steps.some(step => step.type === 'ImageGenerate') ? '纯文字生成' : '素材处理方案', inputs);
    let destroyed = false;
    for (const reference of references) {
        const item = element('button', `${reference.name} → ${reference.purpose}${reference.upstream ? '（本次步骤输出）' : ''}`, inputs);
        item.type = 'button'; item.disabled = true; item.className = 'prompt-agent-plan-reference';
        if (reference.assetKey) Promise.resolve(adapter.readImage?.(reference.assetKey)).then(data => {
            if (destroyed || !isCurrent() || !data) return;
            const image = documentRef.createElement('img'); image.src = data; image.alt = reference.name; item.prepend(image);
            item.disabled = false; item.addEventListener('click', () => preview([data], 0));
        }).catch(() => { if (!destroyed) item.title = '参考原图读取失败，应用时将重新校验'; });
    }
    const list = element('ol', '');
    const stepStates = new Map();
    const refreshSelectors = [];
    const thinkingControls = [];
    const focusButtons = new Map();
    for (const id of plan.order) {
        const step = plan.steps.find(item => item.id === id);
        const row = element('li', step.title, list);
        stepStates.set(id, element('span', '', row));
        const focus = element('button', '定位', row); focus.type = 'button'; focus.addEventListener('click', () => adapter.focus(step.nodeId || plan.bindings?.[id]));
        focusButtons.set(id, focus);
        if (step.type === 'ImageGenerate') {
            const settings = element('details', '', row); settings.className = 'prompt-agent-step-settings';
            const modelLabel = element('summary', '模型与参数', settings);
            const select = element('select', '', settings); select.setAttribute('aria-label', `${step.title}的生图模型`);
            const parameters = element('pre', Object.entries({ ...step.parameters, ...step.generationPatch,
                ...(step.negativePrompt ? { negativePrompt: step.negativePrompt } : {}) }).map(([key, value]) => `${key}：${value}`).join('\n'), settings);
            parameters.className = 'prompt-agent-step-prompt';
            select.id = `agent-step-model-${plan.id}-${id}`;
            const inherit = element('option', '使用面板手动选择的模型', select); inherit.value = '';
            for (const model of getModels()) { const option = element('option', getAgentModelLabel(model, getProviders()), select); option.value = model.id; }
            const selected = plan.modelOverrides?.[id] || '';
            if (selected && !getModels().some(model => model.id === selected)) { const unavailable = element('option', '原模型已不可用，请重新选择', select); unavailable.value = selected; unavailable.disabled = true; }
            select.value = selected;
            let modelSignature = '';
            const refreshModels = () => {
                const models = getModels(), value = plan.modelOverrides?.[id] || '';
                const signature = JSON.stringify([models.map(model => [model.id, getAgentModelLabel(model, getProviders())]), value, getModelId()]);
                if (signature === modelSignature) return;
                modelSignature = signature; select.replaceChildren();
                const inherited = models.find(model => model.id === getModelId());
                const option = element('option', inherited ? `面板模型：${getAgentModelLabel(inherited, getProviders())}` : '请先选择面板模型', select); option.value = '';
                for (const model of models) { const option = element('option', getAgentModelLabel(model, getProviders()), select); option.value = model.id; }
                if (value && !models.some(model => model.id === value)) { const option = element('option', '原模型已不可用，请重新选择', select); option.value = value; option.disabled = true; }
                select.value = value;
                const chosen = models.find(model => model.id === (value || getModelId()));
                modelLabel.textContent = `模型：${chosen ? getAgentModelLabel(chosen, getProviders()) : '未选择'} · 参数`;
            };
            thinkingControls.push(createThinkingControl({ documentRef, parent: settings, title: `${step.title}的思考设置`,
                getOptions: () => { const model = getModels().find(item => item.id === (plan.modelOverrides?.[id] || getModelId())) || {};
                    return { model: { ...model, thinking: { ...model.thinking, default: getThinking(model.id) || model.thinking?.default } }, provider: getResolvedProviderForModel(model, getProviders()) || {}, protocol: model.protocol, task: 'image' }; },
                getValue: () => plan.thinkingOverrides?.[id]?.[plan.modelOverrides?.[id] || getModelId()],
                onChange: value => { ((plan.thinkingOverrides ||= {})[id] ||= {})[plan.modelOverrides?.[id] || getModelId()] = value; changed(plan); sync(); } }));
            refreshSelectors.push(refreshModels); select.addEventListener('focus', refreshModels);
            select.addEventListener('change', () => { (plan.modelOverrides ||= {})[id] = select.value; changed(plan); sync(); });
        }
    }
    const modelMenus = createPromptAgentModelMenus({ documentRef, selects: [...list.querySelectorAll('select')] });
    const details = element('details', ''); details.open = false;
    element('summary', '变更清单', details);
    const changes = element('ul', '', details);
    changes.className = 'prompt-agent-change-list';
    adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
    const status = element('p', ''); status.setAttribute('role', 'status');
    const actions = element('div', ''); actions.className = 'prompt-agent-canvas-actions';
    const refresh = element('button', '刷新变更清单', details); refresh.type = 'button';
    const apply = element('button', '仅应用', actions), execute = element('button', '应用并执行', actions);
    execute.className = 'btn btn-primary';
    const retry = element('button', '重试未完成步骤', actions), undo = element('button', '撤销本次画布操作', actions), stop = element('button', '停止', actions);
    const buttons = [apply, execute, retry, undo, stop]; buttons.forEach(button => { button.type = 'button'; });
    function sync() {
        if (!busy) plan.agentThinking = Object.fromEntries(getModels().map(model => [model.id, getThinking(model.id)]).filter(([, value]) => value));
        thinkingControls.forEach(control => control.refresh());
        focusButtons.forEach((button, id) => { button.disabled = !plan.bindings?.[id] && !plan.steps.find(step => step.id === id)?.nodeId; button.hidden = button.disabled; });
        refreshSelectors.forEach(refresh => refresh());
        changes.replaceChildren(); adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
        for (const [id, label] of stepStates) label.textContent = ` · ${{ draft: '待确认', applied: '待执行', pending: '等待执行', running: '执行中', completed: '已完成', failed: '失败', interrupted: '未完成' }[adapter.stepStatus(plan, id)] || '未执行'}`;
        let unavailable = '';
        try { adapter.modelsFor(plan, getModelId()); } catch (error) { unavailable = error.message; }
        apply.disabled = execute.disabled = busy || !isCurrent() || Boolean(unavailable);
        retry.disabled = execute.disabled || !plan.runs?.length;
        retry.hidden = !plan.runs?.length;
        undo.hidden = !Object.keys(plan.bindings || {}).length;
        undo.disabled = busy || Boolean(adapter.canUndo(plan)); undo.title = adapter.canUndo(plan);
        stop.hidden = !busy;
        refresh.disabled = busy || !isCurrent();
        for (const select of list.querySelectorAll('select, .thinking-control input, .thinking-control button')) select.disabled = busy;
        if (unavailable) status.textContent = unavailable;
    }
    async function act(generate, retryOnly = false) {
        if (busy || !isCurrent()) return;
        busy = true; sync(); status.textContent = '正在校验与应用…';
        const timer = setInterval(() => { if (isCurrent()) sync(); }, 250);
        try {
            await adapter.apply(plan, getModelId(), () => changed(plan), isCurrent); changed(plan);
            if (!isCurrent()) return;
            status.textContent = '画布方案已应用并保存';
            if (generate) { status.textContent = '按依赖顺序执行中…'; await run(plan, retryOnly); status.textContent = '执行结束，结果见下方'; }
        } catch (error) { if (isCurrent()) status.textContent = error.message; }
        finally { clearInterval(timer); busy = false; if (isCurrent()) { changed(plan); sync(); } }
    }
    apply.addEventListener('click', () => act(false)); execute.addEventListener('click', () => act(true)); retry.addEventListener('click', () => act(true, true));
    stop.addEventListener('click', () => adapter.stop(plan));
    refresh.addEventListener('click', () => { try {
        adapter.refresh(plan); changes.replaceChildren(); adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
        changed(plan); status.textContent = '已按当前画布更新清单，请重新检查后应用';
    } catch (error) { status.textContent = error.message; } sync(); });
    undo.addEventListener('click', async () => { try { await adapter.undo(plan); status.textContent = '已按撤销栈处理；历史图片仍保留'; } catch (error) { status.textContent = error.message; } sync(); });
    sync();
    return { sync, close: () => { modelMenus.close(); thinkingControls.forEach(control => control.close()); }, destroy: () => { destroyed = true; thinkingControls.forEach(control => control.destroy()); modelMenus.destroy(); } };
}

export function attachCanvasMentions({ documentRef, input, adapter }) {
    const mentions = new Map(); let menu = null; let index = 0;
    const surfaces = getSurfaceCoordinator(documentRef);
    const close = () => { menu?.remove(); menu = null; input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-controls'); input.setAttribute('aria-expanded', 'false'); surfaces?.forgetPopover('agent-node-mentions'); };
    input.addEventListener('input', () => {
        close();
        const before = input.value.slice(0, input.selectionStart);
        const match = before.match(/@([^\s@]*)$/); if (!match) return;
        const candidates = adapter.context().nodes.filter(node => `${node.name} ${node.type}`.toLowerCase().includes(match[1].toLowerCase())).slice(0, 30);
        if (!candidates.length) return;
        menu = documentRef.createElement('div'); menu.className = 'prompt-agent-node-mentions'; menu.setAttribute('role', 'listbox');
        menu.id = 'agent-node-mentions'; input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-expanded', 'true');
        const rect = input.getBoundingClientRect();
        Object.assign(menu.style, { left: `${Math.max(6, Math.min(rect.left, documentRef.defaultView.innerWidth - 290))}px`, bottom: `${documentRef.defaultView.innerHeight - rect.top + 4}px`, maxHeight: `${Math.max(60, rect.top - 16)}px` });
        documentRef.body.appendChild(menu); index = 0;
        candidates.forEach((node, i) => {
            const button = documentRef.createElement('button'); button.type = 'button'; button.textContent = `${node.name} · ${node.type} · ${node.id}`; button.setAttribute('role', 'option');
            button.id = `agent-node-mention-${i}`; button.setAttribute('aria-selected', String(i === 0));
            button.addEventListener('click', () => {
                const token = `@${node.name.replace(/\s/g, '_')}[${node.id}]`;
                mentions.set(node.id, { id: node.id, token, name: node.name, type: node.type });
                input.value = before.slice(0, -match[0].length) + token + ' ' + input.value.slice(input.selectionStart);
                close(); input.focus();
            }); menu.appendChild(button);
        });
        input.setAttribute('aria-activedescendant', menu.firstElementChild.id);
        surfaces?.openPopover('agent-node-mentions', { element: menu, trigger: input, owner: documentRef.getElementById('prompt-agent-panel'), close });
    });
    input.addEventListener('keydown', event => {
        if (!menu) return;
        const buttons = [...menu.children];
        if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
        if (event.key === 'Escape') close();
        else if (event.key === 'Enter') buttons[index]?.click();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            index = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons.forEach((button, i) => button.setAttribute('aria-selected', String(i === index))); buttons[index].scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', buttons[index].id);
        }
    }, true);
    return { close, read: () => [...mentions.values()].filter(item => input.value.includes(item.token)), clear: () => { mentions.clear(); close(); } };
}
