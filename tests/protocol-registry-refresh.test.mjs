import assert from 'node:assert/strict';
import test from 'node:test';

import { createProtocolRegistryRefreshHandler } from '../js/app/bootstrap/settings-bootstrap.js';

test('protocol registry loading refreshes existing video generation cards', () => {
    const events = [];
    const refresh = createProtocolRegistryRefreshHandler({
        renderModels: () => events.push('models'),
        updateAllNodeModelDropdowns: () => events.push('dropdowns'),
        refreshVideoGenerateNodes: () => events.push('video-cards')
    });

    refresh();

    assert.deepEqual(events, ['models', 'dropdowns', 'video-cards']);
});
