import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser} from './helpers/app-browser.mjs';
test('camera slider endpoints and values fit inside the editor across themes', async()=>{
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',endpoint:'https://example.test',apikey:'test'}],nodes:[{id:'camera',type:'CameraControl',x:50,y:100}],connections:[]},async app=>{
 await app.evaluate("document.getElementById('camera-camera-open').click()");
 await app.waitFor("document.querySelectorAll('[data-camera-slider]').length===5");
 for(const width of [1086,768,480]) {
 await app.send('Emulation.setDeviceMetricsOverride',{width,height:868,deviceScaleFactor:1,mobile:false});
 for(const theme of ['paper','light','dark','pro','pink','glass-light','glass-dark']) {
 const errors=await app.evaluate(`(()=>{document.documentElement.dataset.appTheme=${JSON.stringify(theme)};const errors=[];for(const range of document.querySelectorAll('[data-camera-slider]')){for(const end of ['min','max']){range.value=range[end];range.dispatchEvent(new Event('input',{bubbles:true}));range.scrollIntoView({block:'nearest'});const r=range.getBoundingClientRect();for(let p=range.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['auto','hidden','scroll','clip'].includes(s.overflowX)&&(r.left-2<b.left||r.right+2>b.right))errors.push(range.dataset.cameraSlider+' '+end+' clipped horizontally');}const value=document.querySelector('[data-camera-value='+range.dataset.cameraSlider+']');if(Number(value.value)!==Number(range.value))errors.push('value not synchronized');}}return errors})()`);
 assert.deepEqual(errors,[],theme+' '+width);
 }
 }
 });
});
