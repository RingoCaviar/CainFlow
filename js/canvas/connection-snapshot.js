export function serializeConnection(connection = {}) {
    const numericOrder = Number(connection.order);
    return {
        id: connection.id,
        from: { ...(connection.from || {}) },
        to: { ...(connection.to || {}) },
        type: connection.type,
        ...(connection.to?.port === 'mask' ? { maskConsumption: connection.maskConsumption === 'single' ? 'single' : 'legacy-first' } : {}),
        ...(Number.isFinite(numericOrder) ? { order: numericOrder } : {})
    };
}
