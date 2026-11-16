function unquote(value) {
    const text = (value || '').trim();
    const match = text.match(/^(?:「([\s\S]*)」|『([\s\S]*)』|“([\s\S]*)”|"([\s\S]*)")$/);
    return match ? match.slice(1).find(part => part !== undefined).trim() : text;
}

export function parseAgentAppRequest(value) {
    const text = String(value || '').trim().replace(/^(?:(?:请(?:帮我)?|帮我|麻烦(?:帮我)?|直接)\s*)+/, '');
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
    if (/^(?:查看|列出)(?:已保存的?提示词|提示词库)[。！!]?$/.test(text)) return { method: 'list_prompts', args: { limit: 10 } };
    const prompt = text.match(/^(?:保存|收藏)(?:到提示词库的?)?\s*提示词\s*(「[^」]+」|『[^』]+』|“[^”]+”|"[^"]+"|[^：:\r\n]+?)\s*[：:]\s*([\s\S]+)$/);
    if (prompt) return { method: 'save_prompt', args: { name: unquote(prompt[1]), content: unquote(prompt[2]) } };
    const promptToLibrary = text.match(/^把(?:提示词)?\s*(「[\s\S]*?」|『[\s\S]*?』|“[\s\S]*?”|"[\s\S]*?")\s*(?:保存|存|加入)(?:到|进)?提示词库[，,\s]*(?:命名为|名称为|名为|叫做?)\s*(.+?)[。！!]?$/);
    if (promptToLibrary) return { method: 'save_prompt', args: { name: unquote(promptToLibrary[2]), content: unquote(promptToLibrary[1]) } };
    return null;
}

export async function runAgentAppRequest({ method, args }, actions, options) {
    if (method === 'annotate_history') {
        const { items } = await actions.dispatch('list_history', { ...(args.id !== undefined ? { id: args.id } : {}), limit: 1 }, options);
        const item = args.id !== undefined ? items.find(candidate => candidate.id === args.id) : items[0];
        if (!item) throw new Error('当前保存目录里找不到这张历史图片。');
        const result = await actions.dispatch(method, { id: item.id, fileVersion: item.fileVersion, note: args.note }, options);
        return result.note ? '已保存历史图片备注「' + result.note + '」。' : '已清空历史图片备注。';
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
