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
