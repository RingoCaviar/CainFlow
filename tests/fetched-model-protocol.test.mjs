import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(
    new URL('../js/features/settings/fetched-model-protocol.js', import.meta.url),
    'utf8'
);
const { inferFetchedModelProtocol } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

function createProviderSettings(fetchProtocol = 'openai') {
    return {
        getModelFetchProtocol: () => fetchProtocol,
        isTtapiEndpoint: (endpoint) => endpoint === 'https://api.ttapi.org',
        isTtapiOpenAiEndpoint: (endpoint) => endpoint === 'https://api.ttapi.io'
    };
}

test('uses the provider API format instead of guessing from model names', () => {
    const settings = createProviderSettings('openai');
    for (const id of ['gemini-2.5-pro', 'doubao-seedance-video', 'nana-banana-pro']) {
        assert.equal(
            inferFetchedModelProtocol({ endpoint: 'https://relay.example/v1', type: 'openai' }, { id }, settings),
            'openai'
        );
    }
});

test('uses model-family keywords only as a fallback for providers without a format', () => {
    const settings = createProviderSettings('openai');
    assert.equal(inferFetchedModelProtocol({}, { id: 'gemini-2.5-pro' }, settings), 'google');
    assert.equal(inferFetchedModelProtocol({}, { id: 'nano-banana-pro' }, settings), 'google');
    assert.equal(inferFetchedModelProtocol({}, { id: 'gpt-5.1' }, settings), 'openai');
    assert.equal(inferFetchedModelProtocol({}, { id: 'o3-mini' }, settings), 'openai');
});

test('honors one unambiguous supported endpoint type returned by the provider', () => {
    const settings = createProviderSettings('openai');
    assert.equal(inferFetchedModelProtocol({}, {
        id: 'model-via-gemini',
        raw: { supported_endpoint_types: ['gemini'] }
    }, settings), 'google');
    assert.equal(inferFetchedModelProtocol({}, {
        id: 'video-model',
        raw: { supported_endpoint_types: ['/v1/videos'] }
    }, settings), 'veo-openai');
});

test('keeps nano-banana on the Google Gemini format when generic metadata labels it async', () => {
    const settings = createProviderSettings('openai');
    assert.equal(inferFetchedModelProtocol({}, {
        id: 'nano-banana-pro',
        raw: { supported_endpoint_types: ['newapi-image-async'] }
    }, settings), 'google');
});

test('prefers the provider format when metadata advertises several formats', () => {
    const settings = createProviderSettings('openai');
    assert.equal(inferFetchedModelProtocol({}, {
        supported_endpoint_types: ['gemini', 'openai']
    }, settings), 'openai');
});

test('keeps endpoint-specific TTAPI formats authoritative', () => {
    const settings = createProviderSettings('openai');
    assert.equal(inferFetchedModelProtocol(
        { endpoint: 'https://api.ttapi.io' },
        { supported_endpoint_types: ['gemini'] },
        settings
    ), 'ttapi-openai');
});
