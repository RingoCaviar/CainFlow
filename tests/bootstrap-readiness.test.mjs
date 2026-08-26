import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStartupControllerApi } from '../js/features/app/startup-controller.js';

test('application bootstrap publishes readiness only after initialization completes', async () => {
    const globalRef = {};
    const events = [];
    const { bootstrapCainFlowApp } = await import(`../js/app/bootstrap.js?success=${Date.now()}`);

    const instance = await bootstrapCainFlowApp({
        globalRef,
        hydrateDiskStorageRef: async () => { events.push('storage'); },
        initializeDesktopBridgeRef: async () => { events.push('desktop'); },
        themeBootstrapPromise: Promise.resolve().then(() => { events.push('theme'); }),
        loadApplication: async () => ({
            initializeCainFlowApp: () => { events.push('application'); return { initialized: true }; }
        })
    });

    assert.deepEqual(instance, { initialized: true });
    assert.equal(globalRef.__cainflowAppReady, true);
    assert.equal(globalRef.__cainflowBootstrapError, undefined);
    assert.deepEqual(new Set(events.slice(0, 3)), new Set(['storage', 'desktop', 'theme']));
    assert.equal(events[3], 'application');
});

test('application bootstrap does not publish readiness while workflow activation is pending', async () => {
    const globalRef = {};
    const previousWindow = globalThis.window;
    globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} };
    const events = [];
    let markStateRestorationStarted;
    let finishStateRestoration;
    let finishWorkflowActivation;
    const stateRestorationStarted = new Promise((resolve) => {
        markStateRestorationStarted = resolve;
    });
    const stateRestoration = new Promise((resolve) => {
        finishStateRestoration = resolve;
    });
    const workflowActivation = new Promise((resolve) => {
        finishWorkflowActivation = resolve;
    });
    const { bootstrapCainFlowApp } = await import(`../js/app/bootstrap.js?pending=${Date.now()}`);

    const bootstrapPromise = bootstrapCainFlowApp({
        globalRef,
        hydrateDiskStorageRef: async () => {},
        initializeDesktopBridgeRef: async () => {},
        loadApplication: async () => ({
            initializeCainFlowApp: () => {
                const startupController = createStartupControllerApi({
                    state: { nodes: new Map() },
                    initUI: () => { events.push('ui'); },
                    loadState: async () => {
                        events.push('state-started');
                        markStateRestorationStarted();
                        await stateRestoration;
                        events.push('state-restored');
                        return true;
                    },
                    ensureOpenWorkflow: async () => {
                        events.push('activation-started');
                        await workflowActivation;
                        events.push('activation-finished');
                    },
                    initLogs: () => {},
                    showToast: () => {},
                    syncProxyToServer: () => {},
                    updateCanvasTransform: () => {},
                    scheduleAutoUpdateCheck: () => {},
                    checkRefreshNotice: () => {},
                    documentRef: { readyState: 'complete', getElementById: () => null },
                    consoleRef: { log: () => {}, error: () => {} }
                });
                return startupController.initStartup().then(() => ({ initialized: true }));
            }
        })
    });

    await stateRestorationStarted;
    assert.deepEqual(events, ['ui', 'state-started']);
    assert.notEqual(globalRef.__cainflowAppReady, true);

    finishStateRestoration();
    while (!events.includes('activation-started')) await Promise.resolve();
    assert.notEqual(globalRef.__cainflowAppReady, true);

    try {
        finishWorkflowActivation();
        assert.deepEqual(await bootstrapPromise, { initialized: true });
        assert.equal(globalRef.__cainflowAppReady, true);
    } finally {
        globalThis.window = previousWindow;
    }
});

test('application assembly waits for the real startup controller contract', () => {
    const source = readFileSync(new URL('../js/app/bootstrap-impl.js', import.meta.url), 'utf8');

    assert.match(source, /const startupPromise = getStartupControllerApi\(\)\.initStartup\(\);/);
    assert.match(source, /await startupPromise;[\s\S]*return \{/);
});

test('application bootstrap publishes its initialization failure', async () => {
    const globalRef = {};
    const { bootstrapCainFlowApp } = await import(`../js/app/bootstrap.js?failure=${Date.now()}`);

    await assert.rejects(bootstrapCainFlowApp({
        globalRef,
        hydrateDiskStorageRef: async () => {},
        initializeDesktopBridgeRef: async () => {},
        loadApplication: async () => { throw new SyntaxError('broken application module'); }
    }), /broken application module/);

    assert.equal(globalRef.__cainflowAppReady, false);
    assert.equal(
        globalRef.__cainflowBootstrapError,
        'SyntaxError: broken application module'
    );
});
