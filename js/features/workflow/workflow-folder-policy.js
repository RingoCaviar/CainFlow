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

export function getWorkflowMoveEligibility(names, { tabs = [] } = {}) {
    const targetNames = new Set((names || []).filter(Boolean));
    const hasRunningTarget = tabs.some((tab) => tab?.running === true && targetNames.has(tab.name));
    return hasRunningTarget
        ? { allowed: false, reason: 'running' }
        : { allowed: true, reason: '' };
}

export async function persistWorkflowRenameIfEligible(names, {
    tabs = [],
    persist = async () => null
} = {}) {
    const eligibility = getWorkflowMoveEligibility(names, { tabs });
    if (!eligibility.allowed) {
        return { allowed: false, result: null, reason: eligibility.reason };
    }
    return { allowed: true, result: await persist(), reason: '' };
}

export async function persistEligibleWorkflowMoves(moves, {
    tabs = [],
    persist = async () => false,
    onMoved = () => {}
} = {}) {
    const result = { moved: [], failed: [], blocked: [] };
    for (const move of moves || []) {
        const attempt = await persistWorkflowRenameIfEligible([move?.name], {
            tabs,
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

export function hasRunningWorkflowInFolder(folderId, { folders = [], tabs = [] } = {}) {
    return !getWorkflowMoveEligibility(listWorkflowNamesInFolder(folderId, folders), { tabs }).allowed;
}

export async function moveFolderWorkflowsToRoot(folderId, {
    folders = [],
    tabs = [],
    persistMove = async () => null
} = {}) {
    const names = listWorkflowNamesInFolder(folderId, folders);
    if (!getWorkflowMoveEligibility(names, { tabs }).allowed) {
        return { allowed: false, payload: null };
    }
    return { allowed: true, payload: await persistMove() };
}
