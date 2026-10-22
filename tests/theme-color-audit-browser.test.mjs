import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { withAppBrowser, delay } from './helpers/app-browser.mjs';
import { parseColor, composite, contrastRatio, renderComputedFixture } from './helpers/browser-theme-fixture.mjs';

const themes = ['dark', 'pro', 'paper', 'light', 'glass-light', 'glass-dark', 'pink'];
const session = { autoCheckUpdatesOnLoad: false, models: [{ id: 'chat', modelId: 'test', name: '受控对话', protocol: 'openai', taskType: 'chat', providerIds: ['p'] }], providers: [{ id: 'p', name: 'Controlled', endpoint: 'https://controlled.test/v1', apikey: 'test' }] };
test('feature colors cannot reintroduce missing palette names or leak protocol button colors', () => {
    for(const file of ['css/prompt-agent.css','css/protocol-developer-panel.css']) {
        const css=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
        assert.doesNotMatch(css,/var\(--(?:bg-primary|bg-secondary|bg-tertiary|accent-color|accent-subtle|danger-color|success-color|warning-color)[,)]/);
    }
    const protocol=readFileSync(new URL('../css/protocol-developer-panel.css',import.meta.url),'utf8');
    assert.doesNotMatch(protocol,/^\.btn-(?:primary|secondary|danger|ghost)[\s:{]/m);
    for(const theme of themes) {
        const css=readFileSync(new URL(`../css/themes/${theme}.css`,import.meta.url),'utf8');
        assert.doesNotMatch(css,/\.update-download-toast__cancel/);
    }
});
test('filled primary actions keep readable text across seven themes', () => {
    const rows=renderComputedFixture(new URL('./fixtures/primary-action-theme-surface.html',import.meta.url),'cainflow-primary-colors-');
    const failures=[];
    assert.equal(rows.length,14);
    for(const row of rows) {
        const stops=row.image.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) || [row.background];
        for(const stop of stops) {
            const ratio=contrastRatio(parseColor(row.color),parseColor(stop));
            if(ratio<4.5)failures.push(`${row.theme}: ${ratio.toFixed(2)}`);
        }
    }
    assert.deepEqual([...new Set(failures)],[]);
});
async function capture(send, name) {
    if (!process.env.CAINFLOW_QA_SCREENSHOT_DIR) return;
    await mkdir(process.env.CAINFLOW_QA_SCREENSHOT_DIR, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.CAINFLOW_QA_SCREENSHOT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

test('dynamic Agent and protocol surfaces remain readable across seven live theme switches', { timeout: 60000 }, async () => {
    await withAppBrowser(session, async ({ evaluate, send, waitFor }) => {
        const failures = [];
        await evaluate(`(async () => { window.readColors = selector => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length && !e.matches('[type=checkbox], [type=radio], :disabled')).map(e => {
            const s=getComputedStyle(e), backgrounds=[];
            for(let p=e;p;p=p.parentElement) backgrounds.push(getComputedStyle(p).backgroundColor);
            return { label:e.className || e.id, text:e.textContent.slice(0,50), color:s.color, backgrounds, image:s.backgroundImage, outline:s.outlineStyle, outlineColor:s.outlineColor };
        }); document.getElementById('btn-prompt-agent').click(); document.getElementById('prompt-agent-panel').style.width='300px';
        const {attachCanvasMentions}=await import('/js/features/prompt-agent/prompt-agent-canvas-ui.js');
        window.qaMentions=attachCanvasMentions({documentRef:document,input:document.getElementById('prompt-agent-input'),adapter:{context:()=>({nodes:[{id:'test-node',name:'参考图片',type:'ImageInput'}]})}});
        const input=document.getElementById('prompt-agent-input'); input.value='@'; input.selectionStart=1; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        const check = (rows, theme, area) => {
            for (const row of rows) {
                let bg = [255,255,255,1];
                for (const color of row.backgrounds.toReversed()) bg = composite(parseColor(color), bg);
                const ratio = contrastRatio(composite(parseColor(row.color), bg), bg);
                if (ratio < 4.5) failures.push(`${theme} ${area} ${row.label}: text contrast ${ratio.toFixed(2)}`);
            }
        };
        for (const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`); await delay(250);
            const rows = await evaluate(`readColors('.prompt-agent-node-mentions, .prompt-agent-node-mentions button')`);
            check(rows.slice(1), theme, 'mentions');
            if (parseColor(rows[0].backgrounds[0])[3] !== 1) failures.push(`${theme} mentions surface must be opaque`);
            if (rows[1].outline === 'none') failures.push(`${theme} mention selection has no visible indicator`);
            let selectedBackground=[255,255,255,1];
            for(const color of rows[1].backgrounds.toReversed()) selectedBackground=composite(parseColor(color),selectedBackground);
            assert.ok(contrastRatio(parseColor(rows[1].outlineColor),selectedBackground)>=3, `${theme} selected outline contrast`);
            await capture(send, `agent-${theme}`);
        }
        await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
        await delay(250);
        await evaluate(`qaMentions.close(); document.querySelector('#prompt-agent-model + .prompt-agent-model-trigger').click()`);
        await waitFor(`Boolean(document.querySelector('.prompt-agent-model-menu'))`);
        for(const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`);await delay(250);
            const rows=await evaluate(`readColors('.prompt-agent-model-option')`);
            assert.ok(rows.length);check(rows,theme,'model menu');
            assert.ok(await evaluate(`(()=>{const m=document.querySelector('.prompt-agent-model-menu'),r=m.getBoundingClientRect(),b=m.querySelector('button'),s=b.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(s.x+s.width/2,s.y+s.height/2));})()`));
            await capture(send, `model-narrow-${theme}`);
        }
        await send('Emulation.setDeviceMetricsOverride', { width: 1700, height: 1000, deviceScaleFactor: 1, mobile: false });
        await evaluate(`qaMentions.close(); document.getElementById('btn-settings').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})); document.getElementById('btn-open-protocol-dev').click();`);
        await waitFor(`Boolean(document.querySelector('.btn-edit-protocol'))`);
        await evaluate(`document.querySelector('.btn-edit-protocol').click()`);
        await waitFor(`Boolean(document.querySelector('.parameter-row input'))`);
        for (const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`); await delay(250);
            const rows=await evaluate(`readColors('.protocol-dev-header h2, .protocol-field input, .parameter-row input, .parameter-row textarea, .preview-key, .preview-string, .preview-number, .preview-boolean, .preview-method, .protocol-save-status')`);
            assert.ok(rows.length>5);check(rows, theme, 'protocol');
            for (const status of ['saving','dirty','success','error']) {
                await evaluate(`document.querySelector('.protocol-save-status').dataset.status='${status}'`);
                check(await evaluate(`readColors('.protocol-save-status')`),theme,`protocol ${status}`);
            }
            await capture(send, `protocol-${theme}`);
        }
        assert.deepEqual([...new Set(failures)], []);
    });
});

