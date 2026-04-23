/**
 * 封装工作流文件相关的前后端通信，请求列表、保存、读取、删除与重命名等接口。
 */
export async function fetchWorkflows() {
    try {
        const res = await fetch('/api/workflows');
        if (!res.ok) throw new Error('读取工作流列表失败');
        return await res.json();
    } catch (error) {
        console.error(error);
        return [];
    }
}

export async function saveWorkflowToFile(name, data) {
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error('保存工作流失败');
        return true;
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export async function loadWorkflowFromFile(name) {
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
        if (!res.ok) throw new Error('读取工作流文件失败');
        return await res.json();
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export async function deleteWorkflowFile(name) {
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('删除工作流失败');
        return true;
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

export async function renameWorkflowFile(oldName, newName) {
    try {
        const res = await fetch(`/api/workflows/${encodeURIComponent(oldName)}`, {
            method: 'POST',
            headers: { 'x-rename-to': newName }
        });
        if (!res.ok) throw new Error('重命名失败');
        return true;
    } catch (error) {
        return { ok: false, message: error.message };
    }
}
/**
 * 封装前端对工作流后端接口的调用。
 */
