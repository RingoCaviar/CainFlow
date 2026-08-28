export function serializeConnection(connection = {}) {
    const numericOrder = Number(connection.order);
    return {
        id: connection.id,
        from: { ...(connection.from || {}) },
        to: { ...(connection.to || {}) },
        type: connection.type,
        ...(Number.isFinite(numericOrder) ? { order: numericOrder } : {})
    };
}
