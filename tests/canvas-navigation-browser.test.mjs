import test from 'node:test';
import assert from 'node:assert/strict';
import {runUiFixture} from './helpers/ui-browser-fixture.mjs';
test('canvas navigation preserves zoom anchor and locates only current workflow nodes',async()=>{
 const r=await runUiFixture('tests/fixtures/canvas-navigation.html');
 assert.equal(r.plus,1.2);assert.equal(r.percent,'120%');assert.ok(r.anchorPreserved);
 assert.equal(r.preset,.5);assert.ok(r.presetAnchor);assert.ok(r.zoomKeyboard);
 assert.equal(r.reset,1);assert.equal(r.fitCount,2);assert.equal(r.focused,'b');
 assert.equal(r.found.length,2);assert.match(r.found[0],/运行中/);
 assert.deepEqual(r.current,['c']);assert.ok(r.shortcutSafe && r.closed);
 assert.ok(r.projectionKeptResults);assert.ok(r.renamedRunning);
 assert.equal(r.wheels,0);assert.equal(r.maximum,5);assert.equal(r.minimum,.1);assert.ok(r.saves>0);
});
