import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsCloseCoordinator } from '../js/features/settings/settings-close-coordinator.js';

test('an incomplete model compatibility configuration blocks closing before side effects', () => {
    const events = [];
    const models = [
        { id: 'valid', protocol: 'google' },
        { id: 'missing', name: 'Unknown Image', protocol: '' },
        { id: 'obsolete', protocol: 'removed-format' }
    ];
    const coordinator = createSettingsCloseCoordinator({
        getModels: () => models,
        isKnownModelProtocol: (protocol) => protocol === 'google' || protocol === 'openai',
        guideIncompleteModel: (model, count) => events.push(`guide:${model.id}:${count}`),
        closeSettingsOverlays: () => events.push('overlays-closed'),
        closeSettingsModal: () => events.push('modal-closed'),
        pauseNotificationAudio: () => events.push('audio-paused')
    });

    assert.deepEqual(coordinator.requestCloseSettings(), {
        closed: false,
        incompleteModelCount: 2,
        firstIncompleteModelId: 'missing'
    });
    assert.deepEqual(events, ['guide:missing:2']);
});

test('a valid or lifecycle-bypassed close commits every closing side effect', () => {
    for (const requestOptions of [undefined, { bypassValidation: true }]) {
        const events = [];
        const models = requestOptions ? [{ id: 'missing', protocol: '' }] : [{ id: 'valid', protocol: 'google' }];
        const coordinator = createSettingsCloseCoordinator({
            getModels: () => models,
            isKnownModelProtocol: (protocol) => protocol === 'google',
            guideIncompleteModel: () => events.push('guided'),
            closeSettingsOverlays: () => events.push('overlays-closed'),
            closeSettingsModal: () => events.push('modal-closed'),
            pauseNotificationAudio: () => events.push('audio-paused')
        });

        assert.equal(coordinator.requestCloseSettings(requestOptions).closed, true);
        assert.deepEqual(events, ['overlays-closed', 'modal-closed', 'audio-paused']);
    }
});

test('Escape closes one settings overlay before attempting to close model settings', () => {
    const events = [];
    let overlayOpen = true;
    const coordinator = createSettingsCloseCoordinator({
        getModels: () => [{ id: 'missing', protocol: '' }],
        isKnownModelProtocol: () => false,
        guideIncompleteModel: () => events.push('guided'),
        closeTopSettingsOverlay: () => {
            if (!overlayOpen) return false;
            overlayOpen = false;
            events.push('top-overlay-closed');
            return true;
        },
        closeSettingsOverlays: () => events.push('all-overlays-closed'),
        closeSettingsModal: () => events.push('modal-closed'),
        pauseNotificationAudio: () => events.push('audio-paused')
    });

    assert.deepEqual(coordinator.handleEscape(), { closed: false, overlayClosed: true });
    assert.deepEqual(events, ['top-overlay-closed']);

    assert.equal(coordinator.handleEscape().closed, false);
    assert.deepEqual(events, ['top-overlay-closed', 'guided']);
});
