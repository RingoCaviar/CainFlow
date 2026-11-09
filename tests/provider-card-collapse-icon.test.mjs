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

test('provider cards expose a named native disclosure tied to the card content and labelled API fields', () => {
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
    const store = { providerCollapseState: new Map() };
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
        store,
        dialogs: { escapeHtml: (value) => String(value) },
        getDeps: () => ({
            renderModels() {},
            updateAllNodeModelDropdowns() {}
        })
    });

    api.renderProviders();

    assert.equal(cards.length, 1);
    const markup = cards[0].innerHTML;
    assert.match(markup, /<button type="button" class="card-btn-disclosure"[^>]+aria-expanded="false"[^>]+aria-controls="provider-provider-test-details"[^>]+aria-label="展开供应商配置：Test provider"/);
    assert.match(markup, /class="card-collapsible" id="provider-provider-test-details" style="display:none;/);
    assert.match(markup, /class="card-disclosure-icon"[^>]+viewBox="0 0 24 24"/);
    for (const field of ['apikey', 'endpoint', 'responses-endpoint']) {
        assert.ok(markup.includes(`for="provider-provider-test-${field}"`));
        assert.ok(markup.includes(`<input id="provider-provider-test-${field}"`));
    }
    assert.match(markup, /<input id="provider-provider-test-apikey" type="password"/);

    store.providerCollapseState.set(provider.id, false);
    api.renderProviders();
    assert.match(cards[1].innerHTML, /aria-expanded="true"[^>]+aria-controls="provider-provider-test-details"[^>]+aria-label="收起供应商配置：Test provider"/);
});
