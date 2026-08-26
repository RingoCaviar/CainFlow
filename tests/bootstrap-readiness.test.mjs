import test from 'node:test';
import assert from 'node:assert/strict';

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
