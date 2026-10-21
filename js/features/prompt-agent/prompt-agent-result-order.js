export function orderedResultRuns(conversation = {}) {
    const entries = [...(conversation.archivedMessages || []), ...(conversation.messages || [])]
        .flatMap((message, messageIndex) => (message.runs || []).map(run => ({ run, message, messageNumber: messageIndex + 1 })));
    return entries.map((entry, index) => ({ ...entry,
        order: Number.isSafeInteger(entry.run.completionOrder) && entry.run.completionOrder > 0
            ? entry.run.completionOrder : index + 1
    }));
}

export function stampResultCompletion(conversation, run) {
    if (run.status !== 'completed' || (Number.isSafeInteger(run.completionOrder) && run.completionOrder > 0)) return;
    run.completionOrder = Math.max(0, ...orderedResultRuns(conversation).map(entry => entry.order)) + 1;
}

export function latestResultRun(conversation) {
    return orderedResultRuns(conversation).filter(({ run }) => run.status === 'completed' && run.mediaAssetKeys?.length)
        .sort((a, b) => b.order - a.order || b.messageNumber - a.messageNumber)[0]?.run || null;
}
