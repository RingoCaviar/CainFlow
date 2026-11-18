import { projectImageReferences } from '../../nodes/image-reference-projection.js';

export const COMMERCE_SHOT_REFERENCE_LIMIT = 3;
const assetKeyPattern = /^media:[a-zA-Z0-9_-]+$/;

function referenceKeys(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(key => typeof key === 'string' && assetKeyPattern.test(key)))]
        .slice(0, COMMERCE_SHOT_REFERENCE_LIMIT);
}

export function normalizeCommerceShotReferences(raw, allowedShotIds = Object.keys(raw || {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(allowedShotIds.flatMap(id => {
        const keys = referenceKeys(raw[id]);
        return keys.length ? [[id, keys]] : [];
    }));
}

export function getCommerceShotReferenceAssetKeys(settings) {
    return [...new Set(Object.values(normalizeCommerceShotReferences(settings?.shotReferences)).flat())];
}

export function projectCommerceStyleReferences(state, nodeId, connections = state.connections) {
    const projection = projectImageReferences({ state, targetId: nodeId, connections, portName: 'styleReferenceImages' });
    for (const slot of projection.slots) {
        const { nodeId, port } = slot.connection.from;
        slot.bindingId = `source:${encodeURIComponent(nodeId)}:${encodeURIComponent(port)}:${slot.index}`;
    }
    return projection;
}

export function changeFingerprint(value) {
    let a = 2166136261, b = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        a = Math.imul(a ^ code, 16777619);
        b = Math.imul(b ^ code, 31) + index;
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${value.length}`;
}

export function commerceConnectedStyleRevision(settings, { slots }) {
    if (!slots.length) return '';
    return changeFingerprint(JSON.stringify(slots.map(slot =>
        [slot.assetKey || changeFingerprint(slot.image || ''), settings?.styleReferenceTypes?.[slot.bindingId] || ''])));
}

export function commerceShotConnectedStyleRevision(settings, slots, shotId) {
    return commerceConnectedStyleRevision(settings, { slots: slots.filter(slot => {
        const type = settings?.styleReferenceTypes?.[slot.bindingId];
        return !type || type === shotId;
    }) });
}

export function hasCommerceStyleReferenceChange(settings, projection) {
    return !!settings?.plan && (settings.plan.connectedStyleRevision || '') !== commerceConnectedStyleRevision(settings, projection);
}

export function normalizeCommerceStyleReferenceTypes(raw, shotIds) {
    return Object.fromEntries(Object.entries(raw || {}).filter(([bindingId, shotId]) =>
        /^source:[^:]+:[^:]+:\d+$/.test(bindingId) && shotIds.includes(shotId)));
}

export function remapCopiedCommerceStyleReferenceTypes(types, nodeIds) {
    const sources = new Map(Array.from(nodeIds, ([from, to]) => [encodeURIComponent(from), encodeURIComponent(to)]));
    return Object.fromEntries(Object.entries(types).map(([bindingId, shotId]) => {
        const parts = bindingId.split(':');
        if (parts[0] === 'source' && sources.has(parts[1])) parts[1] = sources.get(parts[1]);
        return [parts.join(':'), shotId];
    }));
}

export function setCommerceConnectedReferenceType(settings, bindingId, shotId, allowedShotIds = settings.selectedShotIds || []) {
    if (!/^source:[^:]+:[^:]+:\d+$/.test(bindingId)
        || shotId && !allowedShotIds.includes(shotId)
        || (settings.styleReferenceTypes?.[bindingId] || '') === shotId) return false;
    const types = { ...settings.styleReferenceTypes };
    if (shotId) types[bindingId] = shotId;
    else delete types[bindingId];
    settings.styleReferenceTypes = types;
    if (settings.plan) settings.plan.confirmed = false;
    return true;
}

export function updateCommerceShotReferences(settings, shotId, assetKeys,
    allowedShotIds = settings?.selectedShotIds || settings?.plan?.shots.map(shot => shot.id) || []) {
    if (shotId !== '*' && !allowedShotIds.includes(shotId)) return false;
    const next = referenceKeys(assetKeys);
    const previous = referenceKeys(settings.shotReferences?.[shotId]);
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    const references = { ...settings.shotReferences };
    if (next.length) references[shotId] = next;
    else delete references[shotId];
    settings.shotReferences = references;
    if (settings.plan) {
        settings.plan.confirmed = false;
        if (shotId === '*') {
            for (const shot of settings.plan.shots) {
                if (next.length) shot.sharedReferenceAssetKeys = [...next];
                else delete shot.sharedReferenceAssetKeys;
                if (shot.customScene && shot.prompt) {
                    shot.sceneConfirmed = false;
                    shot.sceneNeedsReview = true;
                }
            }
        }
        const shot = settings.plan.shots.find(shot => shot.id === shotId);
        if (shot) {
            if (next.length) shot.referenceAssetKeys = next;
            else delete shot.referenceAssetKeys;
            if (shot.customScene && shot.prompt) {
                shot.sceneConfirmed = false;
                shot.sceneNeedsReview = true;
            }
        }
    }
    return true;
}

async function readReference(key, readAsset, signal) {
    signal?.throwIfAborted();
    const image = await readAsset?.(key);
    signal?.throwIfAborted();
    if (typeof image !== 'string' || !/^data:image\/[^;,]+;base64,/i.test(image)) {
        throw new Error('设计参考图原图不可用，请重新选择或移除此图位的参考图。');
    }
    return image;
}

export function getCommerceShotStyleReferences(settings, shotId, connected = []) {
    const items = new Map();
    for (const key of [...referenceKeys(settings?.shotReferences?.['*']), ...referenceKeys(settings?.shotReferences?.[shotId])]) {
        items.set(key, { assetKey: key });
    }
    for (const slot of connected) {
        const type = settings?.styleReferenceTypes?.[slot.bindingId];
        if (!type || type === shotId) items.set(slot.assetKey || slot.bindingId, slot);
    }
    return [...items.values()];
}

function readStyleSlot(slot, readAsset, signal) {
    signal?.throwIfAborted();
    if (slot.readImage) return slot.readImage(signal);
    if (slot.image) return slot.image;
    return readReference(slot.assetKey, readAsset, signal);
}

export async function readCommerceShotReferences(settings, shotId, readAsset, signal, connected) {
    return Promise.all(getCommerceShotStyleReferences(settings, shotId, connected).map(slot => readStyleSlot(slot, readAsset, signal)));
}

export function buildCommerceShotReferenceInstructions(productCount, designCount) {
    if (!designCount) return '';
    return [
        `第 1 至 ${productCount} 张是商品原图，是商品身份、结构、固有颜色、包装、商标和销售数量的依据。`,
        `第 ${productCount + 1} 至 ${productCount + designCount} 张是本图位的设计参考，仅借鉴构图关系、配色、光影和图文节奏。`,
        '不复制设计参考中的商品、文字、商标、价格、认证或功效。当前商品资料、图位用途、已确认文案与整套美术风格优先，白底主图仍遵守其背景和无叠字规则。'
    ].join('\n');
}

export async function buildCommercePlanningReferenceInput(settings, shots, productReferences, readAsset, signal, connected) {
    const references = [...productReferences];
    const indexes = new Map();
    const shotReferenceMap = {};
    for (const shot of shots) {
        const slots = getCommerceShotStyleReferences(settings, shot.id, connected);
        if (!slots.length) continue;
        shotReferenceMap[shot.id] = [];
        for (const slot of slots) {
            const key = slot.assetKey || slot.bindingId;
            if (!indexes.has(key)) {
                references.push(await readStyleSlot(slot, readAsset, signal));
                indexes.set(key, references.length);
            }
            shotReferenceMap[shot.id].push(indexes.get(key));
        }
    }
    return { references, shotReferenceMap };
}
