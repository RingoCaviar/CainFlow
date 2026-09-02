/**
 * Helpers for cloning connection snapshots onto newly created node ids.
 */
import { serializeConnection } from './connection-snapshot.js';
import {
    getNextInputConnectionOrder,
    isMultiConnectionInput as supportsMultiConnectionInput,
    MAX_REFERENCE_IMAGE_COUNT
} from '../nodes/reference-image-ports.js';
import { getGenerationNodeInputConnectionPolicy } from '../nodes/generation-input-projection.js';
export function createConnectionId() {
    return 'c_' + Math.random().toString(36).substr(2, 9);
}

function cloneEndpoint(endpoint) {
    if (!endpoint?.nodeId || !endpoint?.port) return null;
    return {
        nodeId: endpoint.nodeId,
        port: endpoint.port
    };
}

function cloneConnectionSnapshot(connection) {
    const from = cloneEndpoint(connection?.from);
    const to = cloneEndpoint(connection?.to);
    if (!from || !to) return null;

    return serializeConnection({ ...connection, id: connection.id || '', from, to, type: connection.type || '' });
}

export function collectConnectionSnapshotsForNodes(state, nodeIds) {
    const nodeIdSet = new Set(Array.isArray(nodeIds) ? nodeIds : Array.from(nodeIds || []));
    const internalConnections = [];
    const externalConnections = [];

    state.connections.forEach((connection) => {
        const fromSelected = nodeIdSet.has(connection.from?.nodeId);
        const toSelected = nodeIdSet.has(connection.to?.nodeId);
        if (!fromSelected && !toSelected) return;

        const snapshot = cloneConnectionSnapshot(connection);
        if (!snapshot) return;

        if (fromSelected && toSelected) {
            internalConnections.push(snapshot);
        } else {
            externalConnections.push(snapshot);
        }
    });

    return {
        internalConnections,
        externalConnections
    };
}

function hasPort(state, endpoint, direction) {
    const node = state.nodes.get(endpoint.nodeId);
    if (!node?.el) return false;

    return Array.from(node.el.querySelectorAll(`.node-port[data-direction="${direction}"]`))
        .some((portEl) => portEl.dataset.port === endpoint.port);
}

function hasSameConnection(state, from, to) {
    return state.connections.some((connection) => (
        connection.from.nodeId === from.nodeId &&
        connection.from.port === from.port &&
        connection.to.nodeId === to.nodeId &&
        connection.to.port === to.port
    ));
}

function hasInputConnection(state, to) {
    return state.connections.some((connection) => (
        connection.to.nodeId === to.nodeId &&
        connection.to.port === to.port
    ));
}

function isMultiConnectionInput(state, to) {
    const node = state.nodes.get(to.nodeId);
    const projectedPolicy = getGenerationNodeInputConnectionPolicy(node, to.port);
    return projectedPolicy?.multiple ?? supportsMultiConnectionInput(node?.type, to.port);
}

function isNodeRunning(state, nodeId) {
    return state.runningNodeIds?.has(nodeId) || state.nodes.get(nodeId)?.el?.classList?.contains('running');
}

function canAppendConnection(state, connection) {
    if (!state.nodes.has(connection.from.nodeId) || !state.nodes.has(connection.to.nodeId)) {
        return false;
    }
    if (isNodeRunning(state, connection.from.nodeId) || isNodeRunning(state, connection.to.nodeId)) {
        return false;
    }
    if (!hasPort(state, connection.from, 'output') || !hasPort(state, connection.to, 'input')) {
        return false;
    }
    if (hasSameConnection(state, connection.from, connection.to)) {
        return false;
    }
    const multiConnectionInput = isMultiConnectionInput(state, connection.to);
    const targetNode = state.nodes.get(connection.to.nodeId);
    const projectedPolicy = getGenerationNodeInputConnectionPolicy(targetNode, connection.to.port);
    if (projectedPolicy && !projectedPolicy.supported) return false;
    if (!multiConnectionInput && hasInputConnection(state, connection.to)) {
        return false;
    }
    if (multiConnectionInput) {
        const connectionCount = state.connections.filter((existingConnection) => (
            existingConnection.to.nodeId === connection.to.nodeId &&
            existingConnection.to.port === connection.to.port
        )).length;
        if (connectionCount >= (projectedPolicy?.maxCount ?? MAX_REFERENCE_IMAGE_COUNT)) return false;
    }
    return true;
}

