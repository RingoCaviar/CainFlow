/**
 * 协议注册中心
 * 自动加载和管理所有协议插件
 */

import { wrapConfigProtocol } from './request-builder.js';

// 协议存储
const PROTOCOLS = new Map();

/**
 * 注册一个协议
 * @param {Object} protocol - 协议对象
 */
export function registerProtocol(protocol) {
    if (!protocol || !protocol.id) {
        console.warn('[registerProtocol] 尝试注册无效的协议:', protocol);
        return;
    }

    console.log('[registerProtocol] 注册协议:', protocol.id, '标签:', protocol.label);

    // 自动包装纯配置协议（添加 buildUrl/buildRequest/parseResponse 函数）
    const wrappedProtocol = wrapConfigProtocol(protocol);

    PROTOCOLS.set(protocol.id, wrappedProtocol);
    console.log('[registerProtocol] 协议', protocol.id, '已注册，当前共有', PROTOCOLS.size, '个协议');
}

/**
 * 获取指定ID的协议
 * @param {string} id - 协议ID
 * @returns {Object|null} 协议对象
 */
export function getProtocol(id) {
    return PROTOCOLS.get(id) || null;
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
    const protocolModules = [
        import('./google.js'),
        import('./openai.js'),
        import('./ttapi.js'),
        import('./ttapi-openai.js'),
        import('./newapi-image-async.js'),
        import('./veo-unified.js'),
        import('./veo-openai.js'),
        import('./doubao-video.js'),
        // 临时方案：直接导入用户创建的协议
        import('./agnesimage.js').catch(err => console.warn('[loadProtocols] agnesimage 协议未找到:', err))
    ];

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

                result.protocols.forEach(protocolId => {
                    // 避免重复导入内置协议和已经手动添加的协议
                    const builtInProtocols = ['google', 'openai', 'ttapi', 'ttapi-openai', 'newapi-image-async', 'veo-unified', 'veo-openai', 'doubao-video', 'agnesimage'];
                    if (!builtInProtocols.includes(protocolId)) {
                        console.log('[loadProtocols] 准备导入用户协议:', protocolId);
                        protocolModules.push(
                            import(`./${protocolId}.js`)
                                .then(module => {
                                    console.log('[loadProtocols] 成功加载协议:', protocolId);
                                    return module;
                                })
                                .catch(err => {
                                    console.error(`[loadProtocols] 加载协议 ${protocolId} 失败:`, err);
                                })
                        );
                    } else {
                        console.log('[loadProtocols] 跳过内置协议:', protocolId);
                    }
                });
            }
        }
    } catch (error) {
        console.warn('[loadProtocols] 获取协议列表失败，仅加载内置协议:', error);
    }

    await Promise.all(protocolModules);
    console.log('[loadProtocols] 所有协议加载完成，当前已注册:', PROTOCOLS.size, '个协议');
    console.log('[loadProtocols] 协议列表:', Array.from(PROTOCOLS.keys()));
}
