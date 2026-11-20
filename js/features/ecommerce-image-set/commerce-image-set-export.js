import {
    getCommerceImageSetPreset, getCommerceProductInfo, getSelectedCommerceImageSetShots,
    isCommerceShotImageStale, normalizeCommerceImageSetCopyLanguage
} from './commerce-image-set-plan.js';
import { getCommerceOutputAssetKey } from './commerce-detail-page.js';

const assetKeyPattern = /^media:[a-zA-Z0-9_-]+$/;
const isMediaAssetKey = key => typeof key === 'string' && assetKeyPattern.test(key);
const reservedFilename = /^(?:CON|PRN|AUX|NUL|COM[¹²³1-9]|LPT[¹²³1-9])(?:\.|$)/i;

function safeFilenamePart(value, fallback) {
    const cleaned = value.normalize('NFC')
        .replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')
        .replace(/^[.\s]+/, '');
    const bounded = [...cleaned].slice(0, 48).join('').replace(/[.\s]+$/, '');
    if (!bounded) return fallback;
    return reservedFilename.test(bounded) ? `_${bounded}` : bounded;
}

export function hasCommerceImageSetExportMedia(mediaAssetKeys) {
    return Array.isArray(mediaAssetKeys) && mediaAssetKeys.some(isMediaAssetKey);
}

export function projectCommerceImageSetExport({ settings, mediaAssetKeys, scope = 'all', version = 'current',
    referenceRevision = settings?.plan?.referenceRevision, referenceChanged = false, styleChanged = false }) {
    const platformId = (getCommerceImageSetPreset(settings?.platformId) || getCommerceImageSetPreset('taobao')).id;
    const plan = settings?.plan;
    const currentPlatform = !plan?.platformId || plan.platformId === platformId;
    const changed = referenceChanged || (!!referenceRevision && !!plan?.referenceRevision && plan.referenceRevision !== referenceRevision);
    const owned = new Set((Array.isArray(mediaAssetKeys) ? mediaAssetKeys : []).filter(isMediaAssetKey));
    const results = new Map((Array.isArray(settings?.results) ? settings.results : [])
        .filter(row => row?.status === 'completed' && owned.has(getCommerceOutputAssetKey(row)))
        .map(row => [row.shotId, row]));
    const previous = (Array.isArray(settings?.previousExportResults) ? settings.previousExportResults : [])
        .filter(row => isMediaAssetKey(row?.outputKey) && (row.retained === true || owned.has(row.outputKey)));
    const matchesReferences = row => {
        if (changed) return false;
        if (plan?.referenceContentKey && row.referenceContentKey) return row.referenceContentKey === plan.referenceContentKey;
        if (referenceRevision && row.referenceRevision) return row.referenceRevision === referenceRevision;
        return (!referenceRevision && !plan?.referenceContentKey) || owned.has(row.outputKey);
    };
    const compatiblePrevious = previous.filter(matchesReferences);
    const shots = getSelectedCommerceImageSetShots(settings);
    const selectedById = new Map(shots.map(shot => [shot.id, shot]));
    const matchesAspect = row => {
        const shot = selectedById.get(row.shotId);
        return !shot || !row.aspect || shot.source === 'reference' || row.aspect === shot.aspect;
    };
    const previousShots = new Map(compatiblePrevious.filter(row => row.platformId === platformId && matchesAspect(row))
        .map(row => [row.shotId, row]));
    const planShots = new Map((Array.isArray(plan?.shots) ? plan.shots : []).map(shot => [shot.id, shot]));
    const currentPlan = !changed && !styleChanged && currentPlatform && !!plan?.sourceKey && !plan.stale
        && normalizeCommerceImageSetCopyLanguage(plan.copyLanguage) === normalizeCommerceImageSetCopyLanguage(settings?.copyLanguage);
    const associated = new Set([...results.values()].map(getCommerceOutputAssetKey));
    previous.forEach(row => associated.add(row.outputKey));
    const title = version === 'previous' ? '上次套图' : safeFilenamePart(getCommerceProductInfo(settings).name, '电商套图');
    const historical = changed ? (plan?.shots || []).flatMap(({ id, label, group }, order) => {
        const result = results.get(id);
        return result ? [{ platformId: plan.platformId, shotId: id, label, group, order, outputKey: getCommerceOutputAssetKey(result) }] : [];
    }) : [];
    const differentReferences = previous.filter(row => !matchesReferences(row));
    const lastSet = historical.length ? historical : differentReferences.length ? differentReferences
        : previous.some(row => !matchesAspect(row)) ? previous : [];
    const detailOrder = plan?.detailPage?.sections || [];
    const detailIds = new Set(detailOrder.map(section => section.shotId));
    const selected = version === 'current' ? [...shots.filter(shot => !detailIds.has(shot.id)),
        ...detailOrder.flatMap(({ shotId }) => selectedById.has(shotId) ? [selectedById.get(shotId)] : [])] : [];

    // Without a current selection, retain the last saved set's recorded order and names.
    const fallback = version === 'previous' ? lastSet : compatiblePrevious;
    const previousPlatform = fallback[0]?.platformId;
    const slots = selected.length ? selected : fallback.filter(row => row.platformId === previousPlatform)
        .sort((first, second) => first.group === second.group ? first.order - second.order : first.group === 'gallery' ? -1 : 1)
        .map(row => ({ id: row.shotId, label: row.label, group: row.group, priorKey: row.outputKey }));
    const rows = slots.flatMap(({ id, label, group, aspect, priorKey }, index) => {
        if (scope !== 'all' && group !== scope) return [];
        const shot = planShots.get(id);
        const result = !changed && currentPlatform ? results.get(id) : null;
        const assetKey = priorKey || getCommerceOutputAssetKey(result) || previousShots.get(id)?.outputKey || null;
        const current = !priorKey && result && !result.previousVersion && currentPlan && shot?.aspect === aspect
            && (shot.source === 'reference' || (!!result.planKey && !isCommerceShotImageStale(shot, result)));
        const number = index + 1;
        return [{ shotId: id, label, group, number, fileStem: `${String(number).padStart(2, '0')}_${safeFilenamePart(label, '图位')}`,
            assetKey, status: !assetKey ? 'missing' : current ? 'current' : 'previous' }];
    });
    return { title, rows, unmappedCount: [...owned].filter(key => !associated.has(key)).length };
}
