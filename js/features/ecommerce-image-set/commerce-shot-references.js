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

export function updateCommerceShotReferences(settings, shotId, assetKeys) {
    const selectedIds = settings?.selectedShotIds || settings?.plan?.shots.map(shot => shot.id) || [];
    if (!selectedIds.includes(shotId)) return false;
    const next = referenceKeys(assetKeys);
    const previous = referenceKeys(settings.shotReferences?.[shotId]);
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    const references = { ...settings.shotReferences };
    if (next.length) references[shotId] = next;
    else delete references[shotId];
    settings.shotReferences = references;
    if (settings.plan) {
        settings.plan.confirmed = false;
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
        throw new Error('设计参考图原图不可用，请重新上传或移除此图位的参考图。');
    }
    return image;
}

export async function readCommerceShotReferences(settings, shotId, readAsset, signal) {
    const keys = referenceKeys(settings?.shotReferences?.[shotId]);
    return Promise.all(keys.map(key => readReference(key, readAsset, signal)));
}

export function buildCommerceShotReferenceInstructions(productCount, designCount) {
    if (!designCount) return '';
    return [
        `第 1 至 ${productCount} 张是商品原图，是商品身份、结构、固有颜色、包装、商标和销售数量的依据。`,
        `第 ${productCount + 1} 至 ${productCount + designCount} 张是本图位的设计参考，仅借鉴构图关系、配色、光影和图文节奏。`,
        '不复制设计参考中的商品、文字、商标、价格、认证或功效。当前商品资料、图位用途、已确认文案与整套美术风格优先，白底主图仍遵守其背景和无叠字规则。'
    ].join('\n');
}

export async function buildCommercePlanningReferenceInput(settings, shots, productReferences, readAsset, signal) {
    const references = [...productReferences];
    const indexes = new Map();
    const shotReferenceMap = {};
    for (const shot of shots) {
        const keys = referenceKeys(settings?.shotReferences?.[shot.id]);
        if (!keys.length) continue;
        shotReferenceMap[shot.id] = [];
        for (const key of keys) {
            if (!indexes.has(key)) {
                references.push(await readReference(key, readAsset, signal));
                indexes.set(key, references.length);
            }
            shotReferenceMap[shot.id].push(indexes.get(key));
        }
    }
    return { references, shotReferenceMap };
}
