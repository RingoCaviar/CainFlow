import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { getThinkingCapability, resolveThinking, THINKING_PROFILES } from './thinking-config.js';
import { createPromptAgentModelMenus } from '../prompt-agent/prompt-agent-model-menu.js';
let sequence = 0;
// DOM-only shared control. Callers own persistence and undo; refresh never writes.
export function createThinkingControl({ documentRef, parent, getOptions, getValue, onChange, inherit = true, title = '思考设置', compact = false }) {
    const host = documentRef.createElement('details'); host.className = 'thinking-control';
    const summary = documentRef.createElement('summary'); summary.textContent = compact ? '思考' : title; summary.title = title; summary.setAttribute('aria-label', title); host.appendChild(summary);
    if (compact) {
        host.classList.add('thinking-control-compact');
        summary.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface-panel-strong)"/><circle cx="15" cy="17" r="3" fill="var(--surface-panel-strong)"/></svg>';
    }
    const content = documentRef.createElement('div'); content.className = 'thinking-control-content'; host.appendChild(content); parent.appendChild(host);
    const prefix = `thinking-${++sequence}`;
    let menus, signature = '';
    const surfaces = getSurfaceCoordinator(documentRef);
    const close = () => { menus?.close(); surfaces?.forgetPopover(`${prefix}-popover`); host.open = false; host.appendChild(content); content.classList.remove('prompt-agent-thinking-menu'); };
    const position = () => { if (!compact || !host.open) return; const rect = summary.getBoundingClientRect(), view = documentRef.defaultView;
        const width = Math.min(280, view.innerWidth - 16); Object.assign(content.style, { width: `${width}px`, left: `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`,
            top: `${Math.max(8, rect.top - Math.min(320, content.scrollHeight) - 6)}px`, maxHeight: `${Math.max(80, rect.top - 16)}px` }); };

    const refresh = () => {
        const options = getOptions(), value = getValue(), capability = getThinkingCapability(options);
        const next = JSON.stringify([options.model?.id, options.model?.thinking, options.provider?.id, options.protocol, options.task, value, capability]);
        if (next === signature) return; signature = next; menus?.destroy(); content.replaceChildren();
        const select = documentRef.createElement('select'); select.id = prefix; select.setAttribute('aria-label', title);
        const add = (key, label) => { const option = documentRef.createElement('option'); option.value = key; option.textContent = label; select.appendChild(option); };
        if (inherit) add('inherit', '继承上级设置'); add('default', '接口默认（不传参数）');
        if (capability.supported) {
            if (capability.off) add('off', '关闭思考');
            if (capability.on) add('on', '开启思考（默认强度）');
            if (capability.dynamic) add('dynamic', '动态 Token 预算');
            for (const level of capability.levels || []) add(`level:${level}`, level === 'none' ? '关闭 · none' : `思考程度 · ${level}`);
            if (capability.max) add('budget', `Token 预算（${capability.min}–${capability.max}）`);
        }
        const selected = !value || value.mode === 'inherit' ? (inherit ? 'inherit' : 'default') : value.mode === 'level' ? `level:${value.value}` : value.mode;
        if (![...select.options].some(option => option.value === selected)) add(selected, '原思考设置不可用，请重新选择');
        select.value = selected; content.appendChild(select);
        const budget = documentRef.createElement('input'); budget.type = 'number'; budget.step = '1'; budget.min = capability.min ?? 1; budget.max = capability.max ?? ''; budget.value = value?.mode === 'budget' ? value.value : ''; budget.placeholder = '输入 Token 数'; budget.setAttribute('aria-label', `${title} Token 预算`); budget.hidden = selected !== 'budget'; content.appendChild(budget);
        const status = documentRef.createElement('small'); status.setAttribute('aria-live', 'polite'); content.appendChild(status);
        try { const resolved = resolveThinking(options, value); status.textContent = capability.supported ? (resolved.setting.mode === 'default' ? '由接口决定实际思考行为' : `生效：${resolved.setting.mode === 'level' || resolved.setting.mode === 'budget' ? resolved.setting.value : resolved.setting.mode}`) : capability.reason; }
        catch (error) { status.textContent = error.message; }
        const commit = () => {
            const mode = select.value;
            budget.hidden = mode !== 'budget';
            if (mode === 'budget' && !budget.value.trim()) { status.textContent = '请输入思考 Token 预算'; budget.focus(); return; }
            const nextValue = mode === 'inherit' ? undefined : mode.startsWith('level:') ? { mode: 'level', value: mode.slice(6) }
                : mode === 'budget' ? { mode, value: Number(budget.value) } : { mode };
            try { resolveThinking(options, nextValue); onChange(nextValue); signature = ''; refresh(); }
            catch (error) { status.textContent = error.message; }
        };
        select.addEventListener('change', commit); budget.addEventListener('change', commit);
        menus = createPromptAgentModelMenus({ documentRef, selects: [select], parent: compact ? `${prefix}-popover` : null });
        position();
    };
    host.addEventListener('toggle', () => {
        if (host.open) {
            refresh();
            if (compact) { content.classList.add('prompt-agent-thinking-menu'); documentRef.body.appendChild(content); position();
                surfaces?.openPopover(`${prefix}-popover`, { element: content, trigger: summary, close }); }
        } else close();
    });
    content.addEventListener('pointerdown', event => event.stopPropagation());
    documentRef.defaultView?.addEventListener('resize', position);

    host.addEventListener('pointerdown', event => event.stopPropagation());
    refresh();
    return { refresh, close, destroy: () => { close(); menus?.destroy(); documentRef.defaultView?.removeEventListener('resize', position); host.remove(); } };
}
export function mountThinkingModelSettings({ documentRef, parent, model, providers, changed }) {
    const host = documentRef.createElement('div'); host.className = 'thinking-model-settings'; parent.appendChild(host);
    const profileSelect = (provider) => {
        const label = documentRef.createElement('label'); label.textContent = provider ? `${provider.name || provider.id}：思考兼容方式` : '思考参数兼容方式';
        const select = documentRef.createElement('select'); select.setAttribute('aria-label', label.textContent);
        const choices = { ...(provider ? { inherit: '继承模型兼容方式' } : {}), auto: '自动识别官方模型', none: '不发送思考参数',
            ...Object.entries(THINKING_PROFILES).reduce((choices, [id, profile]) => {
                const supported = getThinkingCapability({ model: { ...model, thinking: { profile: id } }, provider: provider || {}, protocol: model.protocol, task: model.taskType }).supported;
                if (supported) choices[id] = profile.label;
                return choices;
            }, {}) };
        const value = provider ? model.thinking?.providers?.[provider.id] || 'inherit' : model.thinking?.profile || 'auto';
        if (!choices[value]) choices[value] = '原兼容方式已不可用';
        for (const [id, name] of Object.entries(choices)) { const option = documentRef.createElement('option'); option.value = id; option.textContent = name; select.appendChild(option); }
        select.value = value; label.appendChild(select); host.appendChild(label);
        select.addEventListener('change', () => { model.thinking ||= { profile: 'auto' }; if (provider) { model.thinking.providers ||= {}; if (select.value === 'inherit') delete model.thinking.providers[provider.id]; else model.thinking.providers[provider.id] = select.value; } else model.thinking.profile = select.value; changed(); });
    };
    profileSelect(); providers.forEach(profileSelect);
    const help = documentRef.createElement('small'); help.textContent = '兼容模板仅声明接口能力，不会让模型获得思考能力。中转接口请按其文档选择。'; host.appendChild(help);
    return createThinkingControl({ documentRef, parent: host, title: '默认思考设置', inherit: false,
        getOptions: () => ({ model, provider: providers[0] || {}, protocol: model.protocol, task: model.taskType }), getValue: () => model.thinking?.default,
        onChange: value => { model.thinking ||= { profile: 'auto' }; model.thinking.default = value; changed(); } });
}
