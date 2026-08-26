export async function removeWorkflowTabsTransaction({
    tabs = [],
    names = [],
    activeWorkflowName = '',
    activateFallback = async () => true,
    rollbackFallback = async () => false,
    persistRemoval = async (targetNames) => targetNames,
    releaseTab = () => {}
}) {
    const removingNames = new Set(names);
    const removingTabs = tabs.filter((tab) => removingNames.has(tab?.name));
    const targetNames = Array.from(removingNames).filter(Boolean);
    if (targetNames.length === 0) {
        return { removed: true, complete: true, activated: false, restored: false, removedNames: [], tabs };
    }

    const requiresFallback = removingNames.has(activeWorkflowName);
    if (requiresFallback && !(await activateFallback())) {
        return { removed: false, complete: false, activated: false, restored: false, removedNames: [], tabs };
    }

    const persistedNames = new Set(await persistRemoval(targetNames) || []);
    const restored = requiresFallback && !persistedNames.has(activeWorkflowName)
        ? await rollbackFallback() === true
        : false;
    const removedTabs = removingTabs.filter((tab) => persistedNames.has(tab.name));
    const removedNames = targetNames.filter((name) => persistedNames.has(name));
    removedTabs.forEach(releaseTab);
    return {
        removed: removedNames.length > 0,
        complete: removedNames.length === targetNames.length,
        activated: requiresFallback && !restored,
        restored,
        removedNames,
        tabs: tabs.filter((tab) => !persistedNames.has(tab?.name))
    };
}
