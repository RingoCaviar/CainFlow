/**
 * 收口旧节点类型兼容迁移，确保运行态只处理当前节点体系。
 */
export function migrateLegacyNodeData(node) {
    if (!node || typeof node !== 'object') return node;

    if (node.type !== 'TextInput' && node.type !== 'TextDisplay') {
        return node;
    }

    const migrated = {
        ...node,
        type: 'Text'
    };

    if (node.type === 'TextDisplay') {
        const nextData = migrated.data && typeof migrated.data === 'object'
            ? { ...migrated.data }
            : {};
        const text = typeof migrated.text === 'string'
            ? migrated.text
            : (typeof nextData.text === 'string' ? nextData.text : '');
        migrated.data = nextData;
        migrated.text = text;
        nextData.text = text;
    }

    return migrated;
}

export function migrateLegacyNodes(nodes = []) {
    if (!Array.isArray(nodes)) return [];
    return nodes.map((node) => migrateLegacyNodeData(node));
}

export function migrateLegacyWorkflowData(workflowData) {
    if (!workflowData || typeof workflowData !== 'object') return workflowData;
    return {
        ...workflowData,
        nodes: migrateLegacyNodes(workflowData.nodes)
    };
}
