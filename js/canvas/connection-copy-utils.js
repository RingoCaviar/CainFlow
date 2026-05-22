/**
 * Helpers for cloning connection snapshots onto newly created node ids.
 */
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

    return {
        id: connection.id || '',
        from,
        to,
        type: connection.type || ''
    };
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
    if (hasInputConnection(state, connection.to)) {
        return false;
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
        type: snapshot.type || ''
    };
}

function appendConnectionList(state, idMap, connections, kind) {
    let added = 0;
    let skipped = 0;

    connections.forEach((snapshot) => {
        const mappedConnection = buildMappedConnection(snapshot, idMap, kind);
        if (!mappedConnection || !canAppendConnection(state, mappedConnection)) {
            skipped += 1;
            return;
        }

        state.connections.push(mappedConnection);
        added += 1;
    });

    return { added, skipped };
}

export function appendMappedConnectionSnapshots({
    state,
    idMap,
    internalConnections = [],
    externalConnections = [],
    includeExternalConnections = false
}) {
    const internal = appendConnectionList(state, idMap, internalConnections, 'internal');
    const external = includeExternalConnections
        ? appendConnectionList(state, idMap, externalConnections, 'external')
        : { added: 0, skipped: 0 };

    return {
        added: internal.added + external.added,
        skipped: internal.skipped + external.skipped,
        internalAdded: internal.added,
        externalAdded: external.added,
        internalSkipped: internal.skipped,
        externalSkipped: external.skipped
    };
}
