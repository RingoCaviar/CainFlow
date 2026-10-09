import test from 'node:test';
import assert from 'node:assert/strict';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';
test('prompt search preserves order and keeps selection, deletion and editing scoped correctly',async()=>{
 const r=await runUiFixture('tests/fixtures/prompt-library-search.html');
 assert.deepEqual(r.matches,['a','b']);assert.match(r.summary,/找到 2 \/ 共 3 条/);
 assert.deepEqual(r.unmodified,['a','b','c']);assert.deepEqual(r.contentMatch,['c']);assert.match(r.empty,/没有匹配/);
 assert.deepEqual(r.clear,['a','b','c']);assert.deepEqual(r.selected,['a','b']);assert.ok(r.resetSelection);
 assert.deepEqual(r.remaining,['a','b']);assert.ok(r.editorInside);assert.equal(r.edited,'已修改');assert.ok(r.escapedSearch);
});