test('main panel text and download actions follow every theme', { timeout: 90000 }, async () => {
    await withAppBrowser(session, async ({ evaluate, send }) => {
        const failures = [];
        await evaluate(`window.panelColors = selector => [...document.querySelector(selector).querySelectorAll('*')].filter(e => {
            const r=e.getBoundingClientRect(),s=getComputedStyle(e);
            return e.children.length===0 && e.textContent.trim() && !e.closest('button:disabled, [hidden], .hidden') && r.width>0 && r.height>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && s.visibility!=='hidden' && s.opacity==='1' && !e.matches('option,svg,style,script');
        }).map(e=> { const s=getComputedStyle(e), backgrounds=[]; let gradient=false;
            for(let p=e;p;p=p.parentElement){const c=getComputedStyle(p);backgrounds.push(c.backgroundColor);gradient ||= c.backgroundImage!=='none';}
            return {label:e.id || e.className, color:s.color, backgrounds, gradient, large:parseFloat(s.fontSize)>=24 || (parseFloat(s.fontSize)>=18.66 && Number(s.fontWeight)>=700)};
        });`);
        for (const [button, panel] of [['btn-history','history-sidebar'], ['btn-toggle-workflow','workflow-sidebar'], ['btn-toggle-cache','cache-sidebar'], ['btn-toggle-statistics','statistics-sidebar'], ['btn-logs','log-drawer']]) {
            await evaluate(`document.getElementById('${button}').click()`); await delay(350);
            for (const theme of themes) {
                await evaluate(`document.documentElement.dataset.appTheme='${theme}'`); await delay(200);
                const rows = await evaluate(`panelColors('#${panel}')`);
                assert.ok(rows.length, `${panel} must render actual content`);
                for (const row of rows.filter(row => !row.gradient)) {
                    let bg=[255,255,255,1]; for(const c of row.backgrounds.toReversed()) bg=composite(parseColor(c),bg);
                    const ratio=contrastRatio(composite(parseColor(row.color),bg),bg);
                    if(ratio<(row.large?3:4.5)) failures.push(`${theme} ${panel} ${row.label}: ${ratio.toFixed(2)}`);
                }
                await capture(send, `${panel}-${theme}`);
            }
        }
        await evaluate(`const toast=document.createElement('div');toast.id='audit-download';toast.className='toast update-download-toast';toast.innerHTML='<button class="update-download-toast__cancel">取消</button>';document.getElementById('toast-container').append(toast);`);
        for(const theme of themes) {
            await evaluate(`document.documentElement.dataset.appTheme='${theme}'`);await delay(200);
            for (const state of ['normal', 'hover', 'focus']) {
                const r=await evaluate(`document.querySelector('#audit-download button').getBoundingClientRect().toJSON()`);
                await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:state==='hover'?r.x+r.width/2:1,y:state==='hover'?r.y+r.height/2:1});
                await evaluate(`document.querySelector('#audit-download button').${state==='focus'?'focus':'blur'}()`);await delay(180);
                const rows=await evaluate(`panelColors('#audit-download')`);
                assert.equal(rows.length,1);
                for(const row of rows){let bg=[255,255,255,1];for(const c of row.backgrounds.toReversed())bg=composite(parseColor(c),bg);
                    const ratio=contrastRatio(composite(parseColor(row.color),bg),bg);
                    if(ratio<4.5)failures.push(`${theme} download cancel ${state}: ${ratio.toFixed(2)}`);
                }
            }
        }
        assert.deepEqual([...new Set(failures)], []);
    });
});
