import { resolveGenerationInputProjection } from './generation-input-projection.js';

/**
 * 视频生成卡片的只读协议契约摘要。
 * 这个纯函数同时供初始渲染和模型切换后的 DOM 更新使用。
 */
export function describeVideoProtocolCard(protocol, modelId) {
    const projection = resolveGenerationInputProjection({ protocol, modelId, taskType: 'video' });
    return {
        isDeclared: projection.isDeclared,
        isIncomplete: projection.isIncomplete,
        isUnmatched: projection.isUnmatched,
        summary: projection.summary
    };
}
