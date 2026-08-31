export function listWorkflowNamesInFolder(folderId, folders = []) {
    const names = new Set();
    for (const folder of folders) {
        if (folder?.id !== folderId && !folder?.id?.startsWith(`${folderId}/`)) continue;
        for (const name of folder.items || []) {
            if (name) names.add(name);
        }
    }
    return Array.from(names);
}

export function getWorkflowMoveEligibility(names, { runningWorkflowNames = [] } = {}) {
    const targetNames = new Set((names || []).filter(Boolean));
    const runningNames = typeof runningWorkflowNames === 'function'
        ? runningWorkflowNames()
        : runningWorkflowNames;
    const hasRunningTarget = (runningNames || []).some((name) => targetNames.has(name));
    return hasRunningTarget
        ? { allowed: false, reason: 'running' }
        : { allowed: true, reason: '' };
}

export async function persistWorkflowRenameIfEligible(names, {
    runningWorkflowNames = [],
    persist = async () => null
} = {}) {
    const eligibility = getWorkflowMoveEligibility(names, { runningWorkflowNames });
    if (!eligibility.allowed) {
        return { allowed: false, result: null, reason: eligibility.reason };
    }
    return { allowed: true, result: await persist(), reason: '' };
}

export async function persistEligibleWorkflowMoves(moves, {
    runningWorkflowNames = [],
    persist = async () => false,
    onMoved = () => {}
} = {}) {
    const result = { moved: [], failed: [], blocked: [] };
    for (const move of moves || []) {
        const attempt = await persistWorkflowRenameIfEligible([move?.name], {
            runningWorkflowNames,
            persist: () => persist(move)
        });
        if (!attempt.allowed) {
            result.blocked.push(move);
        } else if (attempt.result) {
            result.moved.push(move);
            onMoved(move);
        } else {
            result.failed.push(move);
        }
    }
    return result;
}

export function hasRunningWorkflowInFolder(folderId, { folders = [], runningWorkflowNames = [] } = {}) {
    return !getWorkflowMoveEligibility(listWorkflowNamesInFolder(folderId, folders), { runningWorkflowNames }).allowed;
}

export async function moveFolderWorkflowsToRoot(folderId, {
    folders = [],
    runningWorkflowNames = [],
    persistMove = async () => null
} = {}) {
    const names = listWorkflowNamesInFolder(folderId, folders);
    if (!getWorkflowMoveEligibility(names, { runningWorkflowNames }).allowed) {
        return { allowed: false, payload: null };
    }
    return { allowed: true, payload: await persistMove() };
}