function mapEndpoint(endpoint, idMap) {
    return {
        nodeId: idMap.get(endpoint.nodeId) || endpoint.nodeId,
        port: endpoint.port
    };
}

function buildMappedConnection(snapshot, idMap, kind) {
    const hasMappedFrom = idMap.has(snapshot.from.nodeId);
    const hasMappedTo = idMap.has(snapshot.to.nodeId);

    if (kind === 'internal' && (!hasMappedFrom || !hasMappedTo)) return null;
    if (kind === 'external' && hasMappedFrom === hasMappedTo) return null;

    return {
        id: createConnectionId(),
        from: mapEndpoint(snapshot.from, idMap),
        to: mapEndpoint(snapshot.to, idMap),
        type: snapshot.type || '',
        ...(Number.isFinite(Number(snapshot.order)) ? { order: Number(snapshot.order) } : {})
    };
}

function appendConnectionList(state, idMap, entries) {
    let added = 0;
    let skipped = 0;
    const counts = {
        internal: { added: 0, skipped: 0 },
        external: { added: 0, skipped: 0 }
    };
    const mappedConnections = entries.map(({ snapshot, kind }) => ({
        connection: buildMappedConnection(snapshot, idMap, kind),
        kind
    }));
    const orderedMultiConnections = new Map();

    mappedConnections.forEach((entry) => {
        const { connection } = entry;
        if (!connection || !isMultiConnectionInput(state, connection.to)) return;
        const key = `${connection.to.nodeId}\u0000${connection.to.port}`;
        const group = orderedMultiConnections.get(key) || [];
        group.push(entry);
        orderedMultiConnections.set(key, group);
    });
    orderedMultiConnections.forEach((group) => {
        group.sort((left, right) => (
            (Number(left.connection.order) || 0) - (Number(right.connection.order) || 0)
        ));
    });

    mappedConnections.forEach((candidate) => {
        let mappedEntry = candidate;
        let mappedConnection = mappedEntry.connection;
        if (mappedConnection && isMultiConnectionInput(state, mappedConnection.to)) {
            const key = `${mappedConnection.to.nodeId}\u0000${mappedConnection.to.port}`;
            mappedEntry = orderedMultiConnections.get(key).shift();
            mappedConnection = mappedEntry.connection;
        }
        if (!mappedConnection || !canAppendConnection(state, mappedConnection)) {
            skipped += 1;
            counts[mappedEntry.kind].skipped += 1;
            return;
        }

        if (isMultiConnectionInput(state, mappedConnection.to)) {
            mappedConnection.order = getNextInputConnectionOrder(state.connections, mappedConnection.to);
        }

        state.connections.push(mappedConnection);
        added += 1;
        counts[mappedEntry.kind].added += 1;
    });

    return { added, skipped, counts };
}

export function appendMappedConnectionSnapshots({
    state,
    idMap,
    internalConnections = [],
    externalConnections = [],
    includeExternalConnections = false
}) {
    const entries = [
        ...internalConnections.map((snapshot) => ({ snapshot, kind: 'internal' })),
        ...(includeExternalConnections
            ? externalConnections.map((snapshot) => ({ snapshot, kind: 'external' }))
            : [])
    ];
    const result = appendConnectionList(state, idMap, entries);

    return {
        added: result.added,
        skipped: result.skipped,
        internalAdded: result.counts.internal.added,
        externalAdded: result.counts.external.added,
        internalSkipped: result.counts.internal.skipped,
        externalSkipped: result.counts.external.skipped
    };
}
