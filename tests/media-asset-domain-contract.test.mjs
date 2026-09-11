import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [context, sharedMediaAdr] = await Promise.all([
    readFile(new URL('../CONTEXT.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/adr/0008-shared-media-assets.md', import.meta.url), 'utf8')
]);

test('media asset documentation makes video generation a persistent media source', () => {
    assert.match(context, /Video generation nodes are Persistent media sources/i);
    assert.match(sharedMediaAdr, /Video generation nodes retain durable Media asset references/i);
    assert.match(context, /Image generation nodes do not own persistent Media asset references/i);
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
