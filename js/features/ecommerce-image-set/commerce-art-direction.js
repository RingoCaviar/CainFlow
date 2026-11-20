import { normalizeVisualStyle, visualStyleText } from '../visual-style/visual-style.js';

export const COMMERCE_ART_DIRECTION_LIMIT = 2000;
export const DEFAULT_COMMERCE_ART_DIRECTION = '以商品固有颜色建立协调的主辅色，统一光影方向、材质表现与整体氛围；各图位按用途自由选择视角、构图及信息节奏。';

export function normalizeCommerceArtDirection(value) {
    return typeof value === 'string' ? value.trim().slice(0, COMMERCE_ART_DIRECTION_LIMIT) : '';
}

export function resolveCommerceImageSetStyle(settings, connectedStyle = null) {
    if (connectedStyle) return normalizeVisualStyle(connectedStyle);
    const description = normalizeCommerceArtDirection(settings?.artDirection) || normalizeCommerceArtDirection(settings?.plan?.artDirection);
    return description ? normalizeVisualStyle({ description }) : null;
}

export function commerceArtDirectionForPlan(settings, proposed, { rewriting = false } = {}) {
    return (settings?.visualStyle ? normalizeCommerceArtDirection(visualStyleText(settings.visualStyle)) : '')
        || normalizeCommerceArtDirection(settings?.artDirection)
        || (rewriting ? normalizeCommerceArtDirection(settings?.plan?.artDirection) : normalizeCommerceArtDirection(proposed))
        || DEFAULT_COMMERCE_ART_DIRECTION;
}

export function updateCommerceArtDirection(settings, value, { automatic = false } = {}) {
    const description = automatic ? '' : normalizeCommerceArtDirection(value);
    const requestAutomatic = automatic || !description;
    if (!requestAutomatic && normalizeCommerceArtDirection(settings.artDirection) === description) return false;
    if (requestAutomatic && !normalizeCommerceArtDirection(settings.artDirection) && !settings.visualStyle
        && (!settings.plan || (!settings.plan.artDirection && settings.plan.stale === true && settings.plan.confirmed === false))) return false;
    settings.artDirection = description;
    delete settings.visualStyle;
    if (settings.plan) {
        if (requestAutomatic) delete settings.plan.artDirection;
        settings.plan.confirmed = false;
        settings.plan.stale = true;
    }
    return true;
}
