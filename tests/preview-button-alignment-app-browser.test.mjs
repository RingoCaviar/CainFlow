import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAppBrowser } from './helpers/app-browser.mjs';

const session = { autoCheckUpdatesOnLoad: false,
    models: [{ id: 'chat', modelId: 'chat', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }],
    providers: [{ id: 'p', endpoint: 'https://controlled.test/v1', apikey: 'test' }],
    nodes: [{ id: 'source', type: 'ImageImport', x: 30, y: 80 }, { id: 'generate', type: 'ImageGenerate', x: 430, y: 80, width: 320 }], connections: [] };

const alignment = selector => `(()=>{const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');return [...document.querySelectorAll(${JSON.stringify(selector)})].filter(b=>b.checkVisibility()).map(b=>{const box=b.getBoundingClientRect(),svg=b.querySelector('svg');let x,y;if(svg){const r=svg.getBoundingClientRect();x=(r.left+r.right)/2;y=(r.top+r.bottom)/2;}else{const range=document.createRange();range.selectNodeContents(b);const r=range.getBoundingClientRect();ctx.font=getComputedStyle(b).font;const m=ctx.measureText(b.textContent.trim());x=(r.left+r.right)/2;y=r.top+m.fontBoundingBoxAscent-(m.actualBoundingBoxAscent-m.actualBoundingBoxDescent)/2;}return {label:b.getAttribute('aria-label')||b.title||b.textContent.trim(),x:x-(box.left+box.right)/2,y:y-(box.top+box.bottom)/2}})})()`;

test('preview zoom controls center their visible glyphs and preserve zoom/fit actions', async () => {
    await withAppBrowser(session, async app => {
        await app.evaluate(`(async()=>{const file=new File([await(await fetch('/tests/fixtures/reference-red.png')).blob()],'reference.png',{type:'image/png'}),transfer=new DataTransfer();transfer.items.add(file);const input=document.getElementById('source-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await app.waitFor("!!document.querySelector('#source-drop img')");
        await app.evaluate("document.querySelector('#source-drop img').dispatchEvent(new MouseEvent('click',{bubbles:true,button:0,detail:2}))");
        await app.waitFor("!!document.querySelector('.fullscreen-overlay img')");
        const controls = await app.evaluate(alignment('.fullscreen-overlay .preview-zoom-controls button'));
        assert.equal(controls.length, 3);
        for (const control of controls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        const before = await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img').style.transform");
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-zoom-in').click()");
        assert.notEqual(await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img').style.transform"), before);
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-zoom-fit').click()");
        assert.equal(await app.evaluate("new DOMMatrix(getComputedStyle(document.querySelector('.fullscreen-overlay .fullscreen-img-wrapper img')).transform).isIdentity"), true);
        if (process.env.CAINFLOW_QA_SCREENSHOT_DIR) {
            await app.waitFor("getComputedStyle(document.querySelector('.fullscreen-overlay')).opacity==='1'");
            const clip = await app.evaluate("(()=>{const r=document.querySelector('.fullscreen-overlay .preview-zoom-controls').getBoundingClientRect();return {x:r.x-4,y:r.y-4,width:r.width+8,height:r.height+8,scale:2}})()");
            const shot = await app.send('Page.captureScreenshot', { format: 'png', clip });
            await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
            await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, 'preview-buttons.png'), Buffer.from(shot.data, 'base64'));
        }
        await app.evaluate("document.querySelector('.fullscreen-overlay .preview-action-reveal').click()");
        for (const control of await app.evaluate(alignment('.fullscreen-overlay .preview-action-dock :is(button,.fullscreen-close,.fullscreen-paint-btn)'))) {
            assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        }
        await app.evaluate("document.querySelector('.fullscreen-overlay .fullscreen-close').click();document.getElementById('generate').click()");
        const otherControls = await app.evaluate(alignment('.generation-count-btn, #canvas-navigation [data-nav=minus], #canvas-navigation [data-nav=plus], .image-parameter-tools button'));
        assert.ok(otherControls.length >= 6);
        for (const control of otherControls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, JSON.stringify(control));
        await app.evaluate("document.getElementById('history-preview-modal').classList.remove('hidden');document.querySelector('#history-preview-modal .preview-action-dock').classList.add('is-expanded')");
        for (const theme of ['light', 'dark', 'pink', 'pro', 'paper', 'glass-light', 'glass-dark']) {
            await app.evaluate(`document.documentElement.dataset.appTheme=${JSON.stringify(theme)}`);
            const historyControls = await app.evaluate(alignment('#history-preview-modal .preview-zoom-controls button, #history-preview-modal .preview-action-dock button'));
            assert.ok(historyControls.length >= 7);
            for (const control of historyControls) assert.ok(Math.abs(control.x) <= 1 && Math.abs(control.y) <= 1, `${theme}: ${JSON.stringify(control)}`);
        }
    });
});
