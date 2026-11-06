import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = {
    autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] },
        { id: 'image', modelId: 'gpt-image-1', name: '受控图片', protocol: 'openai', taskType: 'image', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'first', type: 'ImageGenerate', x: 80, y: 40, width: 420, height: 360, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'first draft' },
        { id: 'second', type: 'ImageGenerate', x: 600, y: 40, width: 420, height: 360, userResized: true, apiConfigId: 'image', providerId: 'p', prompt: 'second draft' }],
    connections: []
};
async function open(app, id = 'first') {
    await app.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await app.waitFor(`!document.getElementById('image-parameter-panel').hidden && document.getElementById('image-parameter-panel').dataset.nodeId===${JSON.stringify(id)}`);
}
test('parameter editor has no removed title tools and keeps footer controls accessible in narrow windows', { timeout: 30000 }, async () => {
    await withAppBrowser(session, async app => {
        for(const width of [1100,360]) {
            await app.send('Emulation.setDeviceMetricsOverride',{width,height:540,deviceScaleFactor:1,mobile:false});
            await open(app);
            await app.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            assert.ok(await app.evaluate("[...document.querySelectorAll('#image-parameter-panel .image-parameter-header button')].every(button=>!button.checkVisibility())"));
            assert.ok(await app.evaluate("(()=>{const p=document.getElementById('image-parameter-panel').getBoundingClientRect(),g=document.querySelector('#image-parameter-panel [data-parameter-action=generate]').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&g.top>=p.top&&g.bottom<=p.bottom})()"));
        }
    });
});
