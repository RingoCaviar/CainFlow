import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser, delay} from './helpers/app-browser.mjs';
const session={autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',name:'chat',protocol:'openai',taskType:'chat',providerIds:['p']},{id:'image',modelId:'gpt-image-1',name:'image',protocol:'openai-image',taskType:'image',providerIds:['p']}],providers:[{id:'p',name:'p',endpoint:'https://controlled.test/v1',apikey:'test'}]};
async function point(app,selector){return app.evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(selector)}),r=p.getBoundingClientRect();return {x:r.x+r.width*(p.closest('.node-port').dataset.direction==='input'?.25:.75),y:r.y+r.height/2}})()`)}
async function drag(app,from,to){const start=await point(app,from),end=await point(app,to);for(const event of [{type:'mouseMoved',...start},{type:'mousePressed',...start,button:'left',clickCount:1},{type:'mouseMoved',x:start.x+30,y:start.y+20,button:'left',buttons:1},{type:'mouseMoved',...end,button:'left',buttons:1},{type:'mouseReleased',...end,button:'left',clickCount:1}])await app.send('Input.dispatchMouseEvent',event)}
async function graph(app){return app.evaluate("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value)")}
test('a universal input refuses an occupied prompt and preserves the exact existing edge and history', {timeout:30000},async()=>{
 const edge={id:'retained-prompt',from:{nodeId:'old',port:'text'},to:{nodeId:'target',port:'prompt'},type:'text'};
 const seeded={...session,nodes:[{id:'old',type:'Text',x:30,y:60,text:'old'},{id:'next',type:'Text',x:30,y:430,text:'new'},{id:'target',type:'ImageGenerate',x:620,y:230,apiConfigId:'image',providerId:'p'}],connections:[edge]};
 await withAppBrowser(seeded,async app=>{
  await app.waitFor("Boolean(document.getElementById('target'))");
  const input=await app.evaluate("document.querySelector('#target .node-port[data-port=auto]') ? 'auto' : 'prompt'");
  await drag(app,'#next .node-port[data-direction=output] .port-dot',`#target .node-port[data-port=${input}] .port-dot`);
  await delay(700);
  assert.deepEqual((await graph(app)).connections,[edge], 'automatic connection cannot replace an occupied prompt');
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
  await delay(100);
  assert.deepEqual((await graph(app)).connections,[edge]);
 });
});

test('preview input refuses automatic replacement and applies an explicit source replacement as one reversible edit', {timeout:30000},async()=>{
 const edge={id:'retained-preview',from:{nodeId:'old-image',port:'image'},to:{nodeId:'preview',port:'image'},type:'image'};
 await withAppBrowser({...session,nodes:[{id:'old-image',type:'ImageImport',x:30,y:50},{id:'next-image',type:'ImageImport',x:30,y:410},{id:'preview',type:'ImagePreview',x:620,y:230}],connections:[edge]},async app=>{
  await app.waitFor("Boolean(document.querySelector('#preview .universal-input'))");
  await drag(app,'#next-image .node-port[data-direction=output] .port-dot','#preview .universal-input .port-dot');
  await delay(600);
  assert.deepEqual((await graph(app)).connections,[edge]);
  await app.evaluate("document.getElementById('preview').click();document.querySelector('[data-input-connection-id=retained-preview] [data-input-action=replace]').click()");
  await app.evaluate(`(()=>{const input=document.querySelector('[data-input-replacement-source]');input.value=${JSON.stringify(JSON.stringify({nodeId:'next-image',port:'image'}))};input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-input-action=confirm-replace]').click()})()`);
  const changed={...edge,from:{nodeId:'next-image',port:'image'}};
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='next-image')");
  assert.deepEqual((await graph(app)).connections,[changed]);
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='old-image')");
  await app.waitFor("[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('已撤回上一步操作'))");
  await app.evaluate("document.getElementById('canvas-container').dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))");
  await app.waitFor("fetch('/api/storage/documents/session').then(r=>r.json()).then(r=>r.value.connections[0]?.from.nodeId==='next-image')");
  assert.deepEqual((await graph(app)).connections,[changed]);
 });
});
