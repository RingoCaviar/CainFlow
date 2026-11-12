import { parseSizeAnswer } from './prompt-agent-size.js';
import { createThinkingControl } from '../execution/thinking-control.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { createPromptAgentModelMenus, getAgentModelLabel } from './prompt-agent-model-menu.js';

export function renderCanvasPlan({ confirmedParameters = () => {}, documentRef, parent, plan, adapter, getModels, getProviders = () => [], getSize = () => ({}), getProviderId = () => '', getModelId, changed, run, isCurrent, preview = () => {}, configure = () => {} }) {
    const card = documentRef.createElement('section'); card.className = 'prompt-agent-canvas-plan';
    parent.appendChild(card);
    let busy = false;
    let refreshTimer = null;
    const element = (tag, text, owner = card) => { const node = documentRef.createElement(tag); node.textContent = text;
        if (tag === 'button') node.className = 'btn btn-secondary'; owner.appendChild(node); return node; };
    const header = element('header', ''); header.className = 'prompt-agent-plan-header';
    const generatesImages = plan.steps.some(step => step.type === 'ImageGenerate');
    const title = element('strong', generatesImages ? '图片生成方案' : '画布修改方案', header);
    title.title = plan.id;
    const overview = element('details', ''); overview.className = 'prompt-agent-plan-overview';
    const overviewSummary = element('summary', '查看详情', overview);
    const count = `${plan.steps.length + (plan.deletes?.length || 0)} 项操作`;
    element('span', count, overviewSummary).className = 'prompt-agent-plan-count';
    const inputs = element('div', ''); inputs.className = 'prompt-agent-plan-inputs';
    const references = adapter.inputs?.(plan) || [];
    element('span', references.length ? `本次生图参考图 · ${references.length} 项`
        : plan.steps.some(step => step.type === 'ImageGenerate') ? '纯文字生成' : plan.steps.length ? '素材处理方案' : '删除节点方案', inputs);
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
    const list = element('ol', ''); list.className = 'prompt-agent-plan-steps';
    overview.appendChild(inputs); overview.appendChild(list);
    const stepStates = new Map();
    const refreshSelectors = [];
    const thinkingControls = [];
    const modelSelectors = [];
    const focusButtons = new Map();
    for (const id of plan.order) {
        const step = plan.steps.find(item => item.id === id);
        const row = element('li', '', list);
        const heading = element('div', '', row); heading.className = 'prompt-agent-step-heading';
        element('span', String(stepStates.size + 1), heading).className = 'prompt-agent-step-number';
        element('strong', step.title, heading).className = 'prompt-agent-step-title';
        const badge = element('span', '', heading); badge.className = 'prompt-agent-step-status';
        stepStates.set(id, badge);
        const focus = element('button', '定位', heading); focus.type = 'button'; focus.addEventListener('click', () => adapter.focus(latest().bindings?.[id] || step.nodeId));
        focusButtons.set(id, focus);
        if (step.type === 'ImageGenerate') {
            const settings = element('details', '', row); settings.className = 'prompt-agent-step-settings';
            const modelLabel = element('summary', '模型与参数', settings);
            const select = element('select', '', settings); select.setAttribute('aria-label', `${step.title}的生图模型`);
            const parameters = element('pre', Object.entries({ ...step.parameters, ...step.generationPatch,
                ...(step.negativePrompt ? { negativePrompt: step.negativePrompt } : {}) }).map(([key, value]) => `${key}：${value}`).join('\n'), settings);
            parameters.className = 'prompt-agent-step-prompt';
            if (step.parameterSources) element('small', Object.entries(step.parameterSources).map(([key,source])=>`${key}：${source}`).join(' · '), settings);
            select.id = `agent-step-model-${plan.id}-${id}`;
            const providerIdFor = modelId => plan.providerOverrides?.[id]?.[modelId] ?? getProviderId(modelId);
            const inherit = element('option', '使用面板手动选择的模型', select); inherit.value = '';
            for (const model of getModels()) { const option = element('option', getAgentModelLabel(model, getProviders(), providerIdFor(model.id)), select); option.value = model.id; }
            modelSelectors.push({ select, route: { getModels, getProviders, getProviderId: providerIdFor,
                setProviderId: (modelId, providerId) => { ((plan.providerOverrides ||= {})[id] ||= {})[modelId] = providerId; } } });
            const selected = plan.modelOverrides?.[id] || '';
            if (selected && !getModels().some(model => model.id === selected)) { const unavailable = element('option', '原模型已不可用，请重新选择', select); unavailable.value = selected; unavailable.disabled = true; }
            select.value = selected;
            let modelSignature = '';
            const refreshModels = () => {
                const models = getModels(), value = plan.modelOverrides?.[id] || '';
                const signature = JSON.stringify([models.map(model => [model.id, getAgentModelLabel(model, getProviders())]), value, getModelId(), models.map(model => getAgentModelLabel(model, getProviders(), providerIdFor(model.id))),
                    getProviders().map(provider => [provider.id, provider.name, provider.endpoint])]);
                if (signature === modelSignature) return;
                modelSignature = signature; select.replaceChildren();
                const inherited = models.find(model => model.id === getModelId());
                const option = element('option', inherited ? `面板模型：${getAgentModelLabel(inherited, getProviders(), getProviderId(inherited.id))}` : '请先选择面板模型', select); option.value = '';
                for (const model of models) { const option = element('option', getAgentModelLabel(model, getProviders(), providerIdFor(model.id)), select); option.value = model.id; }
                if (value && !models.some(model => model.id === value)) { const option = element('option', '原模型已不可用，请重新选择', select); option.value = value; option.disabled = true; }
                select.value = value;
                const chosen = models.find(model => model.id === (value || getModelId()));
                modelLabel.textContent = `生图模型与参数：${chosen ? getAgentModelLabel(chosen, getProviders(), value ? providerIdFor(chosen.id) : getProviderId(chosen.id)) : '未选择'}`;
            };
            thinkingControls.push(createThinkingControl({ documentRef, parent: settings, title: `${step.title}的思考设置`,
                getOptions: () => { const model = getModels().find(item => item.id === (plan.modelOverrides?.[id] || getModelId())) || {};
                    return { model, provider: (() => { try { return resolveAgentProvider(model, getProviders(), plan.modelOverrides?.[id] ? providerIdFor(model.id) : getProviderId(model.id)); } catch { return {}; } })(), protocol: model.protocol, task: 'image' }; },
                getValue: () => plan.thinkingOverrides?.[id]?.[plan.modelOverrides?.[id] || getModelId()],
                onChange: value => { ((plan.thinkingOverrides ||= {})[id] ||= {})[plan.modelOverrides?.[id] || getModelId()] = value; changed(plan); sync(); } }));
            refreshSelectors.push(refreshModels); select.addEventListener('focus', refreshModels);
            select.addEventListener('change', () => { (plan.modelOverrides ||= {})[id] = select.value; if (!select.value) delete plan.providerOverrides?.[id]; changed(plan); sync(); });
        }
    }
    const modelMenus = createPromptAgentModelMenus({ documentRef, selects: modelSelectors });
    const details = element('details', ''); details.className = 'prompt-agent-plan-changes'; details.open = false;
    overview.appendChild(details);
    element('summary', '变更与尺寸明细', details);
    const changes = element('ul', '', details);
    changes.className = 'prompt-agent-change-list';
    adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
    const status = element('p', ''); status.setAttribute('role', 'status');
    let configurationTarget = null;
    let sizeIssue = null;
    let lastUnavailable = '';
    const sizePrompt = element('div', ''); sizePrompt.className = 'prompt-agent-size-clarification';
    const sizeSummaries = element('div', '', details); sizeSummaries.className = 'prompt-agent-size-summary';
    const repair = element('button', '配置模型与供应商'); repair.type = 'button'; repair.hidden = true;
    repair.addEventListener('click', () => { if (configurationTarget && isCurrent()) configure(configurationTarget); });
    const actions = element('div', '', header); actions.className = 'prompt-agent-canvas-actions';
    const refresh = element('button', '刷新变更清单', details); refresh.type = 'button';
    const primaryActions = element('div', '', actions); primaryActions.className = 'prompt-agent-actions-primary';
    const moreActions = element('details', '', actions); moreActions.className = 'prompt-agent-actions-more';
    const moreSummary = element('summary', '⋯', moreActions); moreSummary.setAttribute('aria-label', '更多方案操作');
    const secondaryActions = element('div', '', moreActions); secondaryActions.className = 'prompt-agent-actions-secondary';
    const execute = element('button', '运行', primaryActions), apply = element('button', '仅应用', primaryActions);
    execute.className = 'btn btn-primary';
    const retry = element('button', '重试未完成步骤', secondaryActions), undo = element('button', '撤销本次画布操作', secondaryActions);
    const buttons = [apply, execute, retry, undo]; buttons.forEach(button => { button.type = 'button'; });
    const surfaces = getSurfaceCoordinator(documentRef);
    const closeMoreActions = () => {
        moreActions.open = false;
        surfaces?.forgetPopover(moreActions);
    };
    moreActions.addEventListener('toggle', () => {
        if (moreActions.open && !moreActions.hidden && moreActions.isConnected) {
            surfaces?.openPopover(moreActions, { element: moreActions, trigger: moreSummary, close: closeMoreActions });
        } else surfaces?.forgetPopover(moreActions);
    });
    const latest = () => plan.instances?.at(-1) || plan;
    const running = () => (plan.instances || []).filter(instance => adapter.isRunning?.(instance.id));
    function sync() {
        if (destroyed) return;
        if (!busy && !plan.runs?.length) plan.agentSizes = Object.fromEntries(getModels().map(model => [model.id, getSize(model.id)]));
        if (!busy) plan.agentProviders = Object.fromEntries(getModels().map(model => [model.id, getProviderId(model.id)]));
        thinkingControls.forEach(control => control.refresh());
        focusButtons.forEach((button, id) => { button.disabled = !latest().bindings?.[id] && !plan.steps.find(step => step.id === id)?.nodeId; button.hidden = button.disabled; });
        refreshSelectors.forEach(refresh => refresh());
        changes.replaceChildren(); adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
        for (const [id, label] of stepStates) {
            const stepStatus = adapter.stepStatus(latest(), id);
            label.dataset.status = stepStatus;
            label.textContent = { draft: '待确认', applied: '待执行', cached: '使用缓存', pending: '等待执行', running: '执行中', completed: '已完成', failed: '失败', interrupted: '未完成' }[stepStatus] || '未执行';
        }
        let unavailable = '';
        configurationTarget = null;
        try { adapter.modelsFor(plan, getModelId()); } catch (error) { unavailable = error.message; configurationTarget = error.configurationTarget; }
        sizeIssue = null; sizePrompt.replaceChildren(); sizeSummaries.replaceChildren();
        if (!unavailable) try {
            const validated = adapter.sizesFor?.(plan, getModelId()) || {};
            const sizes = plan.runs?.length && plan.appliedSizes ? plan.appliedSizes : validated;
            for (const [id, size] of Object.entries(sizes)) element('p', `${plan.steps.find(step => step.id === id).title} · ${size.summary}${Object.values(size.sources || {}).some(Boolean) ? "（" + [...new Set(Object.values(size.sources).filter(Boolean))].join("、") + "）" : ""}`, sizeSummaries);
        } catch (error) {
            unavailable = error.message;
            if (error.sizeClarification && !plan.runs?.length) {
                sizeIssue = error; element('p', error.message, sizePrompt);
                for (const option of error.sizeClarification.choices) {
                    const choice = element('button', option.label, sizePrompt); choice.type = 'button'; choice.disabled = busy;
                    choice.addEventListener('click', () => answerSize({ resolution: option.value }));
                }
                if (error.sizeClarification.kind === 'dimensions') element('p', '可在输入框回复宽×高，例如 1536×1024；或在尺寸设置中填写。', sizePrompt);
            }
        }
        repair.hidden = !configurationTarget; repair.disabled = busy;
        apply.disabled = execute.disabled = busy || adapter.isPreparing?.() || !isCurrent() || Boolean(unavailable);
        retry.disabled = execute.disabled || !latest().runs?.length || adapter.isRunning?.(latest().id);
        const failed = [...stepStates.keys()].some(id => ['failed', 'interrupted'].includes(adapter.stepStatus(latest(), id)));
        const completed = stepStates.size > 0 && [...stepStates.keys()].every(id => ['completed','cached'].includes(adapter.stepStatus(latest(), id)));
        retry.hidden = !failed || busy;
        if (completed && !card.classList.contains('is-completed')) overview.open = false;
        card.classList.toggle('is-completed', completed);
        title.textContent = generatesImages ? '图片生成方案' : '画布方案';
        undo.hidden = !Object.keys(latest().bindings || {}).length && !latest().appliedSignature;
        execute.hidden = !plan.steps.some(step => step.execute !== false);
        undo.disabled = busy || Boolean(adapter.canUndo(latest())); undo.title = adapter.canUndo(latest());
        moreActions.hidden = retry.hidden && undo.hidden;
        if (moreActions.hidden && moreActions.open) closeMoreActions();
        refresh.disabled = busy || !isCurrent();
        for (const select of list.querySelectorAll('select, .thinking-control input, .thinking-control button')) select.disabled = busy;
        if (unavailable) status.textContent = unavailable;
        else if (!busy && lastUnavailable && status.textContent === lastUnavailable) status.textContent = '尺寸与模型已校验，确认后可应用。';
        lastUnavailable = unavailable;
        if (running().length && !refreshTimer) refreshTimer = setInterval(() => { if (isCurrent()) sync(); }, 250);
        else if (!running().length && refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }
    function answerSize(answer) {
        if (busy || !isCurrent() || !sizeIssue) return false;
        const patch = typeof answer === 'string' ? parseSizeAnswer(answer) : answer;
        if (!patch) return false;
        const step = plan.steps.find(item => item.id === sizeIssue.stepId);
        if (!step) return false;
        if (patch.resolution && patch.resolution !== 'custom') {
            for (const value of [step.parameters, step.generationPatch, step.sizeAnswer]) if (value) { delete value.customWidth; delete value.customHeight; }
        }
        step.sizeAnswer = { ...step.sizeAnswer, ...patch };
        confirmedParameters(plan, patch, step.id);
        delete plan.appliedSignature; sync(); changed(plan); return true;
    }
    async function act(generate, retryOnly = false) {
        if (busy || !isCurrent()) return;
        busy = true; sync(); status.textContent = '正在校验与应用…';
        let instance;
        try {
            instance = retryOnly ? latest() : plan.steps.length ? adapter.instantiate(plan) : plan;
            if (!retryOnly && instance !== plan) (plan.instances ||= []).push(instance);
            await adapter.apply(instance, getModelId(), () => changed(instance), isCurrent); changed(instance);
        } catch (error) {
            if (instance?.templateId && !instance.bindings?.[instance.order[0]]) {
                plan.instances = (plan.instances || []).filter(item => item.id !== instance.id);
                changed({ ...instance, discarded: true });
            }
            if (isCurrent()) status.textContent = error.message;
            return;
        } finally { busy = false; if (isCurrent()) sync(); }
        if (!isCurrent()) { adapter.discardExecutionConfig?.(instance); return; }
        status.textContent = '画布方案已应用并保存';
        if (!generate) { adapter.discardExecutionConfig?.(instance); return; }
        try {
            status.textContent = '新批次执行中，可继续运行或仅应用';
            const completion = run(instance, retryOnly);
            sync();
            await completion;
            if (isCurrent()) status.textContent = running().length ? '其他批次执行中，可继续创建' : '执行结束，结果见下方';
        } catch (error) { if (isCurrent()) status.textContent = error.message; }
        finally { adapter.discardExecutionConfig?.(instance); changed(instance); if (isCurrent()) sync(); }
    }
    apply.addEventListener('click', () => act(false)); execute.addEventListener('click', () => act(true)); retry.addEventListener('click', () => act(true, true));
    refresh.addEventListener('click', () => { try {
        adapter.refresh(plan); changes.replaceChildren(); adapter.describe(plan, getModelId()).forEach(line => element('li', line, changes));
        changed(plan); status.textContent = '已按当前画布更新清单，请重新检查后应用';
    } catch (error) { status.textContent = error.message; } sync(); });
    undo.addEventListener('click', async () => { try { await adapter.undo(latest()); status.textContent = '已按撤销栈处理；历史图片仍保留'; } catch (error) { status.textContent = error.message; } sync(); });
    sync();
    return {
        planId: plan.id, setInstances: instances => { plan.instances = instances; sync(); }, answerSize, sync,
        close: () => { closeMoreActions(); modelMenus.close(); thinkingControls.forEach(control => control.close()); },
        destroy: () => { destroyed = true; closeMoreActions(); clearInterval(refreshTimer); thinkingControls.forEach(control => control.destroy()); modelMenus.destroy(); }
    };
}

export function attachCanvasMentions({ documentRef, input, adapter }) {
    const mentions = new Map(); let menu = null; let index = 0;
    const remember = node => {
        const token = `@${node.name.replace(/\s/g, '_')}[${node.id}]`;
        mentions.set(node.id, { id: node.id, token, name: node.name, type: node.type });
        return token;
    };
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
                const token = remember(node);
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
    const read = () => [...mentions.values()].filter(item => input.value.includes(item.token));
    const append = node => {
        if (read().some(item => item.id === node.id)) return false;
        const token = remember(node);
        input.value += `${input.value && !/\s$/.test(input.value) ? '\n' : ''}${token} `;
        input.setSelectionRange(input.value.length, input.value.length);
        close(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
        return true;
    };
    return { close, read, append, clear: () => { mentions.clear(); close(); } };
}
