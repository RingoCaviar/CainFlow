import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderSettings } from '../js/features/settings/provider-settings.js';

function createElement() {
    return {
        className: '',
        classList: { contains: () => false, add() {}, remove() {} },
        dataset: {},
        innerHTML: '',
        addEventListener() {},
        querySelector() { return null; }
    };
}

test('provider cards expose header folding without a dedicated collapse icon', () => {
    const cards = [];
    const providersList = {
        innerHTML: '',
        appendChild(card) { cards.push(card); },
        querySelectorAll() { return []; }
    };
    const provider = {
        id: 'provider-test',
        name: 'Test provider',
        type: 'openai',
        apikey: '',
        endpoint: 'https://example.com',
        autoComplete: true
    };
    const api = createProviderSettings({
        ctx: {
            state: { providers: [provider], models: [] },
            providersList,
            documentRef: {
                createElement,
                getElementById() { return null; },
                addEventListener() {},
                removeEventListener() {}
            },
            windowRef: { setTimeout() {}, getComputedStyle() { return {}; } },
            showToast() {},
            saveState() {}
        },
        store: { providerCollapseState: new Map() },
        dialogs: {},
        getDeps: () => ({
            renderModels() {},
            updateAllNodeModelDropdowns() {}
        })
    });

    api.renderProviders();

    assert.equal(cards.length, 1);
    assert.doesNotMatch(cards[0].innerHTML, /card-btn-collapse/);
});
