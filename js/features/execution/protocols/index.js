/**
 * 协议注册中心
 * 自动加载和管理所有协议插件
 */

import { wrapConfigProtocol } from './request-builder.js';
import { migrateProtocolConfiguration } from './video-protocol-compiler.js';
import {
    applyProtocolOverride,
    createProtocolExecutionSnapshot,
    createProtocolOverrideRecord,
    normalizeProtocolOverrideRecord
} from './protocol-overrides.js';

// 协议存储
const PROTOCOLS = new Map();
const BASE_PROTOCOLS = new Map();
const PROTOCOL_OVERRIDES = new Map();
export const BUILT_IN_PROTOCOL_IDS = new Set([
    'google',
    'openai',
    'ttapi',
    'ttapi-openai',
    'newapi-image-async',
    'veo-unified',
    'veo-openai',
    'doubao-video',
    'api6789-seedance',
    'async-video-api',
    'relay-video',
    'agnesimage'
]);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function wrap(protocol) {
    return wrapConfigProtocol(migrateProtocolConfiguration(protocol));
}

function applyRegisteredProtocol(id) {
    const base = BASE_PROTOCOLS.get(id);
    if (!base) return null;
    const resolved = applyProtocolOverride(base, PROTOCOL_OVERRIDES.get(id) || null);
    const wrapped = wrap(resolved);
    PROTOCOLS.set(id, wrapped);
    return wrapped;
}

/**
 * 注册一个协议
 * @param {Object} protocol - 协议对象
 */
export function registerProtocol(protocol, options = {}) {
    if (!protocol || !protocol.id) {
        console.warn('[registerProtocol] 尝试注册无效的协议:', protocol);
        return;
    }

    console.log('[registerProtocol] 注册协议:', protocol.id, '标签:', protocol.label);

    const protocolId = String(protocol.id);
    // Built-in modules establish an immutable baseline. Passing { override: true }
    // updates only the independent user override record and never replaces it.
    if (BUILT_IN_PROTOCOL_IDS.has(protocolId) && BASE_PROTOCOLS.has(protocolId) && options.override === true) {
        setProtocolOverride(protocolId, createProtocolOverrideRecord({
            protocolId,
            baseProtocol: BASE_PROTOCOLS.get(protocolId),
            config: protocol,
            baseRevision: protocol.baseRevision || ''
        }));
        return applyRegisteredProtocol(protocolId);
    }

    const wrappedProtocol = wrap(protocol);
    if (BUILT_IN_PROTOCOL_IDS.has(protocolId)) {
        BASE_PROTOCOLS.set(protocolId, wrappedProtocol);
        return applyRegisteredProtocol(protocolId);
    }

    PROTOCOLS.set(protocolId, wrappedProtocol);
    console.log('[registerProtocol] 协议', protocol.id, '已注册，当前共有', PROTOCOLS.size, '个协议');
}

/**
 * 获取指定ID的协议
 * @param {string} id - 协议ID
 * @returns {Object|null} 协议对象
 */
export function getProtocol(id) {
    const canonicalId = id === 'relay-video' ? 'async-video-api' : id;
    return PROTOCOLS.get(canonicalId) || null;
}

/** Return a detached, immutable protocol snapshot for one execution attempt. */
export function getProtocolSnapshot(id) {
    const protocol = typeof id === 'string' ? getProtocol(id) : id;
    return protocol ? createProtocolExecutionSnapshot(protocol) : null;
}

export function getProtocolOverride(id) {
    const record = PROTOCOL_OVERRIDES.get(id);
    return record ? clone(record) : null;
}

export function getProtocolOverrides() {
    return Object.fromEntries(Array.from(PROTOCOL_OVERRIDES.entries()).map(([id, record]) => [id, clone(record)]));
}

export function setProtocolOverride(id, rawRecord) {
    if (!BUILT_IN_PROTOCOL_IDS.has(id) || !BASE_PROTOCOLS.has(id)) {
        throw new Error(`协议 “${id}” 不是已加载的内置协议，无法创建覆盖记录`);
    }
    const record = normalizeProtocolOverrideRecord(rawRecord, id);
    if (!record.protocolId) record.protocolId = id;
    record.config = { ...(record.config || {}), id };
    PROTOCOL_OVERRIDES.set(id, record);
    return applyRegisteredProtocol(id);
}

export function clearProtocolOverride(id) {
    if (!PROTOCOL_OVERRIDES.delete(id)) return false;
    applyRegisteredProtocol(id);
    return true;
}

export function hydrateProtocolOverrides(records = {}) {
    Object.entries(records || {}).forEach(([id, record]) => {
        if (!BUILT_IN_PROTOCOL_IDS.has(id)) return;
        PROTOCOL_OVERRIDES.set(id, normalizeProtocolOverrideRecord(record, id));
        if (BASE_PROTOCOLS.has(id)) applyRegisteredProtocol(id);
    });
    return getProtocolOverrides();
}

/**
 * 获取所有已注册的协议
 * @returns {Array} 协议数组
 */
export function getAllProtocols() {
    return Array.from(PROTOCOLS.values());
}

/**
 * 获取支持指定任务类型的协议
 * @param {string} taskType - 任务类型 ('chat', 'image', 'video')
 * @returns {Array} 协议数组
 */
export function getProtocolsForTask(taskType) {
    if (!taskType) return getAllProtocols();
    return getAllProtocols().filter(p => p.taskTypes && p.taskTypes.includes(taskType));
}

/**
 * 检查协议是否存在
 * @param {string} id - 协议ID
 * @returns {boolean}
 */
export function hasProtocol(id) {
    return PROTOCOLS.has(id);
}

