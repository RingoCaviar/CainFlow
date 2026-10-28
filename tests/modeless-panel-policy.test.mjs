import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelManager } from '../js/features/ui/panel-manager.js';

test('only parameters and Agent coexist while all other primary openings close parameters through its lifecycle', () => {
    const manager = createPanelManager({ getElementById: () => null, addEventListener() {} });
    const closed = [];
    for (const key of Object.keys(manager.panels)) manager.register(key, { close: () => closed.push(key) });
    const unregister = manager.registerAuxiliary('parameters', { close: () => closed.push('parameters') });
    manager.beforeOpen('agent');
    assert.equal(closed.includes('parameters'), false);
    assert.equal(closed.includes('agent'), false);
    assert.equal(closed.length, 6);
    closed.length = 0;
    manager.beforeOpen('parameters');
    assert.equal(closed.includes('agent'), false);
    assert.equal(closed.includes('parameters'), false);
    assert.equal(closed.length, 6);
    for (const key of Object.keys(manager.panels).filter(key => key !== 'agent')) {
        closed.length = 0;
        manager.beforeOpen(key);
        assert.ok(closed.includes('parameters'), key);
        assert.ok(closed.includes('agent'), key);
        assert.equal(closed.includes(key), false);
    }
    closed.length = 0;
    manager.closeAll();
    assert.ok(closed.includes('parameters'));
    assert.equal(Object.keys(manager.panels).length, 7, 'auxiliary surfaces do not change the primary compatibility matrix');
    unregister(); closed.length = 0;
    manager.beforeOpen('history');
    assert.equal(closed.includes('parameters'), false);
});
