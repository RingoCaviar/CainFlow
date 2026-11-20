import { parseSizeAnswer } from './prompt-agent-size.js';
import { mergeAgentSizeAnswer } from './prompt-agent-parameters.js';
import { createThinkingControl } from '../execution/thinking-control.js';
import { resolveAgentProvider } from './prompt-agent-provider.js';
import { createPromptAgentModelMenus, getAgentModelLabel } from './prompt-agent-model-menu.js';
import { isCanvasGraphOnlyStep } from './prompt-agent-canvas-plan.js';
import { isPromptLibraryWrite } from './prompt-agent-apply-library-prompt.js';

export function renderCanvasPlan({ confirmedParameters = () => {}, documentRef, parent, plan, adapter, getModels, getProviders = () => [], getSize = () => ({}), getProviderId = () => '', getModelId, changed, run, isCurrent, loadReferencePreviews = true, preview = () => {}, configure = () => {} }) {
    const card = documentRef.createElement('section'); card.className = 'prompt-agent-canvas-plan';
    parent.appendChild(card);
    let busy = false;
    let refreshTimer = null;
    let lastAppliedId = null;
    const element = (tag, text, owner = card) => { const node = documentRef.createElement(tag); node.textContent = text;
        if (tag === 'button') node.className = 'btn btn-secondary'; owner.appendChild(node); return node; };
    const header = element('header', ''); header.className = 'prompt-agent-plan-header';
    const inPlace = plan.applyInPlace === true;
    const imageSettings = plan.steps.filter(step => step.type === 'ImageGenerate' && !step.cachedAssetKeys
        && !isCanvasGraphOnlyStep(plan, step) && !isPromptLibraryWrite(plan, step));
    const generatesImages = imageSettings.some(step => step.execute !== false);
    const copiesExisting = !inPlace && plan.steps.some(step => step.nodeId);
    element('strong', plan.deletes?.length ? '删除节点方案' : inPlace ? '画布修改方案'
        : copiesExisting ? '创建节点副本方案' : generatesImages ? '图片生成方案' : '画布方案', header);
    const impact = element('div', '', card); impact.className = 'prompt-agent-plan-impact';
    const destructiveImpact = element('p', '', impact); destructiveImpact.className = 'prompt-agent-plan-destructive-impact';
    const highlights = element('ul', '', impact); highlights.className = 'prompt-agent-plan-highlights';
    const referenceImpact = element('p', '', impact); referenceImpact.className = 'prompt-agent-plan-reference-impact';
    const overview = element('details', ''); overview.className = 'prompt-agent-plan-overview';
    const overviewSummary = element('summary', '查看方案详情', overview);
    const count = element('span', '', overviewSummary); count.className = 'prompt-agent-plan-count';
    const inputs = element('div', ''); inputs.className = 'prompt-agent-plan-inputs';
    const references = !inPlace || imageSettings.length ? adapter.inputs?.(plan) || [] : [];
    element('span', inPlace ? '修改现有节点' : references.length ? `本次生图参考图 · ${references.length} 项`
        : generatesImages ? '纯文字生成' : plan.steps.length ? '素材处理方案' : '删除节点方案', inputs);
    let destroyed = false;
    for (const reference of references) {
        const item = element('button', `${reference.name} → ${reference.purpose}${reference.upstream ? '（本次步骤输出）' : ''}`, inputs);
        item.type = 'button'; item.disabled = true; item.className = 'prompt-agent-plan-reference';
        if (loadReferencePreviews && reference.assetKey) Promise.resolve(adapter.readImage?.(reference.assetKey)).then(data => {
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
    const parameterPreviews = new Map();
    let existingGenerators = new Map();
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
        if (imageSettings.includes(step)) {
            const settings = element('details', '', row); settings.className = 'prompt-agent-step-settings';
            const modelLabel = element('summary', '模型与参数', settings);
            const select = element('select', '', settings); select.setAttribute('aria-label', `${step.title}的生图模型`);
            const parameters = element('pre', '', settings);
            parameters.className = 'prompt-agent-step-prompt';
            parameterPreviews.set(id, parameters);
            select.id = `agent-step-model-${plan.id}-${id}`;
            const original = () => existingGenerators.get(step.nodeId);
            const inheritedId = () => inPlace && step.nodeId ? original()?.modelId : getModelId();
            const chosenId = () => plan.modelOverrides?.[id] || inheritedId();
            const providerIdFor = modelId => plan.providerOverrides?.[id]?.[modelId]
                ?? (original()?.modelId === modelId ? original()?.providerId : getProviderId(modelId));
            const inheritedLabel = inPlace && step.nodeId ? '节点模型' : '面板模型';
            const inherit = element('option', inheritedLabel, select); inherit.value = '';
            for (const model of getModels()) { const option = element('option', getAgentModelLabel(model, getProviders(), providerIdFor(model.id)), select); option.value = model.id; }
            modelSelectors.push({ select, route: { getModels, getProviders, getProviderId: providerIdFor,
                setProviderId: (modelId, providerId) => { ((plan.providerOverrides ||= {})[id] ||= {})[modelId] = providerId; } } });
            const selected = plan.modelOverrides?.[id] || '';
            if (selected && !getModels().some(model => model.id === selected)) { const unavailable = element('option', '原模型已不可用，请重新选择', select); unavailable.value = selected; unavailable.disabled = true; }
            select.value = selected;
            let modelSignature = '';
            const refreshModels = () => {
                const models = getModels(), value = plan.modelOverrides?.[id] || '';
                const signature = JSON.stringify([models.map(model => [model.id, getAgentModelLabel(model, getProviders())]), value, inheritedId(), models.map(model => getAgentModelLabel(model, getProviders(), providerIdFor(model.id))),
                    getProviders().map(provider => [provider.id, provider.name, provider.endpoint])]);
                if (signature === modelSignature) return;
                modelSignature = signature; select.replaceChildren();
                const inherited = models.find(model => model.id === inheritedId());
                const option = element('option', inherited ? `${inheritedLabel}：${getAgentModelLabel(inherited, getProviders(), providerIdFor(inherited.id))}` : `未配置${inheritedLabel}`, select); option.value = '';
                for (const model of models) { const option = element('option', getAgentModelLabel(model, getProviders(), providerIdFor(model.id)), select); option.value = model.id; }
                if (value && !models.some(model => model.id === value)) { const option = element('option', '原模型已不可用，请重新选择', select); option.value = value; option.disabled = true; }
                select.value = value;
                const chosen = models.find(model => model.id === chosenId());
                modelLabel.textContent = `生图模型与参数：${chosen ? getAgentModelLabel(chosen, getProviders(), providerIdFor(chosen.id)) : '未选择'}`;
            };
            thinkingControls.push(createThinkingControl({ documentRef, parent: settings, title: `${step.title}的思考设置`,
                getOptions: () => { const model = getModels().find(item => item.id === chosenId()) || {};
                    return { model, provider: (() => { try { return resolveAgentProvider(model, getProviders(), providerIdFor(model.id)); } catch { return {}; } })(), protocol: model.protocol, task: 'image' }; },
                getValue: () => plan.thinkingOverrides?.[id]?.[chosenId()]
                    ?? (original()?.modelId === chosenId() ? original()?.thinking : undefined),
                onChange: value => { ((plan.thinkingOverrides ||= {})[id] ||= {})[chosenId()] = value; lastChanges = null; changed(plan); sync(); } }));
            refreshSelectors.push(refreshModels); select.addEventListener('focus', refreshModels);
            select.addEventListener('change', () => { (plan.modelOverrides ||= {})[id] = select.value; if (!select.value) delete plan.providerOverrides?.[id]; lastChanges = null; changed(plan); sync(); });
        }
    }
    const modelMenus = createPromptAgentModelMenus({ documentRef, selects: modelSelectors });
    const changes = element('ul', '', overview);
    changes.className = 'prompt-agent-change-list';
    let configurationTarget = null;
    let sizeIssue = null;
    let lastUnavailable = '';
    const sizePrompt = element('div', ''); sizePrompt.className = 'prompt-agent-size-clarification';
    const sizeSummaries = element('div', '', overview); sizeSummaries.className = 'prompt-agent-size-summary';
    const repair = element('button', '配置模型与供应商'); repair.type = 'button'; repair.hidden = true;
    repair.addEventListener('click', () => { if (configurationTarget && isCurrent()) configure(configurationTarget); });
    const refresh = element('button', '刷新变更清单', overview); refresh.type = 'button'; refresh.hidden = inPlace;
    const footer = element('footer', ''); footer.className = 'prompt-agent-plan-footer';
    const status = element('p', '', footer); status.setAttribute('role', 'status');
    const actions = element('div', '', footer); actions.className = 'prompt-agent-canvas-actions';
    const primaryActions = element('div', '', actions); primaryActions.className = 'prompt-agent-actions-primary';
    const execute = element('button', '运行', primaryActions), apply = element('button', '仅应用', primaryActions);
    execute.className = 'btn btn-primary';
    execute.title = '先应用该方案，再执行相关节点';
    apply.title = '保存画布修改，等你决定何时运行';
    if (plan.deletes?.length) apply.title = '确认删除列出的节点并保存画布';
    const retry = element('button', '重试未完成步骤', actions), undo = element('button', '撤销本次画布操作', actions);
    const copy = plan.offerCopy ? element('button', '创建副本', actions) : null;
    [apply, execute, retry, undo, ...(copy ? [copy] : [])].forEach(button => { button.type = 'button'; });
    let lastChanges = null;
    let renderedChanges = '';
    const latest = () => lastAppliedId === plan.id ? plan : plan.instances?.at(-1) || plan;
    const running = () => [plan, ...(plan.instances || [])].filter(instance => adapter.isRunning?.(instance.id));
    function sync() {
        if (destroyed) return;
        if (!busy && !plan.runs?.length) plan.agentSizes = Object.fromEntries(getModels().map(model => [model.id, getSize(model.id)]));
        if (!busy) plan.agentProviders = Object.fromEntries(getModels().map(model => [model.id, getProviderId(model.id)]));
        if (inPlace && imageSettings.some(step => step.nodeId)) {
            existingGenerators = new Map((adapter.context?.().nodes || []).map(node => [node.id, node]));
        }
        thinkingControls.forEach(control => control.refresh());
        focusButtons.forEach((button, id) => { button.disabled = !latest().bindings?.[id] && !plan.steps.find(step => step.id === id)?.nodeId; button.hidden = button.disabled; });
        refreshSelectors.forEach(refresh => refresh());
        const applied = latest();
        const described = adapter.describe(plan, getModelId());
        if (!inPlace || !applied.appliedSignature || !lastChanges) lastChanges = described;
        const signature = JSON.stringify(lastChanges);
        if (signature !== renderedChanges) {
            renderedChanges = signature;
            changes.replaceChildren();
            for (const line of lastChanges) element('li', line, changes);
            const destructive = line => /^(删除 |移除连线 )/.test(line);
            const prioritized = lastChanges.filter(destructive);
            const compact = adapter.describe(plan, getModelId(), { compact: true });
            const primary = [...prioritized, ...compact.filter(line => !destructive(line))].slice(0, 2);
            const deletionCount = plan.deletes?.length || 0;
            const removedConnections = prioritized.filter(line => line.startsWith('移除连线')).length;
            destructiveImpact.textContent = [deletionCount ? `删除 ${deletionCount} 个节点` : '',
                removedConnections ? `移除 ${removedConnections} 条连线` : ''].filter(Boolean).join(' · ');
            highlights.replaceChildren();
            for (const line of primary) element('li', line, highlights);
            changes.hidden = lastChanges.length === 0;
            highlights.hidden = primary.length === 0;
            count.textContent = lastChanges.length ? `${lastChanges.length} 项变更` : '';
        }
        const preservedReferences = adapter.preservedReferenceCount?.(plan) || 0;
        const referenceSummary = preservedReferences ? `保留 ${preservedReferences} 条参考图连线` : generatesImages
            ? (references.length ? `本次生图参考图 · ${references.length} 项` : '纯文字生成') : '';
        const contextSummary = [copiesExisting ? '保留原节点和连线' : '', referenceSummary].filter(Boolean).join(' · ')
            || (!highlights.childElementCount ? plan.steps.map(step => step.title).join('、') : '');
        if (referenceImpact.textContent !== contextSummary) referenceImpact.textContent = contextSummary;
        for (const [id, label] of stepStates) {
            const stepStatus = adapter.stepStatus(latest(), id);
            label.dataset.status = stepStatus;
            label.textContent = { draft: '待确认', applied: plan.steps.find(step => step.id === id)?.execute === false ? '已应用' : '待执行',
                cached: '使用缓存', pending: '等待执行', running: '执行中', completed: '已完成', failed: '失败', interrupted: '未完成' }[stepStatus] || '未执行';
        }
        let unavailable = '';
        configurationTarget = null;
        try { adapter.modelsFor(plan, getModelId()); } catch (error) { unavailable = error.message; configurationTarget = error.configurationTarget; }
        sizeIssue = null; sizePrompt.replaceChildren(); sizeSummaries.replaceChildren();
        let validated = {};
        if (!unavailable) try {
            validated = adapter.sizesFor?.(plan, getModelId()) || {};
            const sizes = applied.runs?.length && applied.appliedSizes ? applied.appliedSizes : validated;
            for (const [id, size] of Object.entries(sizes)) element('p', `${plan.steps.find(step => step.id === id).title} · ${size.summary}${Object.values(size.sources || {}).some(Boolean) ? "（" + [...new Set(Object.values(size.sources).filter(Boolean))].join("、") + "）" : ""}`, sizeSummaries);
        } catch (error) {
            unavailable = error.message;
            if (error.sizeClarification && !plan.runs?.length) {
                sizeIssue = error; element('p', error.message, sizePrompt);
                for (const option of error.sizeClarification.choices) {
                    const choice = element('button', option.label, sizePrompt); choice.type = 'button'; choice.disabled = busy;
                    const field = error.sizeClarification.kind === 'aspect' ? 'aspectRatio' : 'resolution';
                    choice.addEventListener('click', () => answerSize({ [field]: option.value }));
                }
                if (error.sizeClarification.kind === 'dimensions') element('p', '可在输入框回复宽×高，例如 1536×1024；或在尺寸设置中填写。', sizePrompt);
            } else if (error.parameterClarification && !plan.runs?.length) {
                element('p', error.message, sizePrompt);
                const step = plan.steps.find(item => item.id === error.stepId);
                for (const option of error.parameterClarification.choices) {
                    const choice = element('button', option.label, sizePrompt); choice.type = 'button'; choice.disabled = busy;
                    choice.addEventListener('click', () => {
                        if (busy || !isCurrent() || !step) return;
                        step.parameterAnswers = { ...step.parameterAnswers, [error.parameterClarification.field]: option.value };
                        confirmedParameters(plan, { [error.parameterClarification.field]: option.value }, step.id);
                        delete plan.appliedSignature; sync(); changed(plan);
                    });
                }
            }
        }
        for (const [id, preview] of parameterPreviews) {
            const step = plan.steps.find(item => item.id === id);
            const settings = validated[id]?.parameterPatch || { ...step.parameters, ...step.generationPatch };
            const { count, aspectRatio, ...fields } = settings;
            preview.textContent = Object.entries({ prompt: step.parameters?.prompt, ...fields,
                ...(count !== undefined ? { generationCount: count } : {}),
                ...(aspectRatio !== undefined ? { aspect: aspectRatio } : {}),
                ...(step.negativePrompt ? { negativePrompt: step.negativePrompt } : {}) })
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key}：${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n');
        }
        repair.hidden = !configurationTarget; repair.disabled = busy;
        apply.disabled = execute.disabled = busy || adapter.isPreparing?.() || inPlace && adapter.isRunning?.(plan.id) || !isCurrent() || Boolean(unavailable);
        if (copy) copy.disabled = apply.disabled;
        retry.disabled = execute.disabled || !latest().runs?.length || adapter.isRunning?.(latest().id);
        const failed = [...stepStates.keys()].some(id => ['failed', 'interrupted'].includes(adapter.stepStatus(latest(), id)));
        const completed = stepStates.size > 0 && [...stepStates.keys()].every(id => ['completed','cached'].includes(adapter.stepStatus(latest(), id)));
        retry.hidden = !failed || busy;
        if (completed && !card.classList.contains('is-completed')) overview.open = false;
        card.classList.toggle('is-completed', completed);
        undo.hidden = !Object.keys(latest().bindings || {}).length && !latest().appliedSignature;
        execute.hidden = !plan.steps.some(step => step.execute !== false);
        undo.title = undo.hidden ? '' : adapter.canUndo(latest());
        undo.disabled = busy || undo.hidden || Boolean(undo.title);
        if (applied.appliedSignature && !status.textContent) {
            status.textContent = failed ? '上次执行未完成，结果见下方'
                : completed ? '执行结束，结果见下方' : '画布方案已应用并保存';
        }
        refresh.disabled = busy || !isCurrent();
        for (const select of list.querySelectorAll('select, .thinking-control input, .thinking-control button')) select.disabled = busy;
        if (unavailable) status.textContent = unavailable;
        else if (!busy && lastUnavailable && status.textContent === lastUnavailable) status.textContent = '尺寸与模型已校验，确认后可应用。';
        else if (!busy && !status.textContent) status.textContent = execute.hidden
            ? '待确认' : '待确认 · 运行会先应用方案，再执行相关节点';
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
        step.sizeAnswer = mergeAgentSizeAnswer(step.sizeAnswer, patch);
        confirmedParameters(plan, patch, step.id);
        delete plan.appliedSignature; sync(); changed(plan); return true;
    }
    async function act(generate, retryOnly = false, authorized = isCurrent, asCopy = false) {
        const canApply = () => isCurrent() && authorized();
        if (busy || !canApply()) return;
        busy = true; sync(); status.textContent = '正在校验与应用…';
        let instance;
        try {
            // Return the click to the browser before constructing the batch. A
            // queued action still belongs to the same authorized conversation.
            await new Promise(resolve => setTimeout(resolve, 0));
            if (destroyed || !canApply()) return;
            const instantiate = asCopy || !inPlace && plan.steps.length;
            instance = retryOnly ? latest() : instantiate ? adapter.instantiate(plan) : plan;
            if (asCopy) for (const step of imageSettings) {
                const source = existingGenerators.get(step.nodeId);
                if (!source?.modelId) continue;
                const modelId = (instance.modelOverrides ||= {})[step.id] ||= source.modelId;
                if (modelId !== source.modelId) continue;
                if (source.providerId) ((instance.providerOverrides ||= {})[step.id] ||= {})[modelId] ??= source.providerId;
                if (source.thinking) ((instance.thinkingOverrides ||= {})[step.id] ||= {})[modelId] ??= source.thinking;
            }
            if (!retryOnly && instance !== plan) (plan.instances ||= []).push(instance);
            await adapter.apply(instance, getModelId(), () => changed(instance), canApply); changed(instance);
            lastAppliedId = instance.id;
        } catch (error) {
            if (instance?.templateId && !instance.bindings?.[instance.order[0]]) {
                plan.instances = (plan.instances || []).filter(item => item.id !== instance.id);
                changed({ ...instance, discarded: true });
            }
            if (isCurrent()) status.textContent = error.message;
            return;
        } finally { busy = false; if (isCurrent()) sync(); }
        if (!canApply()) { adapter.discardExecutionConfig?.(instance); return; }
        status.textContent = '画布方案已应用并保存';
        if (!generate) { adapter.discardExecutionConfig?.(instance); return; }
        const complete = async () => {
            try {
                status.textContent = instance === plan ? '正在运行画布中的目标节点' : '新批次执行中，可继续运行或仅应用';
                const completion = run(instance, retryOnly);
                sync();
                await completion;
                if (isCurrent()) status.textContent = running().length ? '其他批次执行中，可继续创建' : '执行结束，结果见下方';
            } catch (error) { if (isCurrent()) status.textContent = error.message; }
            finally { adapter.discardExecutionConfig?.(instance); changed(instance); if (isCurrent()) sync(); }
        };
        const completion = complete();
        if (authorized === isCurrent) await completion;
    }
    apply.addEventListener('click', () => act(false)); execute.addEventListener('click', () => act(true)); retry.addEventListener('click', () => act(true, true));
    copy?.addEventListener('click', () => { void act(false, false, isCurrent, true); });
    refresh.addEventListener('click', () => { try {
        adapter.refresh(plan);
        lastChanges = null;
        changed(plan); status.textContent = '已按当前画布更新清单，请重新检查后应用';
    } catch (error) { status.textContent = error.message; } sync(); });
    undo.addEventListener('click', async () => { try { await adapter.undo(latest()); status.textContent = '已按撤销栈处理；历史图片仍保留'; } catch (error) { status.textContent = error.message; } sync(); });
    sync();
    return {
        planId: plan.id, setInstances: instances => { plan.instances = instances; sync(); }, answerSize, sync,
        start: (mode, authorized) => {
            sync();
            if ((mode === 'run' ? execute : apply).disabled) return;
            return act(mode === 'run' && !execute.hidden, false, authorized);
        },
        close: () => { modelMenus.close(); thinkingControls.forEach(control => control.close()); },
        destroy: () => { destroyed = true; clearInterval(refreshTimer); thinkingControls.forEach(control => control.destroy()); modelMenus.destroy(); }
    };
}

export function createCanvasMentions({ input, adapter, close }) {
    const mentions = new Map();
    const remember = node => {
        const token = `@${node.name.replace(/[\s@\[\]]/g, '_')}[${node.id}]`;
        mentions.set(node.id, { id: node.id, token, name: node.name, type: node.type });
        return token;
    };
    const read = () => {
        const tokens = [...input.value.matchAll(/@[^\s@\[\]]+\[([^\]\r\n]+)\]/g)]
            .filter((match, index, matches) => matches.findIndex(item => item[1] === match[1]) === index);
        if (!tokens.length) return [];
        const missing = tokens.filter(match => mentions.get(match[1])?.token !== match[0]);
        const nodes = missing.length ? new Map(adapter.context().nodes.map(node => [node.id, node])) : null;
        return tokens.flatMap(([token, id]) => {
            const remembered = mentions.get(id);
            if (remembered?.token === token) return [remembered];
            const node = nodes?.get(id);
            return node ? [{ id, token, name: node.name, type: node.type }] : [];
        });
    };
    const append = node => {
        if (read().some(item => item.id === node.id)) return false;
        const token = remember(node);
        input.value += `${input.value && !/\s$/.test(input.value) ? '\n' : ''}${token} `;
        input.setSelectionRange(input.value.length, input.value.length);
        close(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
        return true;
    };
    return { close, read, append, remember, clear: () => { mentions.clear(); close(); } };
}
