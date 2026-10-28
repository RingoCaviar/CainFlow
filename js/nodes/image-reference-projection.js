import { getCanonicalImageList } from '../features/execution/execution-data-utils.js';
import { projectImageOutput } from './image-output-projection.js';

const isReferencePort = port => port === 'image' || port === 'referenceImages' || /^image_\d+$/.test(port || '');

function orderRank(connection, index, video = false) {
    if (connection.to.port === 'image') return 0;
    const legacy = String(connection.to.port).match(/^image_(\d+)$/);
    if (legacy) return Number(legacy[1]);
    const explicit = Number(connection.order);
    const rank = connection.order !== undefined && connection.order !== null && Number.isFinite(explicit) ? explicit : index;
    return video ? 100 + rank : rank;
}

/** Shared semantic source order, independent of DOM order or legacy socket presentation. */
export function orderImageReferenceConnections(connections, nodeType = 'ImageGenerate') {
    const video = nodeType === 'VideoGenerate';
    return connections.filter(connection => isReferencePort(connection?.to?.port))
        .map((connection, index) => ({ connection, index, rank: orderRank(connection, index, video), canonical: !video && connection.to.port === 'referenceImages' ? 1 : 0 }))
        .sort((left, right) => left.canonical - right.canonical || left.rank - right.rank || left.index - right.index)
        .map(({ connection }) => connection);
}

/** A cheap view of reference identities and durable positions, with no media I/O. */
export function projectImageReferences({ state, targetId, connections = state?.connections || [], getOutput = source => getCanonicalImageList(source) }) {
    const video = state.nodes?.get(targetId)?.type === 'VideoGenerate';
    const groups = orderImageReferenceConnections(connections.filter(connection => connection?.to?.nodeId === targetId), video ? 'VideoGenerate' : 'ImageGenerate')
        .map(connection => {
            const source = state.nodes?.get(connection.from?.nodeId);
            const output = projectImageOutput(source, source ? getOutput(source, connection.from?.port) : []);
            // Video frame roles still consume their primary image; only its
            // canonical reference array expands complete source batches.
            const count = video && connection.to.port !== 'referenceImages' ? Math.min(1, output.count) : output.count;
            return {
                connection, source, images: output.images.slice(0, count), assets: output.assets.slice(0, count), count,
                missingPositions: output.missingPositions.filter(index => index < count),
                missing: !source || !output.remote && source.data?.mediaIntegrity?.state === 'missing', remote: output.remote === true,
                enabled: !!source && source.enabled !== false,
                running: state.runningNodeIds?.has(source?.id) === true || ['waiting','running'].includes(source?.runStatus)
                    || source?.el?.classList?.contains('running') === true,
                name: source?.customTitle || source?.el?.querySelector?.('.node-title')?.textContent || source?.type || '来源已不存在',
                thumbnail: output.remote ? '' : source?.data?.imagePreviewThumbnail || ''
            };
        });
    const slots = [];
    for (const group of groups) {
        if (!group.enabled || group.running) continue;
        for (let index = 0; index < group.count; index++) {
            const image = group.images[index] || '', assetKey = group.assets[index] || '';
            slots.push({ connection: group.connection, source: group.source, index, number: slots.length + 1,
                image, assetKey, missing: group.missing || group.missingPositions.includes(index) || (!image && !assetKey) });
        }
    }
    return { groups, slots, count: slots.length };
}
