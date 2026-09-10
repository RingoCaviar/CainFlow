import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [context, sharedMediaAdr] = await Promise.all([
    readFile(new URL('../CONTEXT.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/adr/0008-shared-media-assets.md', import.meta.url), 'utf8')
]);

test('media asset documentation excludes generation nodes from durable ownership', () => {
    assert.match(context, /Generation nodes do not own persistent Media asset references/i);
    assert.match(sharedMediaAdr, /Generation nodes do not retain durable Media asset references/i);
    assert.doesNotMatch(context, /Generation nodes and history records may reference the same Media asset/i);
    assert.doesNotMatch(sharedMediaAdr, /durable references from generation nodes and history records/i);
});

test('media asset documentation preserves shared-reference lifetime protection', () => {
    assert.match(context, /remains until its last persistent reference is removed/i);
    assert.match(sharedMediaAdr, /survives while at least one durable reference remains/i);
});

test('media asset documentation makes declared node capabilities authoritative for image-result persistence', () => {
    assert.match(context, /declared media capabilities are the authority.*image result is transient or persistently recoverable/i);
    assert.match(sharedMediaAdr, /declared media capabilities are the authority.*image result is transient or persistently recoverable/i);
});

test('media asset documentation preserves ownership and ordered batches across background projection', () => {
    assert.match(context, /background projection does not change.*ownership/i);
    assert.match(context, /complete ordered media batch/i);
    assert.match(sharedMediaAdr, /background projection does not change.*ownership/i);
    assert.match(sharedMediaAdr, /complete ordered media batch/i);
});
