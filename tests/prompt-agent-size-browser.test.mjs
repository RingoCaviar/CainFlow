import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
const providers=[{id:'p',name:'受控供应商',endpoint:'https://controlled.test/v1',apikey:'test-key'}];
const models=[{id:'chat',name:'对话',modelId:'chat',taskType:'chat',protocol:'openai',providerIds:['p']},
 {id:'image',name:'生图',modelId:'gpt-image-1',taskType:'image',protocol:'openai-image',providerIds:['p']}];
test('image size options open on a real pointer click and remain selectable inside the parent settings', {timeout:30000}, async()=>{
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models,providers},async({evaluate,send,waitFor})=>{
  const click=async selector=>{
   const point=await evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
   await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
   await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  await evaluate("document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-image-model + button').click();document.querySelector('#prompt-agent-image-model-menu [data-model-id=image][data-provider-id=p]').click()");
  await click('#prompt-agent-image-model + button + .thinking-control > summary');
  await waitFor("!!document.querySelector('.prompt-agent-thinking-menu')");
  assert.equal(await evaluate("!!document.querySelector('.prompt-agent-size-settings > strong')"),false);
  await click('#prompt-agent-size-resolution + button');
  assert.deepEqual(await evaluate(`(()=>{const parent=document.querySelector('.prompt-agent-thinking-menu'),child=document.getElementById('prompt-agent-size-resolution-menu');return {parentOpen:!!parent,childOpen:!!child,searchFocused:child?.querySelector('input')===document.activeElement,divider:child&&getComputedStyle(child.querySelectorAll('.prompt-agent-model-option')[1]).borderTopStyle}})()`),
   {parentOpen:true,childOpen:true,searchFocused:true,divider:'solid'});
  await click('#prompt-agent-size-resolution-menu [data-model-id="2K"]');
  assert.equal(await evaluate("document.getElementById('prompt-agent-size-resolution').value"),'2K');
  assert.equal(await evaluate("!!document.querySelector('.prompt-agent-thinking-menu')"),true);
  await click('#prompt-agent-size-aspectRatio + button');
  assert.deepEqual(await evaluate(`(()=>{const menu=document.getElementById('prompt-agent-size-aspectRatio-menu');return {
   parentOpen:!!document.querySelector('.prompt-agent-thinking-menu'),childOpen:!!menu,
   searchFocused:menu?.querySelector('input')===document.activeElement,
   divider:menu&&getComputedStyle(menu.querySelectorAll('.prompt-agent-model-option')[1]).borderTopStyle
  }})()`),{parentOpen:true,childOpen:true,searchFocused:true,divider:'solid'});
  await click('#prompt-agent-size-aspectRatio-menu [data-model-id="16:9"]');
  assert.equal(await evaluate("document.getElementById('prompt-agent-size-aspectRatio').value"),'16:9');
 });
});
test('Agent asks for resolution without creating nodes, retains ratio, executes confirmed size and restores preferences', {timeout:90000}, async()=>{
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models,providers},async({evaluate,send,waitFor})=>{
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.calls=[];const real=fetch;window.fetch=async(url,options={})=>{
   if(String(url)==='/proxy'&&options.body){const body=JSON.parse(options.body);calls.push(body);
    if(body.messages)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'横幅方案',promptPlan:{prompt:'poster',parameters:{aspect:'16:9'}}})}}]}));
    return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='}]}));
   }return real(url,options);};`});
  await send('Page.reload');await delay(1000);await waitFor('window.__cainflowAppReady===true');await waitFor("Boolean(document.querySelector('#prompt-agent-model + button'))");
  await evaluate("document.getElementById('btn-prompt-agent').click()");
  for(const [id,model] of [['prompt-agent-model','chat'],['prompt-agent-image-model','image']]){
   await evaluate(`document.querySelector('#${id} + button').click();document.querySelector('#${id}-menu [data-model-id="${model}"][data-provider-id="p"]').click()`);
  }
  await evaluate("window.chatSettings=document.querySelector('#prompt-agent-model').parentElement.querySelector('.thinking-control > summary');window.chatSettings.click()");
  assert.equal(await evaluate("!!document.querySelector('.prompt-agent-thinking-menu .prompt-agent-size-settings')"),false);
  await evaluate("window.chatSettings.click();window.imageSettings=document.querySelector('#prompt-agent-image-model').parentElement.querySelector('.thinking-control > summary');window.imageSettings.click()");
  assert.equal(await evaluate("!!document.getElementById('prompt-agent-size-button')"),false);
  assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-size-settings').length"),1);
  assert.match(await evaluate("window.imageSettings.getAttribute('aria-label')"),/生图模型生成尺寸设置/);
  assert.equal(await evaluate("document.getElementById('prompt-agent-size-resolution').value"),'__inherit__');
  await evaluate("document.querySelector('#prompt-agent-size-resolution + button').click()");
  assert.equal(await evaluate("document.querySelector('#prompt-agent-size-resolution-menu .prompt-agent-model-search').placeholder"),'搜索分辨率');
  await evaluate("document.querySelector('#prompt-agent-size-resolution + button').click()");
  await evaluate("document.querySelector('#prompt-agent-size-aspectRatio + button').click()");
  assert.equal(await evaluate("document.querySelector('#prompt-agent-size-aspectRatio-menu .prompt-agent-model-search').placeholder"),'搜索画面比例');
  await evaluate("document.querySelector('#prompt-agent-size-aspectRatio + button').click()");
  for(const theme of ['dark','pro','paper','light','glass-light','glass-dark','pink']){
   await evaluate(`document.documentElement.dataset.appTheme='${theme}';document.getElementById('prompt-agent-panel').style.width='300px';window.imageSettings.click();window.imageSettings.click()`);
   if(process.env.CAINFLOW_QA_SCREENSHOT_DIR){await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`size-panel-${theme}.png`),Buffer.from(shot.data,'base64'));}
   await evaluate("document.querySelector('#prompt-agent-size-resolution + button').click()");
   if(process.env.CAINFLOW_QA_SCREENSHOT_DIR){await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR,{recursive:true});const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR,`size-${theme}.png`),Buffer.from(shot.data,'base64'));}
   assert.ok(await evaluate(`(()=>{const m=document.getElementById('prompt-agent-size-resolution-menu'),r=m.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(m).backgroundColor!=='rgba(0, 0, 0, 0)'})()`));
   await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
   assert.equal(await evaluate("!!document.querySelector('.prompt-agent-thinking-menu')"),true);
  }
  await evaluate("var r=document.getElementById('prompt-agent-size-resolution');r.value='';r.dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await evaluate("document.getElementById('prompt-agent-size-aspectRatio').disabled"),true);
  assert.match(await evaluate("document.querySelector('.prompt-agent-size-aspect-hint').textContent"),/自动分辨率/);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.prompt-agent-thinking-menu .prompt-agent-settings-footer')).display"),'none');
  await evaluate("window.imageSettings.click();document.getElementById('prompt-agent-input').value='生成16:9横幅';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await waitFor("document.querySelector('.prompt-agent-size-clarification')?.textContent.includes('请选择需要的分辨率')");
  assert.equal(await evaluate("document.querySelectorAll('#nodes-layer .node').length"),0);
  assert.equal(await evaluate('calls.length'),1);
  assert.ok(await evaluate("JSON.stringify(calls[0]).includes('imageSizeCapabilities')"));
  assert.ok(await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').disabled"));
  // Text answers update the same persisted draft, without another model request or execution.
  await evaluate("document.getElementById('prompt-agent-input').value='用2K';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  assert.equal(await evaluate('calls.length'),1);
  assert.equal(await evaluate("document.querySelectorAll('.prompt-agent-canvas-plan').length"),1);
  assert.ok(await evaluate("document.querySelector('.prompt-agent-size-summary').textContent.includes('16:9')"));
  await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
  await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
  assert.equal(await evaluate('calls.length'),2);
  assert.equal(await evaluate('calls[1].size'),'2048x1152');
  assert.equal(await evaluate("document.querySelector('#nodes-layer select[id$=resolution]').value"),'2K');
  assert.equal(await evaluate("document.querySelector('#nodes-layer select[id$=aspect]').value"),'16:9');
  await evaluate("window.imageSettings.click();var r=document.getElementById('prompt-agent-size-resolution');r.value='4K';r.dispatchEvent(new Event('change',{bubbles:true}));window.imageSettings.click()");
  assert.match(await evaluate("window.imageSettings.title"),/4K/);
  await delay(800);await send('Page.reload');await delay(1000);await waitFor('window.__cainflowAppReady===true');await waitFor("Boolean(document.querySelector('#prompt-agent-model + button'))");
  await evaluate("document.getElementById('btn-prompt-agent').click();document.querySelector('#prompt-agent-image-model').parentElement.querySelector('.thinking-control > summary').click()");
  assert.equal(await evaluate("document.getElementById('prompt-agent-size-resolution').value"),'4K');
  assert.ok(await evaluate("document.querySelector('.prompt-agent-size-summary').textContent.includes('2K')"),'completed plan retains executed size');
  await evaluate("var r=document.getElementById('prompt-agent-size-resolution');r.value='custom';r.dispatchEvent(new Event('change',{bubbles:true}))");
  assert.deepEqual(await evaluate(`(()=>{const row=document.querySelector('.prompt-agent-thinking-menu .prompt-agent-size-dimensions');return {
   visible:getComputedStyle(row).display!=='none',divider:getComputedStyle(row).borderTopStyle,
   aspectHint:document.querySelector('.prompt-agent-thinking-menu .prompt-agent-size-aspect-hint').textContent
  }})()`),{visible:true,divider:'solid',aspectHint:'由宽高决定'});
 });
});
