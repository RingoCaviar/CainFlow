export const DEFAULT_REFERENCE_IMAGE_COUNT = 5;
export const MIN_REFERENCE_IMAGE_COUNT = 0;
export const MAX_REFERENCE_IMAGE_COUNT = 64;
export const REFERENCE_IMAGE_NODE_TYPES = new Set(['ImageGenerate', 'VideoGenerate', 'TextChat']);
export const REFERENCE_IMAGES_PORT = 'referenceImages';

export function normalizeReferenceImageCount(value, fallback = DEFAULT_REFERENCE_IMAGE_COUNT) {
    const parsed = parseInt(value ?? fallback, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REFERENCE_IMAGE_COUNT;
    return Math.max(MIN_REFERENCE_IMAGE_COUNT, Math.min(MAX_REFERENCE_IMAGE_COUNT, parsed));
}

export function getReferenceImageCount(restoreData = {}) {
    const rd = restoreData || {};
    return normalizeReferenceImageCount(
        rd.referenceImageCount ?? rd.referenceImageInputCount ?? rd.data?.referenceImageCount,
        DEFAULT_REFERENCE_IMAGE_COUNT
    );
}

export function getReferenceImageInputPorts(restoreData = {}, nodeType = '') {
    const normalizedNodeType = String(nodeType || restoreData?.type || restoreData?.nodeType || '').trim();
    if (normalizedNodeType === 'VideoGenerate') {
        return [
            { name: 'image_1', type: 'image', label: '首帧' },
            { name: 'image_2', type: 'image', label: '尾帧' },
            { name: REFERENCE_IMAGES_PORT, type: 'image', label: '参考图', multiple: true }
        ];
    }
    return [{ name: REFERENCE_IMAGES_PORT, type: 'image', label: '参考图', multiple: true }];
}

export function isMultiConnectionInput(nodeType = '', portName = '') {
    return REFERENCE_IMAGE_NODE_TYPES.has(String(nodeType || '')) && portName === REFERENCE_IMAGES_PORT;
}

export function orderInputConnections(nodeType = '', connections = []) {
    return [...(Array.isArray(connections) ? connections : [])].sort((a, b) => {
        const aIsMulti = isMultiConnectionInput(nodeType, a?.to?.port);
        const bIsMulti = isMultiConnectionInput(nodeType, b?.to?.port);
        if (aIsMulti !== bIsMulti) return aIsMulti ? -1 : 1;
        if (!aIsMulti) return 0;
        return (Number(a.order) || 0) - (Number(b.order) || 0);
    });
}

export function getNextInputConnectionOrder(connections = [], target = {}) {
    return (Array.isArray(connections) ? connections : []).reduce((maximum, connection) => {
        if (connection?.to?.nodeId !== target.nodeId || connection?.to?.port !== target.port) {
            return maximum;
        }
        return Math.max(maximum, Number(connection.order) || 0);
    }, -1) + 1;
}

function getLegacyReferencePortRank(nodeType, portName, fallback) {
    if (portName === REFERENCE_IMAGES_PORT) return fallback;
    if (portName === 'image') return 0;
    const match = String(portName || '').match(/^image_(\d+)$/);
    if (!match) return fallback;
    const index = parseInt(match[1], 10) || 0;
    return nodeType === 'VideoGenerate' ? Math.max(0, index - 3) : Math.max(0, index - 1);
}

export function migrateReferenceImageConnections(nodes = [], connections = []) {
    const nodeTypeById = new Map((Array.isArray(nodes) ? nodes : [])
        .filter((node) => node?.id)
        .map((node) => [node.id, node.type || '']));
    const candidatesByTarget = new Map();
    const migrated = [];

    (Array.isArray(connections) ? connections : []).forEach((connection, index) => {
        const nodeType = nodeTypeById.get(connection?.to?.nodeId) || '';
        const portName = String(connection?.to?.port || '');
        const isLegacyReference = nodeType === 'VideoGenerate'
            ? /^image_(?:[3-9]|[1-9]\d+)$/.test(portName)
            : (nodeType === 'ImageGenerate' || nodeType === 'TextChat') && (portName === 'image' || /^image_\d+$/.test(portName));
        if (!isLegacyReference && portName !== REFERENCE_IMAGES_PORT) {
            migrated.push({ connection, index });
            return;
        }
        if (!REFERENCE_IMAGE_NODE_TYPES.has(nodeType)) {
            migrated.push({ connection, index });
            return;
        }

        const targetKey = `${connection.to.nodeId}:${REFERENCE_IMAGES_PORT}`;
        if (!candidatesByTarget.has(targetKey)) candidatesByTarget.set(targetKey, []);
        candidatesByTarget.get(targetKey).push({
            connection: {
                ...connection,
                from: { ...connection.from },
                to: { ...connection.to, port: REFERENCE_IMAGES_PORT }
            },
            index,
            rank: Number.isFinite(Number(connection.order))
                ? Number(connection.order)
                : getLegacyReferencePortRank(nodeType, portName, index)
        });
    });

    candidatesByTarget.forEach((items) => {
        const seenSources = new Set();
        items.sort((a, b) => a.rank - b.rank || a.index - b.index).forEach((item) => {
            const sourceKey = `${item.connection.from?.nodeId || ''}:${item.connection.from?.port || ''}`;
            if (seenSources.has(sourceKey)) return;
            seenSources.add(sourceKey);
            migrated.push({
                connection: { ...item.connection, order: seenSources.size - 1 },
                index: item.index
            });
        });
    });

    return migrated.sort((a, b) => a.index - b.index).map(({ connection }) => connection);
}

export function applyReferenceImagePorts(config, restoreData = {}) {
    if (!REFERENCE_IMAGE_NODE_TYPES.has(config?.type)) return config;
    const baseInputs = Array.isArray(config.inputs)
        ? config.inputs.filter((port) => !(port?.type === 'image' && /^image_\d+$/.test(String(port?.name || ''))))
        : [];
    const maskPort = baseInputs.find((port) => port?.name === 'mask') || null;
    const nonMaskInputs = baseInputs.filter((port) => port?.name !== 'mask');
    const paramsIndex = nonMaskInputs.findIndex((port) => port?.name === 'params');
    const referencePorts = getReferenceImageInputPorts(restoreData, config?.type || '');
    const inputs = paramsIndex >= 0
        ? [
            ...nonMaskInputs.slice(0, paramsIndex),
            ...referencePorts,
            ...(maskPort ? [maskPort] : []),
            ...nonMaskInputs.slice(paramsIndex)
        ]
        : [...nonMaskInputs, ...referencePorts, ...(maskPort ? [maskPort] : [])];
    return { ...config, inputs };
}
