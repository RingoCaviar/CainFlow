function unquote(value) {
    const text = (value || '').trim();
    const match = text.match(/^(?:「([\s\S]*)」|『([\s\S]*)』|“([\s\S]*)”|"([\s\S]*)")$/);
    return match ? match.slice(1).find(part => part !== undefined).trim() : text;
}

export function parseAgentAppRequest(value) {
    const text = String(value || '').trim().replace(/^(?:(?:请(?:帮我)?|帮我|麻烦(?:帮我)?|直接)\s*)+/, '');
    const actionText = text.replace(/[。！!]$/, '');
    if (/^(?:运行|执行|启动)\s*(?:当前)?工作流$/.test(actionText)) return { method: 'run_canvas', args: {} };
    if (/^(?:运行|执行)\s*(?:我)?选中(?:的)?节点$/.test(actionText)) return { method: 'run_canvas', args: { selected: true } };
    const runTo = actionText.match(/^运行到\s*(.+)$/);
    if (runTo && !/[？?]$/.test(runTo[1])) return { method: 'run_canvas', args: { target: runTo[1] } };
    const namedNodeCommand = actionText.match(/^(运行|执行|停止|中止)\s*(?:节点\s*)?(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+"|@[^@\[\]\r\n]+\[[^\]\r\n]+\])(?:\s*节点)?$/);
    if (namedNodeCommand) return { method: /运行|执行/.test(namedNodeCommand[1]) ? 'run_canvas' : 'stop_workflow', args: { node: namedNodeCommand[2] } };
    if (/^(?:停止|中止)\s*(?:当前)?工作流(?:运行)?$/.test(actionText)) return { method: 'stop_workflow', args: {} };
    if (/^(?:停止|中止)\s*(?:我)?选中(?:的)?节点(?:运行)?$/.test(actionText)) return { method: 'stop_workflow', args: { selected: true } };
    if (/^(?:撤销|撤回)(?:画布)?(?:上一步(?:操作)?)?$/.test(actionText)) return { method: 'undo_canvas', args: {} };
    if (/^(?:重做(?:画布)?(?:上一步(?:操作)?)?|恢复(?:刚才|刚刚)撤销的操作)$/.test(actionText)) return { method: 'redo_canvas', args: {} };
    const create = text.match(/^(?:新建|创建)(?:一个|一份)?\s*(?:空白|空)\s*工作流(?:[，,\s]*(?:名字是|名称为|命名为|名为|叫做?|[：:])\s*(.+?))?[。！!]?$/);
    if (create) return { method: 'create_workflow', args: create[1] ? { name: unquote(create[1]) } : {} };
    const namedWorkflow = text.match(/^(?:新建|创建)(?:一个|一份)?\s*(?:名为|叫做?)\s*(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+")\s*的(?:空白|空)工作流[。！!]?$/);
    if (namedWorkflow) return { method: 'create_workflow', args: { name: unquote(namedWorkflow[1]) } };
    if (/^(?:查看|列出|打开)(?:最近的?|最新的?)?历史(?:图片|图像|图)列表[。！!]?$/.test(text)
        || /^(?:查看|列出)(?:最近的?|最新的?)?历史(?:图片|图像|图)[。！!]?$/.test(text)) return { method: 'list_history', args: { limit: 10 } };
    const note = text.match(/^(?:给|把|为)\s*(?:最新(?:的|一张)?\s*历史(?:图片|图像|图)|历史(?:图片|图像|图)\s*(?:ID\s*)?(-?\d+))\s*(?:加(?:个|上)?备注|备注(?:为)?|添加备注|修改备注(?:为)?|的备注(?:改为|设为))\s*[：:]?\s*(.+)$/i);
    if (note) return { method: 'annotate_history', args: { ...(note[1] ? { id: Number(note[1]) } : {}), note: unquote(note[2]) } };
    const clear = text.match(/^(?:清空|删除)\s*(?:最新(?:的|一张)?\s*历史(?:图片|图像|图)|历史(?:图片|图像|图)\s*(?:ID\s*)?(-?\d+))\s*(?:的)?备注[。！!]?$/i);
    if (clear) return { method: 'annotate_history', args: { ...(clear[1] ? { id: Number(clear[1]) } : {}), note: '' } };
    const historyImport = text.match(/^导入\s*历史(?:图片|图像|图)\s*(?:ID\s*)?(-?\d+(?:\s*[,，、]\s*-?\d+)*)(?:\s*(?:到|进|至)\s*(?:当前)?画布)?[。！!]?$/i)
        || text.match(/^(?:把|将)\s*历史(?:图片|图像|图)\s*(?:ID\s*)?(-?\d+(?:\s*[,，、]\s*-?\d+)*)\s*(?:导入|加入)\s*(?:(?:到|进|至)\s*)?(?:当前)?画布[。！!]?$/i);
    if (historyImport) return { method: 'import_history', args: { ids: historyImport[1].split(/[,，、]/).map(Number) } };
    if (/^(?:查看|列出)(?:已保存的?提示词|提示词库)[。！!]?$/.test(text)) return { method: 'list_prompts', args: { limit: 10 } };
    const preset = text.match(/^(?:把|将)\s*(?:(?:提示词库|库)(?:里(?:的)?|中(?:的)?|的)?\s*)?(?:提示词\s*)?(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+")\s*(?:套用|应用)(?:到|至)\s*(.+?)\s*的\s*(普通|系统)?提示词[。！!]?$/);
    if (preset) return { method: 'apply_prompt', args: { name: unquote(preset[1]), selector: preset[2].trim(),
        target: preset[3] === '系统' ? 'system' : 'prompt' } };
    const prompt = text.match(/^(?:保存|收藏)(?:到提示词库的?)?\s*提示词\s*(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+"|[^：:\r\n]+?)\s*[：:]\s*([\s\S]+)$/);
    if (prompt) return { method: 'save_prompt', args: { name: unquote(prompt[1]), content: unquote(prompt[2]) } };
    const promptToLibrary = text.match(/^把(?:提示词)?\s*(「[\s\S]*?」|『[\s\S]*?』|“[\s\S]*?”|"[\s\S]*?")\s*(?:保存|存|加入)(?:到|进)?提示词库[，,\s]*(?:命名为|名称为|名为|叫做?)\s*(.+?)[。！!]?$/);
    if (promptToLibrary) return { method: 'save_prompt', args: { name: unquote(promptToLibrary[2]), content: unquote(promptToLibrary[1]) } };
    return null;
}

function findTargetNode(context, selector) {
    if (!context?.workflowId) throw new Error('请先打开要编辑的 CainFlow 工作流。');
    if (/^(?:我)?选中(?:的)?节点$/.test(selector)) {
        const selected = context.summary.selectedIds;
        if (selected.length !== 1) throw new Error('请只选中一个目标节点，或使用 @节点 指定目标。');
        return selected[0];
    }
    const mention = selector.match(/^@[^@\[\]\r\n]+\[([^\]\r\n]+)\]$/);
    const explicitId = mention?.[1] || selector.match(/^节点\s*ID\s+(\S+)$/i)?.[1];
    const quotedName = selector.match(/^节点\s*(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+")$/)?.[1];
    const name = unquote(quotedName || selector);
    const matches = context.nodes.filter(node => explicitId ? node.id === explicitId : node.name === name);
    if (matches.length > 1) throw new Error('画布中有同名节点，请使用 @节点 或节点 ID 指定目标。');
    if (!matches.length) throw new Error('当前画布找不到指定节点。');
    return matches[0].id;
}

export async function runAgentAppRequest({ method, args }, actions, options) {
    if (method === 'run_canvas' || method === 'stop_workflow') {
        const scope = args.selected ? { nodeIds: options?.context?.summary.selectedIds || [] }
            : args.target ? { targetNodeId: findTargetNode(options?.context, args.target) }
                : args.node ? { nodeIds: [findTargetNode(options?.context, args.node)] } : {};
        const result = await actions.dispatch(method, scope, options);
        if (method === 'run_canvas') return result.started ? '已启动指定范围的运行。' : '该运行未启动，请检查画布中的节点状态。';
        return result.stopped ? '已请求停止指定范围内的运行。' : '指定范围内没有可停止的运行。';
    }
    if (method === 'undo_canvas' || method === 'redo_canvas') {
        const { changed } = await actions.dispatch(method, args, options);
        const verb = method === 'undo_canvas' ? '撤销' : '重做';
        return changed ? '已' + verb + '上一步画布操作。' : '当前无法' + verb + '画布操作，请查看画布状态。';
    }
    if (method === 'annotate_history') {
        const { items } = await actions.dispatch('list_history', { ...(args.id !== undefined ? { id: args.id } : {}), limit: 1 }, options);
        const item = args.id !== undefined ? items.find(candidate => candidate.id === args.id) : items[0];
        if (!item) throw new Error('当前保存目录里找不到这张历史图片。');
        const result = await actions.dispatch(method, { id: item.id, fileVersion: item.fileVersion, note: args.note }, options);
        return result.note ? '已保存历史图片备注「' + result.note + '」。' : '已清空历史图片备注。';
    }
    if (method === 'import_history') {
        if (args.ids.length > 20 || new Set(args.ids).size !== args.ids.length
            || args.ids.some(id => !Number.isSafeInteger(id) || id === 0)) throw new Error('请输入 1 至 20 个不同的历史图片 ID。');
        const items = [];
        for (const id of args.ids) {
            const { items: candidates } = await actions.dispatch('list_history', { id, limit: 1 }, options);
            const item = candidates.find(candidate => candidate.id === id);
            if (!item) throw new Error('当前保存目录里找不到历史图片 ' + id + '。');
            items.push({ id, fileVersion: item.fileVersion });
        }
        const result = await actions.dispatch(method, { items }, options);
        return '已导入 ' + result.imported.length + ' 张历史原图。';
    }
    if (method === 'apply_prompt') {
        const nodeId = findTargetNode(options?.context, args.selector);
        const result = await actions.dispatch(method, { nodeId, name: args.name, target: args.target }, { ...options, preview: true });
        return { message: '已找到提示词「' + result.promptName + '」，请确认后应用。', canvasPlan: result.plan };
    }
    const result = await actions.dispatch(method, args, options);
    if (method === 'create_workflow') return '已新建空白工作流「' + result.name + '」。';
    if (method === 'save_prompt') return '已保存到提示词库「' + result.name + '」。';
    if (method === 'list_history') {
        const lines = result.items.map(item => '- ' + item.id + ' · ' + (item.note || item.filename || '历史图片'));
        return lines.length ? ['当前目录最近的历史图片', ...lines].join('\n') : '当前保存目录还没有历史图片。';
    }
    const lines = result.prompts.map(prompt => '- ' + prompt.name);
    return lines.length ? ['提示词库', ...lines].join('\n') : '提示词库还没有内容。';
}
