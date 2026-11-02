import assert from 'node:assert/strict';
import test from 'node:test';
import { withAppBrowser } from './helpers/app-browser.mjs';
test('initial Agent model selection includes its bound provider', async () => {
 await withAppBrowser({autoCheckUpdatesOnLoad:false,models:[{id:'chat',modelId:'chat',protocol:'openai',taskType:'chat',providerIds:['p']}],providers:[{id:'p',name:'Test provider',endpoint:'https://example.test',apikey:'test'}],nodes:[],connections:[]}, async app => {
  const label = await app.evaluate("document.getElementById('prompt-agent-model').nextElementSibling.textContent");
  assert.match(label, /Test provider/);
 });
});
