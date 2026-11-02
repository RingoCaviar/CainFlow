import test from 'node:test';
import assert from 'node:assert/strict';
import {withAppBrowser,delay} from './helpers/app-browser.mjs';
test('camera WebGL background updates for all themes without reopening',async()=>{
await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',endpoint:'https://example.test',apikey:'test'}],nodes:[{id:'camera',type:'CameraControl',x:50,y:100}],connections:[]},async app=>{
await app.evaluate("document.getElementById('camera-camera-open').click()");await app.waitFor("document.querySelector('.camera-control-stage canvas')");
for(const theme of ['paper','light','dark','pro','pink','glass-light','glass-dark']){
await app.evaluate(`document.documentElement.dataset.appTheme='${theme}'`);await delay(150);
const shot=await app.send('Page.captureScreenshot',{format:'png'});
const result=await app.evaluate(`(async()=>{const stage=document.querySelector('.camera-control-stage'),source=stage.querySelector('canvas'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');const image=new Image();image.src='data:image/png;base64,${shot.data}';await image.decode();const rect=source.getBoundingClientRect();ctx.drawImage(image,Math.round(rect.left+4),Math.round(rect.top+4),1,1,0,0,1,1);const actual=[...ctx.getImageData(0,0,1,1).data];ctx.fillStyle=getComputedStyle(stage).backgroundColor;ctx.fillRect(0,0,1,1);return {actual,expected:[...ctx.getImageData(0,0,1,1).data]}})()`);
assert.ok(result.actual.every((v,i)=>Math.abs(v-result.expected[i])<=2),theme+JSON.stringify(result));
}
});});
