import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser,delay,reloadAppBrowser} from './helpers/app-browser.mjs';
test('Agent remembers a non-first chat model and image model after application reconstruction',{timeout:60000},async()=>{
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models:['first','second','image'].map(id=>({id,modelId:id,name:id,taskType:id==='image'?'image':'chat',protocol:'google',providerIds:['p']})),providers:[{id:'p',name:'Provider',endpoint:'https://controlled.test',apikey:'test'}]},async({evaluate,send,waitFor})=>{
 await evaluate(`document.getElementById('btn-prompt-agent').click();for(const [id,model] of [['prompt-agent-model','second'],['prompt-agent-image-model','image']]){document.querySelector('#'+id+' + button').click();document.querySelector('#'+id+'-menu [data-model-id="'+model+'"][data-provider-id="p"]').click();}`);
 await delay(2000);await evaluate("localStorage.removeItem('cainflow_prompt_agent_model')");await reloadAppBrowser({evaluate,send,waitFor});
 assert.equal(await evaluate("document.getElementById('prompt-agent-model').value"),'second');
 assert.equal(await evaluate("document.getElementById('prompt-agent-image-model').value"),'image');
 });
});
