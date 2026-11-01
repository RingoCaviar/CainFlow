import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';
const session={autoCheckUpdatesOnLoad:false,models:[{id:'chat',name:'test',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'test',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[],connections:[]};
test('clear history reports completed and failed file deletions while requests are pending', {timeout:30000}, async()=>{
 await withAppBrowser(session,async app=>{
  const image=await readFile(new URL('./fixtures/reference-red.png',import.meta.url));
  for(let i=0;i<3;i++)await writeFile(join(app.server.dataDir,'exports',`${i}.png`),image);
  await app.evaluate(`window.confirm=()=>true;window.deleteCalls=0;window.releaseDelete=null;const realFetch=fetch;window.fetch=async(url,options={})=>{if(String(url).startsWith('/api/storage/library/')&&options.method==='DELETE'){const call=++window.deleteCalls;await new Promise(r=>window.releaseDelete=r);if(call===2)return new Response(JSON.stringify({error:'controlled failure'}),{status:400})}return realFetch(url,options)};document.getElementById('btn-history').click()`);
  await app.waitFor("document.querySelectorAll('#history-list .history-card').length===3");
  await app.evaluate("document.getElementById('btn-clear-history').click()");
  await app.waitFor('window.deleteCalls===1');
  assert.equal(await app.evaluate("!!document.querySelector('.history-delete-progress[open]')"),true);
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),0);
  assert.equal(await app.evaluate("import('/js/features/history/history-delete-progress.js').then(async m=>{try{await m.deleteHistoryWithProgress([{id:1}],()=>{throw new Error('unexpected delete')});return false}catch(e){return e.message.includes('正在删除')}})"),true);
  await app.evaluate('window.releaseDelete()');await app.waitFor('window.deleteCalls===2');
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),1);
  await app.evaluate('window.releaseDelete()');await app.waitFor('window.deleteCalls===3');
  await app.evaluate('window.releaseDelete()');
  await app.waitFor("document.querySelector('.history-delete-progress button')?.disabled===false");
  assert.equal(await app.evaluate("document.querySelector('.history-delete-progress progress').value"),3);
  assert.match(await app.evaluate("document.querySelector('.history-delete-progress').innerText"),/已删除 2.*失败 1/s);
  assert.equal((await readdir(join(app.server.dataDir,'exports'))).length,1);
 },{initScript:'window.confirm=()=>true;'});
});
