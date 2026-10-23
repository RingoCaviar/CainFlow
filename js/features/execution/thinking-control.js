import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { getThinkingCapability, resolveThinking } from './thinking-config.js';
let sequence = 0;
// DOM-only shared control. Callers own persistence and undo; refresh never writes.
export function createThinkingControl({ documentRef, parent, getOptions, getValue, onChange, inherit = true, title = '思考设置', summaryLabel = title, compact = false, showThinking = true, renderExtra, getExtraSummary, onClose }) {
    const host = documentRef.createElement('details'); host.className = 'thinking-control';
    const summary = documentRef.createElement('summary'); summary.textContent = compact ? '思考' : title; summary.title = title; summary.setAttribute('aria-label', summaryLabel); host.appendChild(summary);
    if (compact) {
        host.classList.add('thinking-control-compact');
        summary.setAttribute('aria-haspopup', 'dialog');
        summary.setAttribute('aria-expanded', 'false');
        summary.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface-panel-strong)"/><circle cx="15" cy="17" r="3" fill="var(--surface-panel-strong)"/></svg>';
    }
    const content = documentRef.createElement('div'); content.className = 'thinking-control-content'; host.appendChild(content); parent.appendChild(host);
    const prefix = `thinking-${++sequence}`;
    let signature = '', pendingBudget = false;
    const surfaces = getSurfaceCoordinator(documentRef);
    const popoverId = `${prefix}-popover`;
    const close = () => {
        surfaces?.forgetPopover(popoverId);
        onClose?.();
        host.open = false;
        if (content.parentNode === documentRef.body) host.appendChild(content);
        content.classList.remove('prompt-agent-thinking-menu');
        content.removeAttribute('style');
        summary.setAttribute('aria-expanded', 'false');
    };
    const position = () => {
        if (!compact || !host.open || content.parentNode !== documentRef.body) return;
        const rect = summary.getBoundingClientRect(), view = documentRef.defaultView;
        const margin = 8, gap = 6, width = Math.min(272, view.innerWidth - margin * 2);
        const maxHeight = Math.min(360, view.innerHeight - margin * 2);
        content.style.width = `${width}px`;
        content.style.maxHeight = `${maxHeight}px`;
        const desiredHeight = Math.min(content.scrollHeight, maxHeight);
        const above = Math.max(0, rect.top - margin - gap);
        const below = Math.max(0, view.innerHeight - rect.bottom - margin - gap);
        const placeAbove = above >= desiredHeight || above >= below;
        const available = placeAbove ? above : below;
        const height = Math.max(1, Math.min(maxHeight, available));
        content.style.maxHeight = `${height}px`;
        content.style.left = `${Math.max(margin, Math.min(rect.left, view.innerWidth - width - margin))}px`;
        content.style.top = `${placeAbove ? Math.max(margin, rect.top - Math.min(desiredHeight, height) - gap) : rect.bottom + gap}px`;
    };
    const displayValue = setting => {
        if (!setting || setting.mode === 'default') return '接口默认';
        if (setting.mode === 'level') {
            const names = { minimal: '轻量', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', none: '关闭' };
            return `${setting.value} · ${names[String(setting.value).toLowerCase()] || setting.value}`;
        }
        if (setting.mode === 'budget') return `${setting.value} Token`;
        return ({ inherit: '继承上级', off: '关闭思考', on: '开启默认强度', dynamic: '动态预算' })[setting.mode] || setting.mode;
    };
    const selectionFor = (value) => !value || value.mode === 'inherit' ? (inherit ? 'inherit' : 'default')
        : value.mode === 'level' ? `level:${value.value}` : value.mode;
    const renderCompact = (options, value, capability, selected) => {
        const common = [];
        const advanced = [];
        if (inherit) common.push(['inherit', '跟随模型设置']);
        common.push(['default', '接口默认（不传思考参数）']);
        if (capability.supported) {
            for (const level of capability.levels || []) common.push([`level:${level}`, displayValue({ mode: 'level', value: level })]);
            if (capability.off) advanced.push(['off', '关闭思考']);
            if (capability.on) advanced.push(['on', '开启默认强度']);
            if (capability.dynamic) advanced.push(['dynamic', '动态 Token 预算']);
            if (capability.max) advanced.push(['budget', `指定 Token 预算（${capability.min}–${capability.max}）`]);
        }
        if (![...common, ...advanced].some(([key]) => key === selected)) advanced.push([selected, '此设置已不可用']);

        const status = documentRef.createElement('small');
        status.className = 'thinking-control-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const error = message => { status.textContent = message; status.classList.add('is-error'); };
        const apply = nextValue => {
            try {
                resolveThinking(options, nextValue); onChange(nextValue); pendingBudget = false; signature = ''; refresh();
                if (compact && host.open) content.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
            } catch (cause) { error(cause.message); }
        };
        const makeGroup = (label, entries) => {
            const section = documentRef.createElement('section'); section.className = 'thinking-control-group';
            const heading = documentRef.createElement('strong'); heading.textContent = label; section.appendChild(heading);
            const group = documentRef.createElement('div'); group.className = 'thinking-control-choices';
            group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', label);
            for (const [key, text] of entries) {
                const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'thinking-choice';
                button.textContent = text; button.dataset.thinkingValue = key; button.setAttribute('role', 'radio');
                button.setAttribute('aria-checked', String(key === selected));
                button.tabIndex = key === selected ? 0 : -1;
                if (text === '此设置已不可用') button.disabled = true;
                button.addEventListener('click', () => {
                    if (key === 'budget') { pendingBudget = true; signature = ''; refresh(); content.querySelector('.thinking-budget-row input')?.focus(); return; }
                    apply(key === 'inherit' ? undefined : key.startsWith('level:')
                        ? { mode: 'level', value: key.slice(6) } : { mode: key });
                });
                group.appendChild(button);
            }
            section.appendChild(group); return section;
        };

        content.appendChild(makeGroup('思考程度', common));
        if (advanced.length) {
            const details = documentRef.createElement('details'); details.className = 'thinking-control-advanced';
            const heading = documentRef.createElement('summary'); heading.textContent = '更多选项'; details.appendChild(heading);
            const section = makeGroup('', advanced); section.classList.add('thinking-control-advanced-group');
            section.querySelector('strong').remove();
            section.querySelector('[role="radiogroup"]').setAttribute('aria-label', '更多思考程度选项');
            details.appendChild(section);
            if (advanced.some(([key]) => key === 'budget') && (selected === 'budget' || pendingBudget)) {
                const row = documentRef.createElement('div'); row.className = 'thinking-budget-row';
                const budget = documentRef.createElement('input'); budget.type = 'number'; budget.step = '1'; budget.min = capability.min; budget.max = capability.max;
                budget.value = selected === 'budget' ? value?.value ?? '' : ''; budget.placeholder = `${capability.min}–${capability.max}`;
                budget.setAttribute('aria-label', `${title} Token 预算`); row.appendChild(budget);
                const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'thinking-budget-apply'; button.textContent = '应用';
                button.addEventListener('click', () => {
                    if (!budget.value.trim()) { error('请输入 Token 预算'); budget.focus(); return; }
                    apply({ mode: 'budget', value: Number(budget.value) });
                });
                row.appendChild(button); details.appendChild(row);
                const range = documentRef.createElement('small'); range.className = 'thinking-budget-range'; range.textContent = `可设置 ${capability.min}–${capability.max} Token`; details.appendChild(range);
                if (selected === 'budget' || pendingBudget || advanced.some(([key]) => key === selected)) details.open = true;
            }
            content.appendChild(details);
        }
        let resolved;
        try { resolved = resolveThinking(options, value); } catch (cause) { error(cause.message); }
        status.classList.add('prompt-agent-settings-footer');
        content.appendChild(status);
    };

    const refresh = () => {
        const options = getOptions(), value = getValue(), capability = getThinkingCapability(options);
        const next = JSON.stringify([options.model?.id, options.model?.thinking, options.provider?.id, options.protocol, options.task, showThinking ? value : null, showThinking ? capability : null, pendingBudget]);
        const selected = selectionFor(value);
        let effective;
        try { effective = resolveThinking(options, value).setting; } catch { effective = value; }
        const label = displayValue(effective);
        const source = value?.mode && value.mode !== 'inherit' ? '本用途设置' : options.model?.thinking?.default ? '模型默认' : '接口默认';
        const extraSummary = getExtraSummary?.() || '';
        summary.title = showThinking ? `${title} · ${label}（${source}）${extraSummary ? ` · ${extraSummary}` : ''}`
            : `${summaryLabel}${extraSummary ? ` · ${extraSummary}` : ''}`;
        summary.setAttribute('aria-label', showThinking ? `${summaryLabel} · ${label}${extraSummary ? ` · ${extraSummary}` : ''}` : summary.title);
        if (next === signature) return;
        signature = next; content.replaceChildren();
        if (compact) {
            if (showThinking) renderCompact(options, value, capability, selected);
            renderExtra?.(content, popoverId); position(); return;
        }
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
        const nativeSelected = selectionFor(value);
        if (![...select.options].some(option => option.value === nativeSelected)) add(nativeSelected, '原思考设置不可用，请重新选择');
        select.value = nativeSelected; content.appendChild(select);
        const budget = documentRef.createElement('input'); budget.type = 'number'; budget.step = '1'; budget.min = capability.min ?? 1; budget.max = capability.max ?? ''; budget.value = value?.mode === 'budget' ? value.value : ''; budget.placeholder = '输入 Token 数'; budget.setAttribute('aria-label', `${title} Token 预算`); budget.hidden = nativeSelected !== 'budget'; content.appendChild(budget);
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
    };
    host.addEventListener('toggle', () => {
        if (host.open) {
            refresh();
            if (compact) {
                content.classList.add('prompt-agent-thinking-menu'); content.setAttribute('role', 'dialog'); content.setAttribute('aria-label', title); documentRef.body.appendChild(content); position();
                summary.setAttribute('aria-expanded', 'true');
                surfaces?.openPopover(popoverId, { element: content, trigger: summary, owner: documentRef.getElementById('prompt-agent-panel'), close });
                (content.querySelector('[aria-checked="true"]') || content.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))?.focus({ preventScroll: true });
            }
        } else close();
    });
    content.addEventListener('pointerdown', event => event.stopPropagation());
    content.addEventListener('toggle', position, true);
    content.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const current = event.target.closest?.('[role="radio"]'); if (!current) return;
        const group = current.closest('[role="radiogroup"]');
        const choices = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
        const index = choices.indexOf(current);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        event.preventDefault(); choices[next]?.click(); choices[next]?.focus();
    });
    const focusOutside = event => {
        if (compact && host.open && !content.contains(event.target) && !summary.contains(event.target)
            && !event.target.closest?.(`[data-agent-popover-parent="${popoverId}"]`)) close();
    };
    documentRef.addEventListener('focusin', focusOutside);
    documentRef.defaultView?.addEventListener('resize', position);
    documentRef.defaultView?.addEventListener('scroll', position, true);

    host.addEventListener('pointerdown', event => event.stopPropagation());
    refresh();
    return { refresh, close, open: () => { host.open = true; }, position,
        destroy: () => { close(); documentRef.removeEventListener('focusin', focusOutside); documentRef.defaultView?.removeEventListener('resize', position); documentRef.defaultView?.removeEventListener('scroll', position, true); host.remove(); } };
}
