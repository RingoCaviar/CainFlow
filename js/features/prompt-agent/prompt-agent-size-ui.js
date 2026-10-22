import { createPromptAgentModelMenus } from './prompt-agent-model-menu.js';
import { getSurfaceCoordinator } from '../ui/surface-coordinator.js';
import { getEffectiveProtocol } from '../execution/provider-request-utils.js';
import { resolveAgentSize, sizeCapabilities } from './prompt-agent-size.js';

export function createAgentSizeMenu({ documentRef, getModel, getProvider, getValue, onChange }) {
    const button = documentRef.getElementById('prompt-agent-size-button');
    if (!button || !documentRef.body) return { close() {}, render() {} };
    const surfaces = getSurfaceCoordinator(documentRef);
    const menu = documentRef.createElement('section');
    menu.id = 'prompt-agent-size-menu'; menu.className = 'prompt-agent-search-menu prompt-agent-size-menu';
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Agent 生图尺寸'); menu.hidden = true;
    documentRef.body.appendChild(menu);
    const make = (tag, text, parent = menu) => { const item = documentRef.createElement(tag); item.textContent = text; parent.appendChild(item); return item; };
    make('strong', '生图尺寸');
    const controls = {};
    for (const [key, title] of [['resolution', '分辨率'], ['aspectRatio', '比例']]) {
        const label = make('label', title); const select = make('select', '', label);
        select.id = `prompt-agent-size-${key}`; select.setAttribute('aria-label', title); controls[key] = select;
    }
    const dimensions = make('div', ''); dimensions.className = 'prompt-agent-size-dimensions';
    for (const [key, title] of [['customWidth', '宽度（px）'], ['customHeight', '高度（px）']]) {
        const label = make('label', title, dimensions), input = make('input', '', label);
        input.type = 'number'; input.min = '1'; input.step = '1'; input.setAttribute('aria-label', title); controls[key] = input;
    }
    const hint = make('p', ''); hint.setAttribute('role', 'status');
    const note = make('p', '面板作为默认尺寸；本轮明确要求优先，确认方案后执行。'); note.className = 'prompt-agent-size-note';
    const menus = createPromptAgentModelMenus({ documentRef, parent: 'agent-size', selects: [controls.resolution, controls.aspectRatio] });
    const close = () => { menus.close(); surfaces?.forgetPopover('agent-size'); menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    const position = () => {
        const rect = button.getBoundingClientRect(), view = documentRef.defaultView;
        menu.style.width = `${Math.min(280, view.innerWidth - 16)}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - menu.offsetWidth - 8))}px`;
        const above = Math.max(0, rect.top - 16), below = Math.max(0, view.innerHeight - rect.bottom - 16);
        const up = above >= Math.min(320, menu.scrollHeight) || above >= below;
        menu.style.maxHeight = `${up ? above : below}px`;
        menu.style.top = `${up ? Math.max(8, rect.top - menu.offsetHeight - 6) : rect.bottom + 6}px`;
    };
    const render = () => {
        const model = getModel(), value = getValue(model?.id) || {};
        const protocol = getEffectiveProtocol(model || {}, getProvider(model));
        const capabilities = sizeCapabilities(protocol);
        for (const [key, options] of [['resolution', capabilities.resolutions], ['aspectRatio', capabilities.aspects]]) {
            const select = controls[key]; select.replaceChildren();
            const values = [{ value: '__inherit__', label: '跟随方案' }, ...options];
            if (value[key] !== undefined && !values.some(item => item.value === String(value[key]))) values.push({ value: String(value[key]), label: `${value[key]}（当前不可用）`, disabled: true });
            for (const item of values) { const option = make('option', item.label, select); option.value = item.value; option.disabled = Boolean(item.disabled); }
            select.value = value[key] === undefined ? '__inherit__' : String(value[key]); select.disabled = !model;
        }
        const locked = capabilities.automaticLocksAspect && (value.resolution === '' || value.resolution === 'custom');
        controls.aspectRatio.disabled = !model || locked;
        dimensions.hidden = value.resolution !== 'custom';
        for (const key of ['customWidth', 'customHeight']) controls[key].value = value[key] ?? '';
        let message = !model ? '请先选择生图模型。' : locked ? value.resolution === 'custom' ? '比例由自定义宽高决定。' : '自动分辨率的比例由模型决定；指定比例前请选择分辨率档位。' : '';
        if (model && Object.keys(value).length) {
            try { resolveAgentSize({ protocol, parameters: value }); } catch (error) { message = error.message; }
        }
        hint.textContent = message;
        const summary = [value.resolution === undefined ? '' : value.resolution || '自动', value.aspectRatio || '', value.resolution === 'custom' ? `${value.customWidth || '—'}×${value.customHeight || '—'}` : ''].filter(Boolean).join(' · ');
        button.textContent = summary ? `尺寸 ${summary}` : '尺寸'; button.title = summary || '生图尺寸：跟随方案';
        menus.refresh(); if (!menu.hidden) position();
    };
    for (const [key, control] of Object.entries(controls)) control.addEventListener('change', () => {
        const model = getModel(); if (!model) return;
        const value = { ...getValue(model.id) };
        if (control.value === '__inherit__' || (control.type === 'number' && !control.value)) delete value[key];
        else value[key] = control.type === 'number' ? Number(control.value) : control.value;
        if (key === 'resolution' && value.resolution !== 'custom') { delete value.customWidth; delete value.customHeight; }
        onChange(model.id, value); render();
    });
    button.addEventListener('click', () => {
        if (!menu.hidden) { close(); return; }
        render(); menu.hidden = false; button.setAttribute('aria-expanded', 'true');
        surfaces?.openPopover('agent-size', { element: menu, trigger: button, owner: documentRef.getElementById('prompt-agent-panel'), close });
        position(); controls.resolution.nextElementSibling?.focus();
    });
    documentRef.addEventListener('pointerdown', event => {
        if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target) && !event.target.closest?.('[data-agent-popover-parent="agent-size"]')) close();
    });
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); button.focus(); } });
    menu.addEventListener('focusout', event => { if (event.relatedTarget && !menu.contains(event.relatedTarget) && !event.relatedTarget.closest?.('[data-agent-popover-parent="agent-size"]')) close(); });
    documentRef.defaultView?.addEventListener('resize', close);
    render(); return { close, render };
}
