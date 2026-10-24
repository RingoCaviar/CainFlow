import assert from 'node:assert/strict';
import test from 'node:test';
import { runUiFixture } from './helpers/ui-browser-fixture.mjs';

test('notifications stay clear of canvas navigation and its expanded search', async () => {
    for (const windowSize of ['1280,960', '760,600']) {
        const { normal, searching, withPanel, withSettings } = await runUiFixture('tests/fixtures/toast-canvas-navigation.html', { windowSize });
        assert.ok(normal.toastBottom <= normal.navTop - 8, JSON.stringify({ windowSize, normal }));
        assert.ok(searching.toastBottom <= searching.searchTop - 8, JSON.stringify({ windowSize, searching }));
        assert.ok(withPanel.toastBottom <= withPanel.navTop - 8, JSON.stringify({ windowSize, withPanel }));
        assert.ok(withSettings.settingsBottom >= 128, JSON.stringify({ windowSize, withSettings }));
    }
});
