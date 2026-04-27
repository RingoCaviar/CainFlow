/**
 * 汇总并注册所有节点类型定义，提供统一的节点配置映射表。
 */
import { imageGenerateNode } from './types/image-generate.js';
import { imageImportNode } from './types/image-import.js';
import { imageCompareNode } from './types/image-compare.js';
import { imageResizeNode } from './types/image-resize.js';
import { imagePreviewNode } from './types/image-preview.js';
import { imageSaveNode } from './types/image-save.js';
import { textChatNode } from './types/text-chat.js';
import { textDisplayNode } from './types/text-display.js';
import { textInputNode } from './types/text-input.js';

const nodeDefinitions = [
    imageImportNode,
    imageCompareNode,
    imageResizeNode,
    imageGenerateNode,
    textChatNode,
    textInputNode,
    textDisplayNode,
    imagePreviewNode,
    imageSaveNode
];

export const NODE_CONFIGS = Object.freeze(
    nodeDefinitions.reduce((acc, definition) => {
        acc[definition.type] = definition;
        return acc;
    }, {})
);

export function listNodeDefinitions() {
    return nodeDefinitions.slice();
}

export function getNodeDefinition(type) {
    return NODE_CONFIGS[type] || null;
}
/**
 * 注册并暴露所有节点定义，供画布创建和执行流程统一查询。
 */
