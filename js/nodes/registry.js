/**
 * 汇总并注册所有节点类型定义，提供统一的节点配置映射表。
 */
import { imageGenerateNode } from './types/image-generate.js';
import { imageImportNode } from './types/image-import.js';
import { imageCompareNode } from './types/image-compare.js';
import { imageMergeNode } from './types/image-merge.js';
import { imageResizeNode } from './types/image-resize.js';
import { imagePreviewNode } from './types/image-preview.js';
import { imageSaveNode } from './types/image-save.js';
import { textChatNode } from './types/text-chat.js';
import { textMergeNode } from './types/text-merge.js';
import { textNode } from './types/text.js';
import { textSplitNode } from './types/text-split.js';
import { cameraControlNode } from './types/camera-control.js';
import { customParamsNode } from './types/custom-params.js';

const nodeDefinitions = [
    imageImportNode,
    imageCompareNode,
    imageMergeNode,
    imageResizeNode,
    imageGenerateNode,
    cameraControlNode,
    customParamsNode,
    textChatNode,
    textNode,
    textMergeNode,
    textSplitNode,
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

export function getNodeDefinitionPorts(type, direction) {
    const definition = typeof type === 'string' ? getNodeDefinition(type) : type;
    if (!definition) return [];
    if (direction === 'input') return Array.isArray(definition.inputs) ? definition.inputs : [];
    if (direction === 'output') return Array.isArray(definition.outputs) ? definition.outputs : [];
    return [];
}

export function getFirstCompatibleDefinitionPort(type, direction, dataType) {
    const ports = getNodeDefinitionPorts(type, direction);
    return ports.find((port) => port?.type === dataType) || null;
}
