/**
 * 封装工作流文件相关的前后端通信。
 */

async function requestWorkflow(url, options, errorMessage) {
    try {
        const res = await fetch(url, options);
        if (!res.ok) throw new Error(errorMessage);
        return res;
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export async function fetchWorkflows() {
    const result = await requestWorkflow('/api/workflows', undefined, '读取工作流列表失败');
    if (result?.ok === false) {
        console.error(result.message);
        return [];
    }
    return result.json();
}

export async function saveWorkflowToFile(name, data) {
    const result = await requestWorkflow(
        `/api/workflows/${encodeURIComponent(name)}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        },
        '保存工作流失败'
    );
    return result?.ok === false ? result : true;
}

export async function loadWorkflowFromFile(name) {
    const result = await requestWorkflow(
        `/api/workflows/${encodeURIComponent(name)}`,
        undefined,
        '读取工作流文件失败'
    );
    return result?.ok === false ? result : result.json();
}

export async function deleteWorkflowFile(name) {
    const result = await requestWorkflow(
        `/api/workflows/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
        '删除工作流失败'
    );
    return result?.ok === false ? result : true;
}

export async function renameWorkflowFile(oldName, newName) {
    const result = await requestWorkflow(
        `/api/workflows/${encodeURIComponent(oldName)}`,
        {
            method: 'POST',
            headers: { 'x-rename-to': encodeURIComponent(newName) }
        },
        '重命名工作流失败'
    );
    return result?.ok === false ? result : true;
}
