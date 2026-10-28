export function serializeConnection(connection = {}) {
    const numericOrder = Number(connection.order);
    // Edges are JSON workflow records. Retain extensions without sharing their
    // mutable values with undo, clipboard, or saved snapshots.
    const snapshot = JSON.parse(JSON.stringify(connection));
    delete snapshot.order;
    delete snapshot.maskConsumption;
    return {
        ...snapshot,
        id: connection.id,
        from: { ...(snapshot.from || {}) },
        to: { ...(snapshot.to || {}) },
        type: connection.type,
        ...(connection.to?.port === 'mask' ? { maskConsumption: connection.maskConsumption === 'single' ? 'single' : 'legacy-first' } : {}),
        ...(Number.isFinite(numericOrder) ? { order: numericOrder } : {})
    };
}
