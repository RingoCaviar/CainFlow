/**
 * 定义请求自定义参数节点的元数据、端口配置与默认尺寸。
 */

/**
 * 根据参数行生成输入端口
 */
export function getCustomParamsInputPorts(restoreData = {}) {
    const rd = restoreData || {};
    const rows = Array.isArray(rd.params)
        ? rd.params
        : (Array.isArray(rd.customParams) ? rd.customParams : []);

    return rows
        .filter((row) => row?.key && typeof row.key === 'string')
        .map((row) => ({
            name: `param_${row.key}`,
            type: 'any',
            label: row.key
        }));
}

export const customParamsNode = {
    type: 'CustomParams',
    title: '自定义参数',
    cssClass: 'node-custom-params',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16"/><path d="M4 17h16"/><path d="M7 4v6"/><path d="M17 14v6"/></svg>',
    inputs: [],
    outputs: [{ name: 'params', type: 'params', label: '参数输出' }],
    defaultWidth: 300,
    defaultHeight: 260
};
