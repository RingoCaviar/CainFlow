import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withAppBrowser} from './helpers/app-browser.mjs';
const original='data:image/png;base64,'+(await readFile(new URL('./fixtures/reference-red.png',import.meta.url))).toString('base64');
const session={autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']},{id:'image',modelId:'gpt-image-1',protocol:'openai-image',taskType:'image',providerIds:['p']}],providers:[{id:'p',endpoint:'https://controlled.test/v1',apikey:'test'}],nodes:[{id:'url-import',type:'ImageImport',x:50,y:40},{id:'target',type:'ImageGenerate',x:440,y:40,apiConfigId:'image',providerId:'p'}],connections:[{id:'url-edge',from:{nodeId:'url-import',port:'image'},to:{nodeId:'target',port:'referenceImages'},type:'image',order:0}]};
test('a URL reference displays and opens the active URL while keeping its inactive uploaded original intact',{timeout:30000},async()=>{
 await withAppBrowser(session,async app=>{
  await app.evaluate(`(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await fetch(${JSON.stringify(original)})).blob()],'original.png',{type:'image/png'}));const file=document.getElementById('url-import-file');file.files=transfer.files;file.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='url-import')?.mediaAssetKeys?.length===1)");
  const keys=await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='url-import').mediaAssetKeys)");
  const url=app.server.baseUrl+'/tests/fixtures/reference-blue.png';
  await app.evaluate(`document.getElementById('url-import').click();document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=url]').click();(()=>{const field=document.getElementById('url-import-url-input');field.value=${JSON.stringify(url)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))})();document.getElementById('target').click();document.querySelector('#image-parameter-panel [data-parameter-group-toggle=reference]').click()`);
  await app.waitFor("document.querySelectorAll('#target-reference-sources [data-reference-number]').length===1");
  await app.evaluate("document.querySelector('#target-reference-sources [data-reference-number]').click()");
  await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
  assert.equal(await app.evaluate("document.querySelector('.fullscreen-overlay img').src"),url,'the inactive uploaded image is never substituted for the URL');
  await app.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await app.waitFor("!document.querySelector('.fullscreen-overlay')");
  await app.evaluate("document.getElementById('url-import').click();document.querySelector('#image-parameter-panel .image-import-mode-btn[data-mode=upload]').click()");
  await app.waitFor("!document.getElementById('url-import-upload-section').classList.contains('hidden')");
  await app.evaluate("document.getElementById('url-import-drop').click()");
  await app.waitFor("Boolean(document.querySelector('.fullscreen-overlay img'))");
  assert.equal(await app.evaluate(`document.querySelector('.fullscreen-overlay img').src===${JSON.stringify(original)}`),true,'switching back restores the uploaded original');
  assert.deepEqual(await app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.nodes.find(n=>n.id==='url-import').mediaAssetKeys)"),keys);
 });
});
