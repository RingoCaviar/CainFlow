/**
 * Read the effective image-generation settings from the current editor, or the
 * node's existing state when its parameter controls are not mounted.
 */
export function readImageGenerationSettings(node, documentRef) {
    const id = node?.id || '';
    const data = node?.data || {};
    const control = suffix => documentRef?.getElementById?.(`${id}-${suffix}`);
    const value = (suffix, fallback) => control(suffix)?.value ?? fallback;
    const search = control('search');
    const advanced = control('advanced-parameters');
    const protocolParams = { ...(data.protocolParams || {}) };

    const protocolControls = documentRef?.querySelectorAll?.(
        `#${id}-protocol-params [id^="${id}-param-"]`
    ) || [];
    for (const element of protocolControls) {
        const paramId = element.id.slice(`${id}-param-`.length);
        if (!paramId || paramId.endsWith('-custom')) continue;
        if (element.type === 'checkbox') {
            protocolParams[paramId] = element.checked === true;
        } else if (element.tagName === 'SELECT' && element.value === 'custom') {
            protocolParams[paramId] = control(`param-${paramId}-custom`)?.value ?? '';
        } else {
            protocolParams[paramId] = element.value;
        }
    }

    return {
        apiConfigId: value('apiconfig', node?.apiConfigId ?? data.apiConfigId ?? 'default'),
        providerId: value('provider', node?.providerId ?? data.providerId ?? ''),
        prompt: value('prompt', data.prompt ?? ''),
        aspect: value('aspect', data.aspect ?? ''),
        resolution: value('resolution', data.resolution ?? ''),
        customWidth: value('custom-resolution-width', data.customWidth ?? ''),
        customHeight: value('custom-resolution-height', data.customHeight ?? ''),
        quality: value('quality', data.quality ?? 'auto'),
        moderation: value('moderation', data.moderation ?? 'auto'),
        background: value('background', data.background ?? 'auto'),
        search: search ? search.checked === true : data.search === true,
        generationCount: Math.max(1, parseInt(value('generation-count', data.generationCount ?? '1'), 10) || 1),
        advancedExpanded: advanced ? advanced.open === true : data.advancedExpanded === true,
        protocolParams
    };
}
