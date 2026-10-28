import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDetails, sanitizeRequestUrl } from '../js/services/api-client.js';

test('complete serialized request details retain the response after a URL query credential', () => {
    const original = { url: 'https://controlled.test/v1?key=fixture-secret', requestBody: { prompt: 'retain request' },
        responseBody: 'failure-'.repeat(300) + 'FULL_RESPONSE_END' };
    const full = sanitizeDetails(JSON.stringify(original), { truncate: false });
    assert.equal(full.includes('fixture-secret'), false);
    const parsed = JSON.parse(full);
    assert.equal(parsed.requestBody.prompt, original.requestBody.prompt);
    assert.equal(parsed.responseBody, original.responseBody);
});
test('query redaction stops at URL boundaries in plain logs instead of consuming the next log record', () => {
    const full = sanitizeDetails('Request https://controlled.test/?api-key=fixture-secret\nResponse: FULL_RESPONSE_END', { truncate: false });
    assert.equal(full.includes('fixture-secret'), false);
    assert.ok(full.includes('\nResponse: FULL_RESPONSE_END'));
    assert.equal(sanitizeRequestUrl('"https://controlled.test/?key=fixture-secret", "response": "kept"'),
        '"https://controlled.test/?key=[REDACTED]", "response": "kept"');
});
test('serialized details retain header redaction and encoded or backslash credentials stay entirely masked', () => {
    const full = sanitizeDetails(JSON.stringify({ url: 'https://controlled.test/?key=fixture\\secret%22%20',
        headers: { Authorization: 'Bearer fixture-token' }, responseBody: 'retained' }), { truncate: false });
    assert.equal(full.includes('fixture'), false);
    assert.equal(JSON.parse(full).headers.Authorization, '[REDACTED]');
    assert.equal(JSON.parse(full).responseBody, 'retained');
});
