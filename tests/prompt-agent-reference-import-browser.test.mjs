import assert from 'node:assert/strict';
import test from 'node:test';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';
test('local and history references import once, preserve order and survive node deletion',async()=>{
 const result=await runUiFixture('tests/fixtures/prompt-agent-reference-import.html');
 assert.equal(result.error,undefined);assert.equal(Object.keys(result).length,25);assert.ok(Object.values(result).every(x=>x===true));
});
