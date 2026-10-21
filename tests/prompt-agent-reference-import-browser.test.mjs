import assert from 'node:assert/strict';
import test from 'node:test';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';
test('reference imports preserve order, explicit canvas deletion removes references and Agent removal keeps nodes',async()=>{
 const result=await runUiFixture('tests/fixtures/prompt-agent-reference-import.html');
 assert.equal(result.error,undefined);assert.equal(Object.keys(result).length,29);assert.ok(Object.values(result).every(x=>x===true));
});
