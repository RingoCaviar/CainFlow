import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser,delay} from './helpers/app-browser.mjs';
test('Agent imported references have visible connections and reach the actual image request in order',{timeout:60000},async()=>{
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[
  {id:'chat',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p'],autoCompactTokenLimit:100000},
  {id:'image',modelId:'gemini-image',protocol:'google',taskType:'image',providerIds:['p']}],providers:[{id:'p',endpoint:'https://controlled.test',apikey:'test'}]},async({evaluate,waitFor,send})=>{
  await send('Page.addScriptToEvaluateOnNewDocument', {source:`window.calls=[];window.originalFetch=fetch;window.fetch=async(url,options={})=>{
   if(String(url)==='/proxy'){
    const body=JSON.parse(options.body);calls.push(body);
    if(body.messages){const content=body.messages.at(-1).content;const input=JSON.parse(Array.isArray(content)?content.find(p=>p.type==='text').text:content);
     return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'generate',message:'方案',promptPlan:{prompt:'poster',parameters:{},imageRoles:input.images.filter(i=>i.origins.includes('本轮附件')).map((i,index)=>({imageId:i.imageId,role:'reference',purpose:index===0?'主体':'只取配色'}))}})}}]}));}
    return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:window.originals[0].split(',')[1]}}]}}]}));
   }return originalFetch(url,options);};`});
  await send('Page.reload');await delay(1000);
  await waitFor("Boolean(document.getElementById('prompt-agent-model')?.options.length)");
  await evaluate(`document.getElementById('btn-prompt-agent').click();
   for(const [id,model] of [['prompt-agent-model','chat'],['prompt-agent-image-model','image']]){document.querySelector('#'+id+' + button').click();document.querySelector('#'+id+'-menu [data-model-id="'+model+'"][data-provider-id="p"]').click();}
  `);
  await evaluate(`(async()=>{window.originals=[];const data=new DataTransfer();for(const color of ['red','blue']){const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,16,16);const url=canvas.toDataURL();originals.push(url);data.items.add(new File([await (await fetch(url)).blob()],color+'.png',{type:'image/png'}));}
   document.getElementById('prompt-agent-form').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
  await waitFor("document.querySelectorAll('#prompt-agent-references img').length===2&&!document.querySelector('#prompt-agent-references .is-loading')");
  await evaluate("document.getElementById('prompt-agent-input').value='用参考图生成2K、16:9海报';document.getElementById('prompt-agent-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await waitFor("Boolean(document.querySelector('.prompt-agent-canvas-plan'))");
  await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='仅应用').click()");
  await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('已应用并保存')");
  assert.ok(await evaluate("document.querySelector('.prompt-agent-plan-inputs').textContent.includes('2 项')"));
  assert.ok(await evaluate("document.querySelector('#nodes-layer [data-direction=input][data-port=referenceImages]')!==null"));
  await delay(200);
  assert.ok(await evaluate("[...document.querySelectorAll('#connections-svg path')].filter(p=>p.getAttribute('d')?.includes('M')).length>=3"),'both reference edges and save edge must be drawn');
  await evaluate("[...document.querySelectorAll('.prompt-agent-canvas-actions button')].find(b=>b.textContent==='应用并执行').click()");
  await waitFor("document.querySelector('.prompt-agent-canvas-plan [role=status]').textContent.includes('执行结束')");
  const used=await evaluate("calls.find(c=>c.contents).contents.flatMap(c=>c.parts).filter(p=>p.inlineData).map(p=>p.inlineData.data)");
  assert.deepEqual(used,await evaluate("originals.map(u=>u.split(',')[1])"));
  assert.match(await evaluate("calls.find(c=>c.contents).contents.flatMap(c=>c.parts).find(p=>p.text)?.text"),/输入图片顺序：图1·参考（主体）；图2·参考（只取配色）。/);
  assert.equal(await evaluate("calls.find(c=>c.contents).generationConfig.imageConfig.aspectRatio"),'16:9');
  assert.equal(await evaluate("calls.find(c=>c.contents).generationConfig.imageConfig.imageSize"),'2K');
 });
});
