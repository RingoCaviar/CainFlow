import test from 'node:test';
import assert from 'node:assert/strict';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';

test('node picker searches, adds at the requested location, tracks successes and supports keyboard close',async()=>{
    const result=await runUiFixture('tests/fixtures/node-picker.html');
    assert.deepEqual(result.filtered,['图片生成']);
    assert.deepEqual(result.added[0],{type:'ImageGenerate',x:110,y:200});
    assert.equal(result.added.length,3);
    assert.equal(result.added[1].type,'Text');
    assert.equal(result.keyboardType,'TextMerge');
    assert.equal(result.added[2].type,'TextMerge');
    assert.ok(result.compositionSafe);
    assert.ok(result.closed && result.escaped && result.failStaysOpen && result.noFailedRecent);
    assert.match(result.recent,/最近使用/);
    assert.match(result.noResults,/没有匹配/);
});
