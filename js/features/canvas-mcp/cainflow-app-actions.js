const appActionArguments = {
    create_workflow: ['name'],
    list_history: ['id', 'offset', 'limit'],
    annotate_history: ['id', 'fileVersion', 'note'],
    list_prompts: ['query', 'offset', 'limit'],
    save_prompt: ['name', 'content']
};

export function createCainflowAppActions({ createEmptyWorkflow, listHistoryImages, annotateHistoryImage, promptLibrary, onHistoryNote = () => {} }) {
    const supports = method => Object.hasOwn(appActionArguments, method);

    async function dispatch(method, args = {}, { isCurrent = () => true } = {}) {
        if (!supports(method)) throw new Error('未知的 CainFlow 应用操作。');
        if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !appActionArguments[method].includes(key))) throw new Error('CainFlow 应用操作参数无效。');
        if (!isCurrent()) throw new Error('CainFlow 会话已变化，请重新发起操作。');
        if (method === 'create_workflow') return createEmptyWorkflow({ name: args.name, isCurrent });
        if (method === 'list_history') return listHistoryImages(args);
        if (method === 'annotate_history') {
            const result = await annotateHistoryImage(args, { isCurrent });
            // The metadata is persisted at this point. A display refresh can fail independently.
            void Promise.resolve().then(() => onHistoryNote(result)).catch(() => {});
            return result;
        }
        if (method === 'list_prompts') return promptLibrary().listPrompts(args);
        return promptLibrary().upsertPrompt(args, { isCurrent });
    }
    return { supports, dispatch };
}