/**
 * 删除指定ID的协议
 * @param {string} id - 协议ID
 * @returns {boolean} 是否删除成功
 */
export function deleteProtocol(id) {
    if (!PROTOCOLS.has(id)) {
        console.warn(`尝试删除不存在的协议: ${id}`);
        return false;
    }
    PROTOCOLS.delete(id);
    console.log(`协议 ${id} 已从注册表中删除`);
    return true;
}

/**
 * 获取协议的选项列表（用于下拉框）
 * @param {string} taskType - 可选，任务类型过滤
 * @returns {Array} 选项数组 [{value, label}]
 */
export function getProtocolSelectOptions(taskType = '') {
    const protocols = taskType ? getProtocolsForTask(taskType) : getAllProtocols();
    return protocols.map(p => ({
        value: p.id,
        label: p.label
    }));
}

/**
 * 获取协议的帮助文本
 * @param {string} id - 协议ID
 * @returns {string} 帮助文本
 */
export function getProtocolHelpText(id) {
    const protocol = getProtocol(id);
    return protocol?.helpText || '';
}

/**
 * 获取视频协议的元数据
 * @param {string} id - 协议ID
 * @returns {Object|null} 视频元数据
 */
export function getVideoProtocolMeta(id) {
    const protocol = getProtocol(id);
    return protocol?.videoMeta || null;
}

// 延迟导入协议以避免循环依赖
// 实际的协议注册将在各协议文件被导入时发生
export async function loadProtocols() {
    console.log('[loadProtocols] 开始加载协议...');

    // 动态导入所有协议
    // 注意：这些导入会触发各协议文件中的 registerProtocol() 调用
    // Fetch override records before built-in modules register so each baseline
    // is resolved exactly once during startup. A failed request is equivalent
    // to an empty override set and leaves built-ins usable.
    try {
        const overrideResponse = await fetch('/api/protocol/overrides', { cache: 'no-store' });
        if (overrideResponse.ok) {
            const payload = await overrideResponse.json();
            hydrateProtocolOverrides(payload.overrides || {});
        }
    } catch (error) {
        console.warn('[loadProtocols] 获取协议覆盖记录失败，仅加载内置基线:', error);
    }

    const builtInModules = [
        import('./google.js'),
        import('./openai.js'),
        import('./ttapi.js'),
        import('./ttapi-openai.js'),
        import('./newapi-image-async.js'),
        import('./veo-unified.js'),
        import('./veo-openai.js'),
        import('./doubao-video.js'),
        import('./api6789-video.js'),
        import('./api6789-seedance.js'),
        // 临时方案：直接导入用户创建的协议
        import('./agnesimage.js').catch(err => console.warn('[loadProtocols] agnesimage 协议未找到:', err))
    ];
    const legacyStaticLoaders = [];
    const userProtocolLoaders = [];

    console.log('[loadProtocols] 内置协议已加入队列，准备加载用户协议...');

    // 动态加载用户创建的协议文件
    try {
        const response = await fetch('/api/protocol/list');
        console.log('[loadProtocols] API响应状态:', response.ok, response.status);

        if (response.ok) {
            const result = await response.json();
            console.log('[loadProtocols] API返回数据:', result);

            if (result.protocols && Array.isArray(result.protocols)) {
                console.log('[loadProtocols] 找到', result.protocols.length, '个协议文件');

                const userProtocolIds = Array.isArray(result.userProtocols)
                    ? result.userProtocols
                    : [];
                const userProtocolIdSet = new Set(userProtocolIds);

                result.protocols.forEach(protocolId => {
                    if (!/^[a-z][a-z0-9\-]*$/.test(protocolId)) return;
                    if (!BUILT_IN_PROTOCOL_IDS.has(protocolId) && !userProtocolIdSet.has(protocolId)) {
                        console.log('[loadProtocols] 准备导入静态用户协议:', protocolId);
                        legacyStaticLoaders.push(() => (
                            import(`./${protocolId}.js`)
                                .then(module => {
                                    console.log('[loadProtocols] 成功加载静态用户协议:', protocolId);
                                    return module;
                                })
                                .catch(err => {
                                    console.error(`[loadProtocols] 加载静态用户协议 ${protocolId} 失败:`, err);
                                })
                        ));
                    } else if (BUILT_IN_PROTOCOL_IDS.has(protocolId)) {
                        console.log('[loadProtocols] 跳过内置协议:', protocolId);
                    }
                });

                userProtocolIds.forEach(protocolId => {
                    if (!/^[a-z][a-z0-9\-]*$/.test(protocolId)) return;
                    console.log('[loadProtocols] 准备导入持久协议:', protocolId);
                    userProtocolLoaders.push(() => (
                        import(`/api/protocol/module/${encodeURIComponent(protocolId)}.js`)
                            .then(module => {
                                console.log('[loadProtocols] 成功加载持久协议:', protocolId);
                                return module;
                            })
                            .catch(err => {
                                console.error(`[loadProtocols] 加载持久协议 ${protocolId} 失败:`, err);
                            })
                    ));
                });
            }
        }
    } catch (error) {
        console.warn('[loadProtocols] 获取协议列表失败，仅加载内置协议:', error);
    }

    await Promise.all(builtInModules);
    await Promise.all(legacyStaticLoaders.map(load => load()));
    await Promise.all(userProtocolLoaders.map(load => load()));
    console.log('[loadProtocols] 所有协议加载完成，当前已注册:', PROTOCOLS.size, '个协议');
    console.log('[loadProtocols] 协议列表:', Array.from(PROTOCOLS.keys()));
}
