import {
    getCommerceImageSetPreset, getCommerceProductInfo, getSelectedCommerceImageSetShots,
    isCommerceShotImageStale, normalizeCommerceImageSetCopyLanguage
} from './commerce-image-set-plan.js';

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

export function projectCommerceImageSetExport({ settings, mediaAssetKeys, scope = 'all' }) {
    const platformId = (getCommerceImageSetPreset(settings?.platformId) || getCommerceImageSetPreset('taobao')).id;
    const plan = settings?.plan;
    const currentPlatform = !plan?.platformId || plan.platformId === platformId;
    const owned = new Set((Array.isArray(mediaAssetKeys) ? mediaAssetKeys : []).filter(isMediaAssetKey));
    const results = new Map((currentPlatform && Array.isArray(settings?.results) ? settings.results : [])
        .filter(row => row?.status === 'completed' && owned.has(row.assetKey))
        .map(row => [row.shotId, row]));
    const previous = (Array.isArray(settings?.previousExportResults) ? settings.previousExportResults : [])
        .filter(row => owned.has(row?.outputKey));
    const previousShots = new Map(previous.filter(row => row.platformId === platformId).map(row => [row.shotId, row]));
    const planShots = new Map((Array.isArray(plan?.shots) ? plan.shots : []).map(shot => [shot.id, shot]));
    const currentPlan = currentPlatform && !!plan?.sourceKey && !plan.stale
        && normalizeCommerceImageSetCopyLanguage(plan.copyLanguage) === normalizeCommerceImageSetCopyLanguage(settings?.copyLanguage);
    const associated = new Set([...results.values()].map(row => row.assetKey));
    previous.forEach(row => associated.add(row.outputKey));
    const title = safeFilenamePart(getCommerceProductInfo(settings).name, '电商套图');
    const selected = getSelectedCommerceImageSetShots(settings);

    // Without a current selection, retain the last saved set's recorded order and names.
    const previousPlatform = previous[0]?.platformId;
    const slots = selected.length ? selected : previous.filter(row => row.platformId === previousPlatform)
        .sort((first, second) => first.group === second.group ? first.order - second.order : first.group === 'gallery' ? -1 : 1)
        .map(row => ({ id: row.shotId, label: row.label, group: row.group, priorKey: row.outputKey }));
    const rows = slots.flatMap(({ id, label, group, aspect, priorKey }, index) => {
        if (scope !== 'all' && group !== scope) return [];
        const shot = planShots.get(id);
        const result = results.get(id);
        const assetKey = priorKey || result?.assetKey || previousShots.get(id)?.outputKey || null;
        const current = !priorKey && result && currentPlan && shot?.aspect === aspect
            && (shot.source === 'reference' || (!!result.planKey && !isCommerceShotImageStale(shot, result)));
        const number = index + 1;
        return [{ shotId: id, label, group, number, fileStem: `${String(number).padStart(2, '0')}_${safeFilenamePart(label, '图位')}`,
            assetKey, status: !assetKey ? 'missing' : current ? 'current' : 'previous' }];
    });
    return { title, rows, unmappedCount: [...owned].filter(key => !associated.has(key)).length };
}
