/**
 * Resolves the input contract for a protocol-driven generation card.
 * The returned data is deliberately DOM-free so card rendering, connection
 * handling, and execution preflight share one test surface.
 */
function getVariant(protocol, modelId) {
    const variants = protocol?.variants || {};
    const hasVariants = Object.keys(variants).length > 0;
    return {
        hasVariants,
        variant: hasVariants ? variants[modelId] || null : null
    };
}

function getParameters(protocol, variant) {
    return { ...(protocol?.parameters || {}), ...(variant?.parameters || {}) };
}

function isSupportedInputPort(definition = {}) {
    return definition.inputPort === true && ['text', 'image'].includes(definition.portType || 'text');
}

function getPortLabel(id, definition = {}) {
    return definition.portLabel || definition.label || id;
}

function describeProjection(protocol, modelId, parameters, variant) {
    const constraints = [];
    const duration = parameters.seconds || parameters.duration;
    if (duration?.min !== undefined || duration?.max !== undefined) {
        constraints.push(`时长 ${duration.min ?? '—'}–${duration.max ?? '—'} 秒`);
    }
    const referenceImages = parameters.referenceImages;
    const maximumImages = referenceImages?.portCount ?? variant?.referenceImage?.maxCount;
    if (maximumImages !== undefined) constraints.push(`最多 ${maximumImages} 张参考图`);
    return [protocol.label || protocol.id, modelId, ...constraints].filter(Boolean).join(' · ');
}

export function resolveGenerationInputProjection({ protocol, modelId, taskType }) {
    if (!protocol) {
        return {
            protocolId: '', modelId: modelId || '', ports: [], promptPortIds: ['prompt'],
            isDeclared: false, isIncomplete: false, isUnmatched: false, summary: '', blockedReason: ''
        };
    }

    const { hasVariants, variant } = getVariant(protocol, modelId);
    if (hasVariants && !variant) {
        return {
            protocolId: protocol.id || '', modelId: modelId || '', ports: [], promptPortIds: ['prompt'],
            isDeclared: true, isIncomplete: false, isUnmatched: true,
            summary: `${protocol.label || protocol.id} · ${modelId || '未选择模型'} · 未配置变体`,
            blockedReason: '当前协议未配置此模型变体；请更换模型或在协议编辑器中补齐变体。'
        };
    }

    const parameters = getParameters(protocol, variant);
    const ports = [];
    const unsupported = [];
    Object.entries(parameters).forEach(([key, definition]) => {
        if (Array.isArray(definition?.taskTypes) && !definition.taskTypes.includes(taskType)) return;
        if (definition?.inputPort !== true) return;
        const id = definition.id || key;
        if (!isSupportedInputPort(definition)) {
            unsupported.push(id);
            return;
        }
        const maxCount = definition.portType === 'image'
            ? (Number(definition.portCount) || (id === 'referenceImages' ? Number(variant?.referenceImage?.maxCount) || null : null))
            : null;
        ports.push({
            id,
            type: definition.portType || 'text',
            label: getPortLabel(id, definition),
            multiple: definition.portType === 'image' && Number(maxCount) > 1,
            maxCount,
            required: definition.required === true
        });
    });

    const promptPortIds = ports
        .filter((port) => port.type === 'text' && port.required)
        .map((port) => port.id);
    if (!promptPortIds.includes('prompt')) promptPortIds.unshift('prompt');
    const blockedReason = unsupported.length > 0
        ? `当前协议包含不支持的输入类型：${unsupported.join('、')}。`
        : (Object.keys(parameters).length === 0 ? '当前协议未声明可编辑视频参数；请在协议编辑器中补齐后重试。' : '');
    const isIncomplete = Object.keys(parameters).length === 0;
    return {
        protocolId: protocol.id || '', modelId: modelId || '', ports, promptPortIds,
        isDeclared: !isIncomplete,
        isIncomplete,
        isUnmatched: false,
        summary: isIncomplete
            ? `${protocol.label || protocol.id} · ${modelId || '未选择模型'} · 未声明可编辑视频参数`
            : describeProjection(protocol, modelId, parameters, variant),
        blockedReason
    };
}

export function getProjectionImagePortIds(projection) {
    return (projection?.ports || []).filter((port) => port.type === 'image').map((port) => port.id);
}

export function getProjectedInputConnectionPolicy(projection, portId, stablePortIds = ['params']) {
    if (stablePortIds.includes(portId)) return { supported: true, multiple: false, maxCount: 1 };
    const port = (projection?.ports || []).find((candidate) => candidate.id === portId);
    if (!port) return { supported: false, multiple: false, maxCount: 0 };
    return {
        supported: true,
        multiple: port.multiple === true,
        maxCount: port.multiple === true ? port.maxCount : 1
    };
}

export function getGenerationNodeInputConnectionPolicy(node, portId) {
    if (node?.type !== 'VideoGenerate' || !node.generationInputProjection) return null;
    return getProjectedInputConnectionPolicy(node.generationInputProjection, portId);
}

export function getInactiveProjectedInputPorts(projection, connections = [], stablePortIds = ['params']) {
    if (!projection?.isDeclared) return [];
    const declared = new Set([...(projection.ports || []).map((port) => port.id), ...stablePortIds]);
    return (Array.isArray(connections) ? connections : [])
        .map((connection) => connection?.to?.port)
        .filter((port) => typeof port === 'string' && !declared.has(port));
}

export function validateProjectedInputConnections(projection, connections = [], stablePortIds = ['params']) {
    const inactivePorts = Array.from(new Set(getInactiveProjectedInputPorts(projection, connections, stablePortIds)));
    const counts = new Map();
    (Array.isArray(connections) ? connections : []).forEach((connection) => {
        const portId = connection?.to?.port;
        if (typeof portId !== 'string' || inactivePorts.includes(portId)) return;
        counts.set(portId, (counts.get(portId) || 0) + 1);
    });
    const violations = [];
    counts.forEach((actualCount, portId) => {
        const policy = getProjectedInputConnectionPolicy(projection, portId, stablePortIds);
        if (policy.supported && Number.isFinite(policy.maxCount) && actualCount > policy.maxCount) {
            violations.push({ portId, maxCount: policy.maxCount, actualCount });
        }
    });
    return { valid: inactivePorts.length === 0 && violations.length === 0, inactivePorts, violations };
}

export function getProjectedInputValidationReason(projection, connections = []) {
    const validation = validateProjectedInputConnections(projection, connections);
    if (validation.inactivePorts.length > 0) {
        return `当前模型不支持已连接的输入：${validation.inactivePorts.join('、')}。请断开连接或切换回兼容模型。`;
    }
    if (validation.violations.length > 0) {
        const violation = validation.violations[0];
        return `输入 ${violation.portId} 最多允许 ${violation.maxCount} 条连接，当前有 ${violation.actualCount} 条。请断开多余连接。`;
    }
    return '';
}

export function applyGenerationInputProjection(root, projection) {
    if (!root) return;
    const ports = new Map((projection?.ports || []).filter((port) => port.type === 'image').map((port) => [port.id, port]));
    root.querySelectorAll('.node-port.input[data-type="image"]').forEach((element) => {
        const descriptor = ports.get(element.dataset.port);
        element.classList.toggle('hidden', !descriptor);
        if (!descriptor) return;
        if (descriptor.multiple) element.dataset.multiple = 'true';
        else element.removeAttribute('data-multiple');
        element.dataset.baseLabel = descriptor.label;
    });
}
