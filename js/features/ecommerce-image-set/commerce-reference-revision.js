import { projectImageReferences } from '../../nodes/image-reference-projection.js';
import { REFERENCE_IMAGES_PORT } from '../../nodes/reference-image-ports.js';
import { commerceImageSetReferenceContentKey, commerceImageSetSourceKey } from './commerce-image-set-plan.js';

export const COMMERCE_REFERENCE_CHANGED_MESSAGE = '商品参考图已变更，请重新规划套图。';
const stableMediaKey = /^media:[\w-]{1,80}$/;

export function projectCommerceReferences(state, nodeId, connections = state.connections || []) {
    return projectImageReferences({ state, targetId: nodeId,
        connections: connections.filter(connection => connection.to?.port === REFERENCE_IMAGES_PORT) });
}

function referenceUrlIdentity(url) {
    let hash = 0x811c9dc5;
    let check = 5381;
    for (let index = 0; index < url.length; index++) {
        const code = url.charCodeAt(index);
        hash = Math.imul(hash ^ code, 0x01000193);
        check = Math.imul(check, 33) ^ code;
    }
    return `url:${url.length}:${(hash >>> 0).toString(36)}:${(check >>> 0).toString(36)}`;
}

function usableReferenceSlots(projection) {
    const slots = projection?.slots;
    if (!slots?.length || slots.length > 5 || projection.groups?.some(group =>
        group.enabled && (group.running || !group.count || group.missing)) || slots.some(slot => slot.missing)) return null;
    return slots;
}

/** Compare immutable asset identities in execution order without hydrating their pixels. */
export function getCommerceReferenceRevision(projection) {
    const slots = usableReferenceSlots(projection);
    if (!slots) return '';
    const identities = [];
    for (const slot of slots) {
        if (stableMediaKey.test(slot.assetKey)) identities.push(slot.assetKey);
        else if (/^https?:\/\//i.test(slot.image)) identities.push(referenceUrlIdentity(slot.image));
        else return '';
    }
    return `v1:${JSON.stringify(identities)}`;
}

export function sameCommerceReferenceProjection(previous, current) {
    const before = usableReferenceSlots(previous);
    const after = usableReferenceSlots(current);
    if (!before || !after || before.length !== after.length) return false;
    return before.every((slot, index) => {
        const next = after[index];
        if (slot.source?.id !== next.source?.id || slot.index !== next.index
            || slot.connection?.id !== next.connection?.id || slot.connection?.from?.port !== next.connection?.from?.port) return false;
        if (stableMediaKey.test(slot.assetKey) || stableMediaKey.test(next.assetKey)) return slot.assetKey === next.assetKey;
        return !!slot.image && slot.image === next.image;
    });
}

function savedCommerceReferenceRevision(settings) {
    if (settings?.plan) return settings.plan.referenceRevision || '';
    const rows = settings?.previousExportResults;
    const revision = rows?.[0]?.referenceRevision;
    return revision && rows.every(row => row?.referenceRevision === revision) ? revision : '';
}

export function hasCommerceReferenceChange(settings, projection) {
    const previousRevision = savedCommerceReferenceRevision(settings);
    const groups = projection?.groups;
    if (!Array.isArray(groups)) return false;
    const enabled = groups.filter(group => group.enabled);
    if (!enabled.length) {
        return !!previousRevision || (!!settings?.plan?.sourceKey && !settings.plan.referenceContentKey);
    }
    if (!previousRevision) return false;
    const currentRevision = getCommerceReferenceRevision(projection);
    if (currentRevision) return previousRevision !== currentRevision;
    // A changed number of positions is definitive only once all enabled sources have a settled batch shape.
    if (enabled.some(group => group.running || !group.count) || !previousRevision.startsWith('v1:')) return false;
    try {
        const previous = JSON.parse(previousRevision.slice(3));
        return Array.isArray(previous) && previous.length !== enabled.reduce((count, group) => count + group.count, 0);
    } catch {
        return false;
    }
}

export function needsCommerceReferenceVerification(settings, projection) {
    const previousRevision = savedCommerceReferenceRevision(settings);
    return Boolean((settings?.plan?.sourceKey || previousRevision) && projection?.groups?.some(group => group.enabled)
        && (!previousRevision || !getCommerceReferenceRevision(projection)));
}

export function hasCommerceNodeReferenceChange(state, node) {
    return node?.type === 'ECommerceImageSet' && node.enabled !== false
        && hasCommerceReferenceChange(node.data?.commerceImageSet ?? node.commerceImageSet, projectCommerceReferences(state, node.id));
}

const isLocalReferenceImage = value => /^data:image\/[^;,]+;base64,/i.test(value);

/** Backfill legacy provenance only when the currently available originals match the saved plan. */
export async function verifyCommerceReferenceContent({ settings, projection, readAsset }) {
    const plan = settings?.plan;
    const slots = usableReferenceSlots(projection);
    if (!slots || !plan?.sourceKey || (!plan.referenceContentKey && plan.stale)
        || slots.some(slot => /^https?:\/\//i.test(slot.image))) return { status: 'unknown' };
    try {
        const references = await Promise.all(slots.map(slot => isLocalReferenceImage(slot.image) ? slot.image
            : !slot.image && slot.assetKey ? readAsset?.(slot.assetKey) : ''));
        if (!references.every(isLocalReferenceImage)) return { status: 'unknown' };
        const referenceContentKey = await commerceImageSetReferenceContentKey(references);
        const matched = plan.referenceContentKey ? plan.referenceContentKey === referenceContentKey
            : plan.sourceKey === await commerceImageSetSourceKey({ settings, references });
        return matched ? { status: 'matched', referenceContentKey, referenceRevision: getCommerceReferenceRevision(projection) }
            : { status: 'stale' };
    } catch {
        return { status: 'unknown' };
    }
}
