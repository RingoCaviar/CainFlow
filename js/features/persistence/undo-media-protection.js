import { getSnapshotMediaKeys } from './snapshot-media-keys.js';

// History creation is synchronous across canvas controls. Only the small local
// protection transaction is synchronous; release and physical cleanup are async.
export function createUndoMediaProtection({ requestSync, request, pageId = crypto.randomUUID(), onError = () => {} } = {}) {
    let ending = false;
    const pending = new Set();
    function protect(snapshot, workflowId) {
        if (ending) throw new Error('正在退出，不能创建撤销记录');
        const assetKeys = [...new Set((snapshot.nodes || []).flatMap(getSnapshotMediaKeys))];
        if (!assetKeys.length) return;
        try {
            requestSync({ action: 'protect', pageId, recordId: snapshot.historyId, workflowId, assetKeys });
        } catch (error) {
            onError(error); throw new Error('撤销图片保护失败，未执行操作，请重试');
        }
    }
    function release(snapshot) {
        if (!snapshot?.historyId) return Promise.resolve();
        const operation = request({ action: 'release', pageId, recordIds: [snapshot.historyId] });
        pending.add(operation);
        return operation.catch(onError).finally(() => pending.delete(operation));
    }
    async function end() {
        ending = true;
        await Promise.allSettled([...pending]);
        return request({ action: 'end', pageId });
    }
    return { protect, release, end };
}

export function createBrowserUndoMediaProtection(onError) {
    const url = '/api/storage/undo-session';
    return createUndoMediaProtection({ onError,
        requestSync: body => {
            const xhr = new XMLHttpRequest(); xhr.open('POST', url, false);
            xhr.setRequestHeader('Content-Type', 'application/json'); xhr.send(JSON.stringify(body));
            if (xhr.status < 200 || xhr.status >= 300) throw new Error('本地媒体保护事务失败');
            return JSON.parse(xhr.responseText);
        },
        request: async body => {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error('撤销缓存释放失败，将在退出或下次启动重试');
            return response.json();
        }
    });
}
